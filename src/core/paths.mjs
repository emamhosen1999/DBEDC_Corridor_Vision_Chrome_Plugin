/**
 * Filesystem layout.
 *
 * Everything the service writes lives under one root so that backup, rotation and
 * uninstall are a single directory operation. The root is overridable with
 * CORRIDOR_HOME so the Windows service can keep state on a data volume rather than
 * inside Program Files (which is read-only for the SYSTEM service in hardened SOEs).
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = process.env.CORRIDOR_HOME
  ? path.resolve(process.env.CORRIDOR_HOME)
  : path.resolve(here, '..', '..');

export const DIRS = {
  root: ROOT,
  config: path.join(ROOT, 'config'),
  data: path.join(ROOT, 'data'),
  logs: path.join(ROOT, 'logs'),
  events: path.join(ROOT, 'data', 'events'),
  snapshots: path.join(ROOT, 'data', 'snapshots'),
  exports: path.join(ROOT, 'data', 'exports'),
  static: path.join(here, '..', 'server', 'static'),
};

export const FILES = {
  config: path.join(DIRS.config, 'config.json'),
  configExample: path.join(DIRS.config, 'config.example.json'),
  secrets: path.join(DIRS.config, 'secrets.enc'),
  vaultKey: path.join(DIRS.config, 'vault.key'),
  inventory: path.join(DIRS.data, 'inventory.json'),
  state: path.join(DIRS.data, 'state.json'),
  outbox: path.join(DIRS.data, 'outbox.json'),
  pid: path.join(DIRS.data, 'corridor.pid'),
  heartbeat: path.join(DIRS.data, 'heartbeat.json'),
};

/** Create every directory the service needs. Idempotent. */
export function ensureDirs() {
  for (const dir of Object.values(DIRS)) {
    if (dir === DIRS.static) continue; // shipped with the source, never created
    fs.mkdirSync(dir, { recursive: true });
  }
}
