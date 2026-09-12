/**
 * HTTP Digest / Basic authentication client.
 *
 * Every IP-camera vendor CGI (Uniview, Hikvision ISAPI, Dahua) speaks RFC 2617
 * Digest, which `fetch` does not implement. This is a small, correct implementation:
 * issue the request, and on a 401 carrying `WWW-Authenticate: Digest`, compute the
 * response and retry once.
 *
 * Supports qop=auth, algorithm MD5 and MD5-sess, SHA-256 variants (RFC 7616), and
 * falls back to Basic when the camera asks for it.
 */
import crypto from 'node:crypto';

const hash = (alg, s) => crypto.createHash(alg === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex');

/** Parse a `WWW-Authenticate` header into `{ scheme, params }`. */
export function parseChallenge(header) {
  if (!header) return null;
  const scheme = /^\s*(\w+)/.exec(header)?.[1] ?? '';
  const params = {};
  // Matches key="quoted value" or key=token, tolerating the spacing vendors emit.
  const re = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header))) params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return { scheme: scheme.toLowerCase(), params };
}

/** Build the `Authorization` header value for a Digest challenge. */
export function buildDigestHeader({ username, password, method, uri, params, nc = 1, cnonce }) {
  const alg = (params.algorithm ?? 'MD5').toUpperCase();
  const isSess = alg.endsWith('-SESS');
  const base = isSess ? alg.slice(0, -5) : alg;
  const realm = params.realm ?? '';
  const nonce = params.nonce ?? '';
  const opaque = params.opaque;
  const qopList = (params.qop ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const qop = qopList.includes('auth') ? 'auth' : qopList[0] || '';
  const cn = cnonce ?? crypto.randomBytes(8).toString('hex');
  const ncHex = String(nc).padStart(8, '0');

  let ha1 = hash(base, `${username}:${realm}:${password}`);
  if (isSess) ha1 = hash(base, `${ha1}:${nonce}:${cn}`);
  const ha2 = hash(base, `${method}:${uri}`);
  const response = qop
    ? hash(base, `${ha1}:${nonce}:${ncHex}:${cn}:${qop}:${ha2}`)
    : hash(base, `${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (params.algorithm) parts.push(`algorithm=${params.algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cn}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

const basicHeader = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

/**
 * Fetch with automatic Digest/Basic auth.
 *
 * Cameras almost universally present self-signed certificates, so HTTPS requests to
 * them are made with certificate verification disabled *for that request only* — the
 * alternative is no monitoring at all. This is confined to camera probing and never
 * applies to alert-channel calls (WhatsApp, Telegram, webhooks), which always verify.
 */
export async function digestFetch(url, { username, password, method = 'GET', headers = {}, body, timeoutMs = 5000, insecureTLS = true } = {}) {
  const target = new URL(url);
  const uriPath = target.pathname + target.search;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('TIMEOUT')), timeoutMs);

  const opts = { method, headers: { ...headers }, body, signal: ac.signal, redirect: 'manual' };
  if (target.protocol === 'https:' && insecureTLS) {
    // Node 20+: per-request TLS relaxation without touching the global agent.
    const { Agent } = await import('undici');
    opts.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }

  try {
    let res = await fetch(target, opts);
    if (res.status !== 401) return res;

    const challenge = parseChallenge(res.headers.get('www-authenticate'));
    if (!challenge || !username) return res;

    // Drain the 401 body so the socket can be reused rather than left hanging.
    await res.arrayBuffer().catch(() => {});

    const auth = challenge.scheme === 'digest'
      ? buildDigestHeader({ username, password, method, uri: uriPath, params: challenge.params })
      : basicHeader(username, password);

    res = await fetch(target, { ...opts, headers: { ...opts.headers, Authorization: auth } });
    return res;
  } finally {
    clearTimeout(timer);
  }
}
