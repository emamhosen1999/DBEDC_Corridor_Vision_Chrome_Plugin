/**
 * Shared HTTP helper for alert channels.
 *
 * Unlike camera probing, alert delivery ALWAYS verifies TLS. These calls carry
 * credentials to third-party services across the public internet; accepting an
 * unverified certificate there would be indefensible.
 */
export class ChannelError extends Error {
  constructor(message, { permanent = false, status } = {}) {
    super(message);
    this.name = 'ChannelError';
    this.permanent = permanent;   // true => do not retry (bad credentials, bad request)
    this.status = status;
  }
}

/** A 4xx other than 408/429 is our fault and will never succeed on retry. */
export const isPermanentStatus = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

export async function postJson(url, body, { headers = {}, timeoutMs = 15_000, method = 'POST' } = {}) {
  return request(url, {
    method, timeoutMs,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, body, signal: ac.signal });
  } catch (err) {
    throw new ChannelError(
      err.name === 'AbortError' ? `request timed out after ${timeoutMs}ms` : `network error: ${err.message}`,
      { permanent: false },
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new ChannelError(
      `HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`,
      { permanent: isPermanentStatus(res.status), status: res.status },
    );
  }
  try { return { ok: true, status: res.status, body: JSON.parse(text) }; }
  catch { return { ok: true, status: res.status, body: text }; }
}

/** Split a long message so a channel's own length cap never truncates mid-word. */
export function chunk(text, limit) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) parts.push(rest);
  return parts.map((p, i) => (parts.length > 1 ? `${p}\n\n(${i + 1}/${parts.length})` : p));
}

/** Require a configuration field, failing permanently with an actionable message. */
export function required(value, field, channel) {
  const v = typeof value === 'string' ? value.trim() : value;
  if (!v) {
    throw new ChannelError(
      `${channel}: "${field}" is not configured. Set it in config/config.json (or the dashboard Settings page).`,
      { permanent: true },
    );
  }
  return v;
}
