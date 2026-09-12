/**
 * Encrypted credential vault.
 *
 * Camera passwords, WhatsApp tokens and SMTP credentials never touch config.json.
 * They live in `config/secrets.enc`, AES-256-GCM, keyed by a 32-byte keyfile that is
 * generated on first use.
 *
 * Threat model, stated plainly so nobody over-trusts this: the keyfile sits on the
 * same disk as the ciphertext, so this protects against **casual disclosure** —
 * config files pasted into a chat, copied into a runbook, committed to git, read off
 * a backup tape, or picked up by a non-admin user who can read the app directory but
 * not the ACL-restricted keyfile. It does NOT protect against an attacker who is
 * already SYSTEM/Administrator on this box; nothing running unattended can.
 * Run `scripts/protect-key.ps1` to lock the keyfile to SYSTEM + Administrators.
 *
 * Set CORRIDOR_VAULT_PASSPHRASE to require a passphrase in addition to the keyfile
 * (the key is then scrypt(keyfile || passphrase)); the service will not start
 * unattended in that mode, which is the correct trade-off for some sites.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { FILES, ensureDirs } from './paths.mjs';

const MAGIC = 'CVLT1';
const VAULT_REF = /^@vault:([\w.-]+)$/;

function loadKey() {
  ensureDirs();
  let raw;
  if (fs.existsSync(FILES.vaultKey)) {
    raw = fs.readFileSync(FILES.vaultKey);
    if (raw.length < 32) throw new Error('config/vault.key is corrupt (expected >=32 bytes)');
  } else {
    raw = crypto.randomBytes(32);
    fs.writeFileSync(FILES.vaultKey, raw, { mode: 0o600 });
    try { fs.chmodSync(FILES.vaultKey, 0o600); } catch { /* Windows ignores POSIX modes; use protect-key.ps1 */ }
  }
  const passphrase = process.env.CORRIDOR_VAULT_PASSPHRASE;
  if (passphrase) {
    // scrypt with the keyfile as salt: both factors are required to derive the key.
    return crypto.scryptSync(passphrase, raw.subarray(0, 16), 32, { N: 16384, r: 8, p: 1 });
  }
  return raw.subarray(0, 32);
}

function readVault() {
  if (!fs.existsSync(FILES.secrets)) return {};
  const blob = fs.readFileSync(FILES.secrets);
  const header = blob.subarray(0, MAGIC.length).toString('utf8');
  if (header !== MAGIC) throw new Error('config/secrets.enc has an unrecognised format');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const body = blob.subarray(MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(
      'Could not decrypt config/secrets.enc. The vault key does not match — either ' +
      'vault.key was replaced, or CORRIDOR_VAULT_PASSPHRASE is wrong/unset.',
    );
  }
  return JSON.parse(plain);
}

function writeVault(obj) {
  ensureDirs();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const blob = Buffer.concat([Buffer.from(MAGIC, 'utf8'), iv, cipher.getAuthTag(), body]);
  const tmp = `${FILES.secrets}.tmp`;
  fs.writeFileSync(tmp, blob, { mode: 0o600 });
  fs.renameSync(tmp, FILES.secrets);
}

let cache = null;
const vault = () => (cache ??= readVault());

/** Read a secret by dotted path, e.g. `getSecret('telegram.botToken')`. */
export function getSecret(pathStr, fallback = '') {
  const parts = String(pathStr).split('.');
  let node = vault();
  for (const p of parts) {
    if (!node || typeof node !== 'object') return fallback;
    node = node[p];
  }
  return node === undefined || node === null ? fallback : node;
}

/** Write a secret by dotted path. Pass `null` to delete it. */
export function setSecret(pathStr, value) {
  const parts = String(pathStr).split('.');
  const obj = structuredClone(vault());
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  const leaf = parts.at(-1);
  if (value === null) delete node[leaf]; else node[leaf] = value;
  writeVault(obj);
  cache = obj;
}

/** List stored secret paths (names only — never values). */
export function listSecrets() {
  const out = [];
  (function walk(node, prefix) {
    for (const [k, v] of Object.entries(node ?? {})) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
      else out.push(p);
    }
  })(vault(), '');
  return out.sort();
}

/**
 * Resolve `@vault:foo.bar` references inside a config subtree. Channels call this on
 * their own config so that neither the dashboard API nor a log line ever holds a
 * plaintext credential for longer than the HTTP call that needs it.
 */
export function resolveRefs(value) {
  if (typeof value === 'string') {
    const m = VAULT_REF.exec(value);
    return m ? getSecret(m[1], '') : value;
  }
  if (Array.isArray(value)) return value.map(resolveRefs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v)]));
  }
  return value;
}

/** True if `value` is an unresolved vault reference pointing at a missing secret. */
export function isMissingRef(value) {
  const m = typeof value === 'string' ? VAULT_REF.exec(value) : null;
  return !!m && !getSecret(m[1], '');
}

/** Redact anything that looks like a credential before it reaches a log or the API. */
export function redact(obj) {
  const SENSITIVE = /(pass|password|token|secret|apikey|api_key|authorization|cookie|credential)/i;
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => {
      if (SENSITIVE.test(k) && v) return [k, typeof v === 'string' && v.startsWith('@vault:') ? v : '••••••••'];
      return [k, redact(v)];
    }));
  }
  return obj;
}

export function _resetCacheForTests() { cache = null; }
