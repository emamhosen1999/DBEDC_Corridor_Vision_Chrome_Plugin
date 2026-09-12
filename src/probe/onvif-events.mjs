/**
 * ONVIF event pull-point — the camera's own analytics.
 *
 * Everything else in the probe ladder is an outside-in measurement: we look at the
 * camera and judge it. This layer asks the camera what *it* thinks is wrong. Cameras
 * run tamper detection, scene-change detection and too-dark/too-bright analytics on
 * board, and those fire on evidence we cannot see from outside — someone turning the
 * housing, spraying the dome, or masking the lens between our snapshot samples.
 *
 * Deliberately OPT-IN per camera (`onvifEvents: true` in the inventory).
 *
 * The cost is the reason: a pull-point is a stateful subscription, and this
 * implementation creates one, pulls once, and unsubscribes on every cycle — three SOAP
 * round trips per camera per cycle. That is the right trade for a handful of
 * high-value cameras and completely the wrong trade for five hundred. Holding
 * long-lived subscriptions would be cheaper but would need renewal tracking and
 * recovery across restarts, which is a lot of state to carry for an optional signal.
 * If you need this fleet-wide, that is the change to make — and it should be a
 * deliberate one.
 */
import { digestFetch } from './digest.mjs';
import { pick, pickAll } from './onvif.mjs';

const ENV = (body, extraNs = '') => '<?xml version="1.0" encoding="UTF-8"?>'
  + '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
  + ' xmlns:wsa="http://www.w3.org/2005/08/addressing"'
  + ' xmlns:tev="http://www.onvif.org/ver10/events/wsdl"'
  + ' xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"'
  + `${extraNs}>`
  + `<s:Body>${body}</s:Body></s:Envelope>`;

async function soap(url, body, { username, password, timeoutMs, action, subscriptionRef }) {
  // A pull-point address is addressed with WS-Addressing, not just the URL.
  const header = subscriptionRef
    ? `<s:Header><wsa:To s:mustUnderstand="1">${subscriptionRef}</wsa:To>`
      + `<wsa:Action s:mustUnderstand="1">${action}</wsa:Action></s:Header>`
    : '';
  const envelope = ENV(body).replace('<s:Body>', `${header}<s:Body>`);
  const res = await digestFetch(url, {
    username, password, method: 'POST', timeoutMs,
    headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"` },
    body: envelope,
  });
  return { status: res.status, text: await res.text() };
}

/**
 * Topics we act on. ONVIF topic strings vary by vendor, so these are matched loosely
 * against the topic path rather than compared exactly — a strict match would silently
 * miss events on half the fleet.
 */
const TOPIC_RULES = [
  { re: /tamper|TamperDetect/i, kind: 'tamper', detail: 'the camera reported tampering' },
  { re: /SceneChange|GlobalSceneChange/i, kind: 'tamper', detail: 'the camera reported a global scene change (it may have been moved or masked)' },
  { re: /ImageTooDark|TooDark/i, kind: 'too-dark', detail: 'the camera reported the image is too dark' },
  { re: /ImageTooBright|TooBright/i, kind: 'too-bright', detail: 'the camera reported the image is too bright' },
  { re: /ImageTooBlurry|TooBlurry|Defocus/i, kind: 'defocus', detail: 'the camera reported the image is out of focus' },
  { re: /SignalLoss|VideoLoss/i, kind: 'signal-loss', detail: 'the camera reported video signal loss' },
];

/** Is the event asserting a state, or clearing one? */
function isActive(messageXml) {
  // SimpleItem Name="State" Value="true" is the ONVIF convention for a state event.
  const m = /<(?:\w+:)?SimpleItem\b[^>]*\bName="(?:State|IsMotion|IsTamper|Value)"[^>]*\bValue="([^"]+)"/i.exec(messageXml);
  if (m) return /^(true|1)$/i.test(m[1]);
  // Property operation "Initialized"/"Changed" with no state item: treat as active.
  return !/PropertyOperation="Deleted"/i.test(messageXml);
}

/**
 * Create a pull-point, pull whatever is waiting, and tear it down.
 * Returns `{ ok, events: [{ kind, topic, active, detail }] }`.
 */
export async function pullOnvifEvents(host, {
  port = 80, path = '/onvif/events_service', username, password, timeoutMs = 5000, limit = 20,
} = {}) {
  const url = `http://${host}:${port}${path}`;
  try {
    const created = await soap(
      url,
      '<tev:CreatePullPointSubscription>'
      + '<tev:InitialTerminationTime>PT60S</tev:InitialTerminationTime>'
      + '</tev:CreatePullPointSubscription>',
      { username, password, timeoutMs, action: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest' },
    );
    if (!/CreatePullPointSubscriptionResponse/i.test(created.text)) {
      return { ok: false, reason: created.status === 401 ? 'auth' : 'unsupported', events: [] };
    }

    // The subscription lives at its own address, which may differ from the service URL.
    const ref = pick(created.text, 'Address') ?? url;

    const pulled = await soap(
      ref,
      `<tev:PullMessages><tev:Timeout>PT1S</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages>`,
      { username, password, timeoutMs, action: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest', subscriptionRef: ref },
    );

    // Best-effort teardown: a leaked subscription expires on its own in 60s, so a
    // failure here costs nothing but is still worth attempting.
    soap(ref, '<wsnt:Unsubscribe/>', {
      username, password, timeoutMs: 2000,
      action: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest',
      subscriptionRef: ref,
    }).catch(() => {});

    const messages = pickAll(pulled.text, 'NotificationMessage');
    const events = [];
    for (const msg of messages) {
      const topic = pick(msg, 'Topic') ?? '';
      const rule = TOPIC_RULES.find((r) => r.re.test(topic));
      if (!rule) continue;
      events.push({ kind: rule.kind, topic: topic.trim(), active: isActive(msg), detail: rule.detail });
    }
    return { ok: true, events, subscription: ref };
  } catch (err) {
    return { ok: false, reason: 'error', detail: String(err?.message ?? err), events: [] };
  }
}

export const _internals = { TOPIC_RULES, isActive };
