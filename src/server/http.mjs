/**
 * Dashboard + API server, on node:http with no framework.
 *
 * Binds to loopback by default. Exposing it beyond loopback requires an access token
 * — config validation refuses to start otherwise, because an unauthenticated page
 * that lists every camera's IP on a corridor network is a gift to anyone who finds it.
 *
 * Live updates go over Server-Sent Events. SSE rather than WebSocket because it is
 * one-directional (which is all a dashboard needs), reconnects by itself, and needs
 * no dependency.
 */
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIRS } from '../core/paths.mjs';
import { log } from '../core/logger.mjs';
import { buildApi } from './api.mjs';

const logger = log('http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

export class DashboardServer {
  constructor({ cfg, engine }) {
    this.cfg = cfg;
    this.engine = engine;
    this.clients = new Set();
    this.server = null;
    this.api = buildApi({ cfg, engine, server: this });
  }

  /** Push an event to every connected dashboard. */
  broadcast(event, data) {
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try { res.write(frame); } catch { this.clients.delete(res); }
    }
  }

  #authorised(req, url) {
    const token = this.cfg.server.accessToken;
    if (!token) return true;      // loopback-only mode, enforced by config validation
    const provided = req.headers['x-access-token']
      ?? url.searchParams.get('token')
      ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!provided) return false;
    // Constant-time compare so the token cannot be guessed a byte at a time.
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(token));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async #serveStatic(url, res) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    // Contain the path inside the static directory — no traversal.
    const full = path.join(DIRS.static, rel);
    if (!full.startsWith(DIRS.static)) { res.writeHead(403).end('Forbidden'); return; }
    try {
      const body = await fsp.readFile(full);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // The dashboard loads nothing from anywhere else; say so explicitly.
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        'Referrer-Policy': 'no-referrer',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  #sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    // A comment frame every 20s keeps proxies and laptops from dropping the stream.
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
    this.engine.snapshotForApi().then((s) => {
      try { res.write(`event: status\ndata: ${JSON.stringify(s)}\n\n`); } catch { /* closed */ }
    });
  }

  async #handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname.startsWith('/api/') || url.pathname === '/events') {
      if (!this.#authorised(req, url)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorised', hint: 'send the access token as X-Access-Token' }));
        return;
      }
    }

    if (url.pathname === '/events') return this.#sse(req, res);

    if (url.pathname.startsWith('/api/')) {
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 4 * 1024 * 1024) { res.writeHead(413).end('Payload too large'); return; }
          chunks.push(c);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        try { body = raw ? JSON.parse(raw) : null; }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid JSON body' })); return; }
      }
      try {
        const out = await this.api.handle(req.method, url, body);
        res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out.body ?? {}));
      } catch (err) {
        logger.error('API error', { path: url.pathname, error: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    return this.#serveStatic(url, res);
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.#handle(req, res).catch((err) => {
          logger.error('request failed', { error: err.message });
          if (!res.headersSent) res.writeHead(500).end('Internal error');
        });
      });
      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(
            `Port ${this.cfg.server.port} is already in use. Either another copy of Corridor Vision is ` +
            'running, or change server.port in config/config.json.',
          ));
        } else reject(err);
      });
      this.server.listen(this.cfg.server.port, this.cfg.server.host, () => {
        logger.info('dashboard listening', { url: `http://${this.cfg.server.host}:${this.cfg.server.port}` });
        resolve(this.server);
      });
    });
  }

  async close() {
    for (const res of this.clients) { try { res.end(); } catch { /* already gone */ } }
    this.clients.clear();
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}
