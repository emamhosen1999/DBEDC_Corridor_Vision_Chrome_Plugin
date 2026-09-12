/**
 * Layer 2 — ONVIF.
 *
 * The key insight: `GetSystemDateAndTime` is defined by the ONVIF Core spec as an
 * **unauthenticated** operation. Every conformant camera answers it without
 * credentials. That makes it the single best liveness probe available:
 *
 *   - it proves the camera's web service stack is running, not merely that a TCP
 *     port is listening (a half-crashed camera will accept a connection and never
 *     respond to a request);
 *   - it needs no password, so it keeps working after a credential rotation;
 *   - the returned clock exposes **time drift**, which silently ruins video forensics
 *     and is invisible to AIV-MP's binary online/offline flag.
 *
 * SOAP is hand-rolled. Pulling in a full ONVIF client would add a dependency tree to
 * a service that must keep running untouched for years, to send four XML documents.
 */
import { digestFetch, parseChallenge, buildDigestHeader } from './digest.mjs';
import crypto from 'node:crypto';

const ENV_OPEN = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
  + ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl"'
  + ' xmlns:trt="http://www.onvif.org/ver10/media/wsdl"'
  + ' xmlns:tt="http://www.onvif.org/ver10/schema">';
const ENV_CLOSE = '</s:Envelope>';

/**
 * WS-Security UsernameToken with a password digest:
 *   Digest = Base64( SHA1( nonce + created + password ) )
 * This is what authenticated ONVIF calls expect — the password never crosses the
 * wire in the clear even on plain HTTP.
 */
function wsseHeader(username, password) {
  if (!username) return '';
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto.createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password ?? '', 'utf8')]))
    .digest('base64');
  return '<s:Header><Security s:mustUnderstand="1"'
    + ' xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
    + '<UsernameToken>'
    + `<Username>${xmlEscape(username)}</Username>`
    + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
    + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
    + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
    + '</UsernameToken></Security></s:Header>';
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** Pull the text of the first matching element, namespace-prefix agnostic. */
export function pick(xml, tag) {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return m ? m[1].trim() : null;
}

/** Pull every match of a repeated element. */
export function pickAll(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

async function soap(url, bodyXml, { username, password, timeoutMs = 3000, action } = {}) {
  const envelope = ENV_OPEN + wsseHeader(username, password) + `<s:Body>${bodyXml}</s:Body>` + ENV_CLOSE;
  const res = await digestFetch(url, {
    username, password, method: 'POST', timeoutMs,
    headers: {
      'Content-Type': action
        ? `application/soap+xml; charset=utf-8; action="${action}"`
        : 'application/soap+xml; charset=utf-8',
    },
    body: envelope,
  });
  const text = await res.text();
  return { status: res.status, text };
}

const deviceUrl = (host, port, path) => `http://${host}:${port}${path}`;

/**
 * The primary ONVIF liveness probe. No credentials required.
 * Returns clock drift in seconds when the camera reports a UTC time.
 */
export async function onvifAlive(host, { port = 80, path = '/onvif/device_service', timeoutMs = 3000 } = {}) {
  const started = Date.now();
  try {
    const { status, text } = await soap(
      deviceUrl(host, port, path),
      '<tds:GetSystemDateAndTime/>',
      { timeoutMs, action: 'http://www.onvif.org/ver10/device/wsdl/GetSystemDateAndTime' },
    );
    const latencyMs = Date.now() - started;

    // A SOAP fault still proves the service stack is alive and parsing XML.
    if (/Fault/i.test(text) && !/GetSystemDateAndTimeResponse/i.test(text)) {
      return { ok: true, respondingButFaulted: true, latencyMs, fault: pick(text, 'Text') ?? pick(text, 'faultstring'), status };
    }
    if (!/GetSystemDateAndTimeResponse/i.test(text)) {
      return { ok: false, reason: status >= 400 ? `http-${status}` : 'not-onvif', latencyMs, status };
    }

    // UTCDateTime carries nested Time{Hour,Minute,Second} and Date{Year,Month,Day}.
    const utcBlock = /<(?:\w+:)?UTCDateTime\b[^>]*>([\s\S]*?)<\/(?:\w+:)?UTCDateTime>/i.exec(text)?.[1] ?? '';
    const num = (tag) => { const v = pick(utcBlock, tag); return v === null ? null : Number(v); };
    let driftSec = null;
    let cameraTime = null;
    const y = num('Year'); const mo = num('Month'); const d = num('Day');
    const h = num('Hour'); const mi = num('Minute'); const se = num('Second');
    if ([y, mo, d, h, mi, se].every((v) => Number.isFinite(v))) {
      cameraTime = Date.UTC(y, mo - 1, d, h, mi, se);
      driftSec = Math.round((cameraTime - Date.now()) / 1000);
    }
    return {
      ok: true, latencyMs, status,
      cameraTime, driftSec,
      dateTimeType: pick(text, 'DateTimeType'),
      daylightSavings: pick(text, 'DaylightSavings') === 'true',
      timezone: pick(text, 'TZ'),
    };
  } catch (err) {
    const msg = String(err?.message ?? err);
    return {
      ok: false,
      latencyMs: Date.now() - started,
      reason: /TIMEOUT|abort/i.test(msg) ? 'timeout' : 'error',
      detail: msg,
    };
  }
}

/** Authenticated device identity — model, firmware, serial. Enriches the inventory. */
export async function onvifDeviceInfo(host, { port = 80, path = '/onvif/device_service', username, password, timeoutMs = 4000 } = {}) {
  try {
    const { text } = await soap(deviceUrl(host, port, path), '<tds:GetDeviceInformation/>', {
      username, password, timeoutMs,
      action: 'http://www.onvif.org/ver10/device/wsdl/GetDeviceInformation',
    });
    if (!/GetDeviceInformationResponse/i.test(text)) {
      return { ok: false, reason: /NotAuthorized|Unauthorized|Sender/i.test(text) ? 'auth' : 'unsupported' };
    }
    return {
      ok: true,
      manufacturer: pick(text, 'Manufacturer'),
      model: pick(text, 'Model'),
      firmware: pick(text, 'FirmwareVersion'),
      serial: pick(text, 'SerialNumber'),
      hardwareId: pick(text, 'HardwareId'),
    };
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err?.message ?? err) };
  }
}

