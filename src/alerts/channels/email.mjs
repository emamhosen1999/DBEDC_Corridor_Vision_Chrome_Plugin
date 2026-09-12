/**
 * SMTP email — implemented directly on a socket, no dependency.
 *
 * Nodemailer is excellent and is 100× the code needed to send a plain-text alert.
 * This speaks enough SMTP to do that reliably: EHLO, STARTTLS, AUTH LOGIN/PLAIN,
 * MAIL FROM, RCPT TO, DATA. It handles implicit TLS (465) and STARTTLS (587).
 */
import net from 'node:net';
import tls from 'node:tls';
import { ChannelError } from './http.mjs';
import { resolveRefs } from '../../core/secrets.mjs';

/** A tiny line-oriented SMTP conversation. */
class SmtpSession {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.buffer = '';
    this.pending = [];
    this.timeoutMs = timeoutMs;
    socket.setEncoding('utf8');
    socket.on('data', (d) => this.#onData(d));
    socket.on('error', (e) => this.#fail(e));
    socket.on('close', () => this.#fail(new Error('server closed the connection')));
  }

  #onData(chunk) {
    this.buffer += chunk;
    // A reply ends with "NNN <text>\r\n"; "NNN-<text>" lines are continuations.
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.lines = (this.lines ?? []).concat(line);
      if (/^\d{3} /.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines };
        this.lines = [];
        this.pending.shift()?.resolve(reply);
      }
    }
  }

  #fail(err) {
    while (this.pending.length) this.pending.shift().reject(err);
  }

  send(command) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SMTP timeout waiting for a reply to ${command?.split(' ')[0] ?? 'greeting'}`)), this.timeoutMs);
      this.pending.push({
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      if (command !== null) this.socket.write(command + '\r\n');
    });
  }

  async expect(command, ...codes) {
    const reply = await this.send(command);
    if (!codes.includes(reply.code)) {
      throw new ChannelError(
        `SMTP ${command?.split(' ')[0] ?? 'greeting'} failed: ${reply.code} ${reply.lines.join(' ')}`,
        // 5xx is a permanent refusal (bad credentials, relay denied); 4xx is transient.
        { permanent: reply.code >= 500 },
      );
    }
    return reply;
  }
}

function connect(host, port, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(socket))
      : net.connect({ host, port }, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new ChannelError(`could not connect to ${host}:${port} within ${timeoutMs}ms`)); });
    socket.once('error', (err) => reject(new ChannelError(`SMTP connect failed: ${err.message}`)));
  });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** RFC 2047 encoded-word, so an emoji in the subject is not mangled. */
const encodeSubject = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export const email = {
  name: 'email',
  describe: () => 'Email via SMTP',

  validate(raw) {
    const c = resolveRefs(raw);
    const problems = [];
    if (!c.host) problems.push('host is required, e.g. smtp.gmail.com');
    if (!c.from) problems.push('from is required');
    const to = [].concat(c.to ?? []).filter(Boolean);
    if (!to.length) problems.push('to must contain at least one address');
    for (const addr of to) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) problems.push(`"${addr}" is not a valid email address`);
    if (c.user && !c.pass) problems.push('pass is required when user is set');
    return problems;
  },

  async send(msg, raw) {
    const c = resolveRefs(raw);
    const port = Number(c.port) || 587;
    const implicitTls = c.secure === true || port === 465;
    const timeoutMs = Number(c.timeoutMs) || 20_000;
    const recipients = [].concat(c.to ?? []).filter(Boolean);

    let socket = await connect(c.host, port, implicitTls, timeoutMs);
    let smtp = new SmtpSession(socket, timeoutMs);
    await smtp.expect(null, 220);                                  // server greeting
    let ehlo = await smtp.expect(`EHLO ${c.heloName || 'corridor-vision'}`, 250);

    if (!implicitTls && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await smtp.expect('STARTTLS', 220);
      socket = tls.connect({ socket, host: c.host, servername: c.host });
      await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
      smtp = new SmtpSession(socket, timeoutMs);
      ehlo = await smtp.expect(`EHLO ${c.heloName || 'corridor-vision'}`, 250);
    }

    if (c.user) {
      const mechanisms = ehlo.lines.join(' ').toUpperCase();
      if (mechanisms.includes('AUTH') && mechanisms.includes('PLAIN')) {
        await smtp.expect(`AUTH PLAIN ${b64(`\0${c.user}\0${c.pass}`)}`, 235);
      } else {
        await smtp.expect('AUTH LOGIN', 334);
        await smtp.expect(b64(c.user), 334);
        await smtp.expect(b64(c.pass), 235);
      }
    }

    await smtp.expect(`MAIL FROM:<${c.from}>`, 250);
    for (const rcpt of recipients) await smtp.expect(`RCPT TO:<${rcpt}>`, 250, 251);
    await smtp.expect('DATA', 354);

    const headers = [
      `From: ${c.fromName ? `${encodeSubject(c.fromName)} <${c.from}>` : c.from}`,
      `To: ${recipients.join(', ')}`,
      `Subject: ${encodeSubject(msg.title)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@corridor-vision>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      `X-Corridor-Severity: ${msg.severity}`,
      msg.severity === 'critical' ? 'X-Priority: 1' : 'X-Priority: 3',
    ];
    // Base64 sidesteps SMTP's line-length limits and dot-stuffing entirely.
    const body = b64(msg.text).replace(/(.{76})/g, '$1\r\n');
    await smtp.expect(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.`, 250);
    try { await smtp.expect('QUIT', 221); } catch { /* some servers just close */ }
    socket.destroy();
    return { target: recipients.join(', ') };
  },
};
