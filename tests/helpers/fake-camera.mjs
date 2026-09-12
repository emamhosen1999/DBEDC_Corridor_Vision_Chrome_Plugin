/**
 * A fake IP camera: RTSP on one port, HTTP (ONVIF + snapshot) on another.
 * Enough of each protocol to exercise the probe ladder for real, including
 * Digest auth, SDP and a JPEG snapshot.
 */
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

export async function startFakeCamera({
  rtspPort = 0, httpPort = 0, username = 'admin', password = 'secret',
  requireAuth = true, rtspPath = '/media/video1', jpeg = null, mediaService = true,
  behaviour = 'healthy',    // healthy | rtsp-dead | silent | slow
} = {}) {
  const nonce = 'deadbeefcafe';
  const realm = 'FakeCam';

  /* ---- RTSP ---- */
  const rtsp = net.createServer((socket) => {
    if (behaviour === 'silent') return;             // accepts then says nothing
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let idx;
      while ((idx = buf.indexOf('\r\n\r\n')) !== -1) {
        const head = buf.slice(0, idx);
        buf = buf.slice(idx + 4);
        const [line, ...headerLines] = head.split('\r\n');
        const [method, url] = line.split(' ');
        const headers = Object.fromEntries(headerLines.map((l) => {
          const i = l.indexOf(':');
          return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
        }));
        const cseq = headers.cseq ?? '1';
        const reply = (status, extra = '', body = '') => {
          const h = [`RTSP/1.0 ${status}`, `CSeq: ${cseq}`, 'Server: FakeCam/1.0'];
          if (extra) h.push(extra);
          if (body) h.push('Content-Type: application/sdp', `Content-Length: ${body.length}`);
          socket.write(h.join('\r\n') + '\r\n\r\n' + body);
        };

        if (method === 'OPTIONS') { reply('200 OK', 'Public: OPTIONS, DESCRIBE, SETUP, PLAY'); continue; }

        if (behaviour === 'rtsp-dead') { reply('503 Service Unavailable'); continue; }

        if (requireAuth) {
          const auth = headers.authorization ?? '';
          const m = /response="([0-9a-f]+)"/.exec(auth);
          const uriM = /uri="([^"]+)"/.exec(auth);
          const ncM = /nc=(\w+)/.exec(auth);
          const cnM = /cnonce="([^"]+)"/.exec(auth);
          const expected = m && uriM
            ? md5(`${md5(`${username}:${realm}:${password}`)}:${nonce}:${ncM?.[1] ?? '00000001'}:${cnM?.[1] ?? ''}:auth:${md5(`${method}:${uriM[1]}`)}`)
            : null;
          if (!m || m[1] !== expected) {
            reply('401 Unauthorized', `WWW-Authenticate: Digest realm="${realm}", nonce="${nonce}", qop="auth"`);
            continue;
          }
        }
        if (!String(url).endsWith(rtspPath)) { reply('404 Not Found'); continue; }
        const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=FakeCam', 'm=video 0 RTP/AVP 96',
          'a=rtpmap:96 H265/90000', 'a=x-dimensions:1920,1080', 'a=framerate:25.0'].join('\r\n') + '\r\n';
        reply('200 OK', null, sdp);
      }
    });
    socket.on('error', () => {});
  });

  /* ---- HTTP: ONVIF + snapshot ---- */
  const httpSrv = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/soap+xml') => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.url.startsWith('/snapshot')) {
      if (!jpeg) return send(404, 'no image', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
      return res.end(jpeg);
    }
    if (req.url.includes('device_service')) {
      const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
      if (/GetSystemDateAndTime/.test(body)) {
        const now = new Date();
        return send(200, `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
<tds:GetSystemDateAndTimeResponse xmlns:tds="x"><tds:SystemDateAndTime><tt:DateTimeType xmlns:tt="y">NTP</tt:DateTimeType>
<tt:UTCDateTime xmlns:tt="y"><tt:Time><tt:Hour>${now.getUTCHours()}</tt:Hour><tt:Minute>${now.getUTCMinutes()}</tt:Minute><tt:Second>${now.getUTCSeconds()}</tt:Second></tt:Time>
<tt:Date><tt:Year>${now.getUTCFullYear()}</tt:Year><tt:Month>${now.getUTCMonth() + 1}</tt:Month><tt:Day>${now.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime>
</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse></s:Body></s:Envelope>`);
      }
      if (/GetDeviceInformation/.test(body)) {
        return send(200, `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
<tds:GetDeviceInformationResponse xmlns:tds="x"><tds:Manufacturer>Uniview</tds:Manufacturer><tds:Model>IPC2324SR5</tds:Model>
<tds:FirmwareVersion>V1.2.3</tds:FirmwareVersion><tds:SerialNumber>SN12345</tds:SerialNumber></tds:GetDeviceInformationResponse></s:Body></s:Envelope>`);
      }
      return send(400, '<fault/>');
    }
    // ONVIF Media service: how a camera is asked for its REAL stream URL, rather
    // than being guessed at from a list of vendor path templates.
    if (req.url.includes('media_service')) {
      if (!mediaService) return send(404, 'not found', 'text/plain');
      const body = await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
      if (/GetProfiles/.test(body)) {
        return send(200, `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
<trt:GetProfilesResponse xmlns:trt="z"><trt:Profiles token="Profile_1" fixed="true"><tt:Name xmlns:tt="y">mainstream</tt:Name></trt:Profiles>
</trt:GetProfilesResponse></s:Body></s:Envelope>`);
      }
      if (/GetStreamUri/.test(body)) {
        return send(200, `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>
<trt:GetStreamUriResponse xmlns:trt="z"><trt:MediaUri><tt:Uri xmlns:tt="y">rtsp://127.0.0.1:${rtsp.address().port}${rtspPath}</tt:Uri>
</trt:MediaUri></trt:GetStreamUriResponse></s:Body></s:Envelope>`);
      }
      return send(400, '<fault/>');
    }
    send(404, 'not found', 'text/plain');
  });

  await new Promise((r) => rtsp.listen(rtspPort, '127.0.0.1', r));
  await new Promise((r) => httpSrv.listen(httpPort, '127.0.0.1', r));

  return {
    rtspPort: rtsp.address().port,
    httpPort: httpSrv.address().port,
    async stop() {
      await new Promise((r) => rtsp.close(r));
      await new Promise((r) => httpSrv.close(r));
    },
  };
}