/** Ask the camera where its snapshot lives, rather than guessing vendor URL shapes. */
export async function onvifSnapshotUri(host, { port = 80, path = '/onvif/device_service', username, password, timeoutMs = 4000, profileToken } = {}) {
  try {
    const mediaUrl = deviceUrl(host, port, '/onvif/media_service');
    let token = profileToken;
    if (!token) {
      const { text } = await soap(mediaUrl, '<trt:GetProfiles/>', {
        username, password, timeoutMs, action: 'http://www.onvif.org/ver10/media/wsdl/GetProfiles',
      });
      token = /<(?:\w+:)?Profiles\b[^>]*\btoken="([^"]+)"/i.exec(text)?.[1] ?? null;
      if (!token) return { ok: false, reason: 'no-profile' };
    }
    const { text } = await soap(mediaUrl, `<trt:GetSnapshotUri><trt:ProfileToken>${xmlEscape(token)}</trt:ProfileToken></trt:GetSnapshotUri>`, {
      username, password, timeoutMs, action: 'http://www.onvif.org/ver10/media/wsdl/GetSnapshotUri',
    });
    const uri = pick(text, 'Uri');
    return uri ? { ok: true, uri, profileToken: token } : { ok: false, reason: 'no-uri' };
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err?.message ?? err) };
  }
}

/** Ask the camera for its own RTSP URL — more reliable than guessing stream paths. */
export async function onvifStreamUri(host, { port = 80, username, password, timeoutMs = 4000, profileToken } = {}) {
  try {
    const mediaUrl = deviceUrl(host, port, '/onvif/media_service');
    let token = profileToken;
    if (!token) {
      const { text } = await soap(mediaUrl, '<trt:GetProfiles/>', {
        username, password, timeoutMs, action: 'http://www.onvif.org/ver10/media/wsdl/GetProfiles',
      });
      token = /<(?:\w+:)?Profiles\b[^>]*\btoken="([^"]+)"/i.exec(text)?.[1] ?? null;
      if (!token) return { ok: false, reason: 'no-profile' };
    }
    const body = '<trt:GetStreamUri>'
      + '<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
      + '<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>'
      + `<trt:ProfileToken>${xmlEscape(token)}</trt:ProfileToken></trt:GetStreamUri>`;
    const { text } = await soap(mediaUrl, body, {
      username, password, timeoutMs, action: 'http://www.onvif.org/ver10/media/wsdl/GetStreamUri',
    });
    const uri = pick(text, 'Uri');
    return uri ? { ok: true, uri, profileToken: token } : { ok: false, reason: 'no-uri' };
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err?.message ?? err) };
  }
}

export const _internals = { wsseHeader, soap, parseChallenge, buildDigestHeader };
