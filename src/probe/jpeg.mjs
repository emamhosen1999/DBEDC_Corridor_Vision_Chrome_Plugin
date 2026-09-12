/**
 * Minimal baseline-JPEG analyser — DC coefficients only.
 *
 * Why not just use an image library? Because this service must survive a decade of
 * unattended operation on a Windows box, and every native image dependency is a
 * future `node-gyp` failure after a Node upgrade. We do not need pixels; we need
 * three numbers per frame. The DC coefficient of each 8×8 block *is* that block's
 * mean luminance, so decoding DC only gives us a free 1/8-scale thumbnail at a
 * fraction of the work and with zero dependencies.
 *
 * From that thumbnail:
 *   - mean luma      → a black frame (IR cut filter stuck, sensor dead, lens cap)
 *   - variance       → a flat frame (lens covered, fogged, spray-painted, wall-facing)
 *   - dHash          → a frozen frame (encoder wedged: the classic "the camera says
 *                      it is fine and has been sending the same picture for 6 hours")
 *
 * Progressive JPEGs (SOF2) are not DC-decodable this way; those fall back to the
 * size/identity heuristics in snapshot.mjs, which is stated rather than hidden.
 */

const M = {
  SOI: 0xd8, EOI: 0xd9, SOS: 0xda, DQT: 0xdb, DNL: 0xdc, DRI: 0xdd,
  SOF0: 0xc0, SOF1: 0xc1, SOF2: 0xc2, SOF3: 0xc3, DHT: 0xc4,
};

const ZIGZAG_DC = 0; // the DC coefficient is always index 0 in zig-zag order

class BitReader {
  constructor(buf, pos) { this.buf = buf; this.pos = pos; this.bits = 0; this.count = 0; this.eof = false; }

  readBit() {
    if (this.count === 0) {
      if (this.pos >= this.buf.length) { this.eof = true; return 0; }
      let b = this.buf[this.pos++];
      if (b === 0xff) {
        const next = this.buf[this.pos];
        if (next === 0x00) this.pos++;              // stuffed byte
        else if (next >= 0xd0 && next <= 0xd7) { /* restart marker, handled by caller */ }
        else { this.eof = true; return 0; }          // a real marker ends the scan
      }
      this.bits = b; this.count = 8;
    }
    this.count--;
    return (this.bits >> this.count) & 1;
  }

  receive(n) { let v = 0; for (let i = 0; i < n; i++) { v = (v << 1) | this.readBit(); if (this.eof) return v; } return v; }

  /** JPEG's signed-magnitude extension (F.2.2.1). */
  receiveAndExtend(n) {
    if (n === 0) return 0;
    const v = this.receive(n);
    return v < (1 << (n - 1)) ? v - (1 << n) + 1 : v;
  }

  align() { this.count = 0; }

  /** Consume an RSTn marker if one is next; returns true when it did. */
  skipRestart() {
    this.align();
    while (this.pos + 1 < this.buf.length) {
      if (this.buf[this.pos] === 0xff) {
        const m = this.buf[this.pos + 1];
        if (m >= 0xd0 && m <= 0xd7) { this.pos += 2; return true; }
        if (m === 0x00) { this.pos += 2; continue; }
        return false;
      }
      this.pos++;
    }
    return false;
  }
}

/** Build a `length:code -> value` lookup from a DHT segment. */
function buildHuffTable(bits, values) {
  const table = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) table.set(`${len}:${code++}`, values[k++]);
    code <<= 1;
  }
  return table;
}

function decodeHuff(reader, table) {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | reader.readBit();
    if (reader.eof) return null;
    const v = table.get(`${len}:${code}`);
    if (v !== undefined) return v;
  }
  return null;
}

/** Parse structure only — dimensions, encoding mode, component layout. */
export function readJpegHeader(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== M.SOI) return { ok: false, reason: 'not-jpeg' };
  let pos = 2;
  const out = { ok: true, progressive: false, width: 0, height: 0, components: 0, restartInterval: 0 };
  while (pos < buf.length - 1) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    pos += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) continue;
    if (marker === M.EOI) break;
    const len = buf.readUInt16BE(pos);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== M.DHT && marker !== 0xc8 && marker !== 0xcc) {
      out.progressive = marker === M.SOF2;
      out.baseline = marker === M.SOF0 || marker === M.SOF1;
      out.height = buf.readUInt16BE(pos + 3);
      out.width = buf.readUInt16BE(pos + 5);
      out.components = buf[pos + 7];
    } else if (marker === M.DRI) {
      out.restartInterval = buf.readUInt16BE(pos + 2);
    } else if (marker === M.SOS) {
      out.hasScan = true;
      break;
    }
    pos += len;
  }
  if (!out.width || !out.height) return { ok: false, reason: 'no-frame-header' };
  return out;
}

/**
 * Decode DC coefficients into a luma thumbnail.
 * Returns `{ ok, width, height, luma: Uint8Array, cols, rows }` for baseline JPEGs.
 */
export function decodeDcThumbnail(buf) {
  const header = readJpegHeader(buf);
  if (!header.ok) return { ok: false, reason: header.reason };
  // NB: spread the header FIRST — it carries ok:true and would otherwise clobber ok:false.
  if (header.progressive) return { ...header, ok: false, reason: 'progressive' };

  const quant = {};
  const huffDC = {};
  const huffAC = {};
  let frame = null;
  let restartInterval = 0;
  let pos = 2;

  while (pos < buf.length - 1) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    pos += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) continue;
    if (marker === M.EOI) break;
    if (pos + 2 > buf.length) break;
    const len = buf.readUInt16BE(pos);
    const segEnd = pos + len;
    let p = pos + 2;

    if (marker === M.DQT) {
      while (p < segEnd) {
        const pq = buf[p] >> 4; const tq = buf[p] & 15; p++;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) { table[i] = pq ? buf.readUInt16BE(p + i * 2) : buf[p + i]; }
        p += pq ? 128 : 64;
        quant[tq] = table;
      }
    } else if (marker === M.DHT) {
      while (p < segEnd) {
        const tc = buf[p] >> 4; const th = buf[p] & 15; p++;
        const bits = Array.from(buf.subarray(p, p + 16)); p += 16;
        const total = bits.reduce((a, b) => a + b, 0);
        const values = Array.from(buf.subarray(p, p + total)); p += total;
        (tc === 0 ? huffDC : huffAC)[th] = buildHuffTable(bits, values);
      }
    } else if (marker === M.DRI) {
      restartInterval = buf.readUInt16BE(p);
    } else if (marker === M.SOF0 || marker === M.SOF1) {
      const height = buf.readUInt16BE(p + 1);
      const width = buf.readUInt16BE(p + 3);
      const n = buf[p + 5];
      const comps = [];
      for (let i = 0; i < n; i++) {
        const off = p + 6 + i * 3;
        comps.push({ id: buf[off], h: buf[off + 1] >> 4, v: buf[off + 1] & 15, tq: buf[off + 2] });
      }
      frame = { width, height, comps };
    } else if (marker === M.SOS) {
      if (!frame) return { ok: false, reason: 'sos-before-sof' };
      const ns = buf[p]; p++;
      const scan = [];
      for (let i = 0; i < ns; i++) {
        const id = buf[p]; const td = buf[p + 1] >> 4; const ta = buf[p + 1] & 15; p += 2;
        const comp = frame.comps.find((c) => c.id === id);
        if (comp) scan.push({ ...comp, td, ta });
      }
      p += 3; // Ss, Se, Ah/Al
      return decodeScan(buf, p, frame, scan, { quant, huffDC, huffAC, restartInterval });
    }
    pos = segEnd;
  }
  return { ok: false, reason: 'no-scan' };
}

function decodeScan(buf, start, frame, scan, tables) {
  const { quant, huffDC, huffAC, restartInterval } = tables;
  const hMax = Math.max(...frame.comps.map((c) => c.h));
  const vMax = Math.max(...frame.comps.map((c) => c.v));
  const mcuW = 8 * hMax;
  const mcuH = 8 * vMax;
  const mcusX = Math.ceil(frame.width / mcuW);
  const mcusY = Math.ceil(frame.height / mcuH);

  const y = scan[0];                                   // component 0 is luma in every camera JPEG
  if (!y) return { ok: false, reason: 'no-luma-component' };
  const cols = mcusX * y.h;
  const rows = mcusY * y.v;
  const luma = new Uint8ClampedArray(cols * rows);

  const reader = new BitReader(buf, start);
  const pred = new Map(scan.map((c) => [c.id, 0]));
  const qt = quant[y.tq] ?? new Int32Array(64).fill(1);
  const dcQuant = qt[ZIGZAG_DC] || 1;
  let mcuCount = 0;

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval && mcuCount > 0 && mcuCount % restartInterval === 0) {
        if (reader.skipRestart()) for (const c of scan) pred.set(c.id, 0);
      }
      mcuCount++;

      for (const comp of scan) {
        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            const t = decodeHuff(reader, huffDC[comp.td]);
            if (t === null || reader.eof) return finishThumb(luma, cols, rows, frame, true);
            const diff = t === 0 ? 0 : reader.receiveAndExtend(t);
            const dc = pred.get(comp.id) + diff;
            pred.set(comp.id, dc);

            if (comp === y) {
              // DC = 8 × (mean of level-shifted samples) ⇒ mean = DC·Q/8 + 128
              const value = Math.round((dc * dcQuant) / 8) + 128;
              const col = mx * y.h + bx;
              const row = my * y.v + by;
              if (col < cols && row < rows) luma[row * cols + col] = value;
            }

            // Skip the AC coefficients — we only need the block mean.
            let k = 1;
            const ac = huffAC[comp.ta];
            while (k < 64) {
              const rs = decodeHuff(reader, ac);
              if (rs === null || reader.eof) return finishThumb(luma, cols, rows, frame, true);
              const s = rs & 15;
              const r = rs >> 4;
              if (s === 0) { if (r === 15) { k += 16; continue; } break; }
              k += r + 1;
              reader.receive(s);
            }
          }
        }
      }
    }
  }
  return finishThumb(luma, cols, rows, frame, false);
}

function finishThumb(luma, cols, rows, frame, truncated) {
  return { ok: true, luma, cols, rows, width: frame.width, height: frame.height, truncated };
}

/** Mean, variance and a 64-bit difference hash from a luma thumbnail. */
export function analyseThumbnail({ luma, cols, rows }) {
  const n = luma.length;
  if (!n) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += luma[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) { const d = luma[i] - mean; varSum += d * d; }
  const variance = varSum / n;

  // dHash: resample to 9×8 and compare horizontally adjacent cells.
  const bits = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const sx = Math.min(cols - 1, Math.floor((x * cols) / 9));
      const sy = Math.min(rows - 1, Math.floor((y * rows) / 8));
      bits.push(luma[sy * cols + sx]);
    }
  }
  let hash = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) if (bits[y * 9 + x] < bits[y * 9 + x + 1]) byte |= 1 << x;
    hash += byte.toString(16).padStart(2, '0');
  }
  return { meanLuma: Math.round(mean * 10) / 10, variance: Math.round(variance * 10) / 10, stdDev: Math.round(Math.sqrt(variance) * 10) / 10, dHash: hash };
}

/** Hamming distance between two dHashes (0 = identical frame). */
export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** One-call analysis of a JPEG buffer. */
export function analyseJpeg(buf) {
  const header = readJpegHeader(buf);
  if (!header.ok) return { ok: false, reason: header.reason, bytes: buf.length };
  const thumb = decodeDcThumbnail(buf);
  if (!thumb.ok) {
    return { ok: false, reason: thumb.reason, bytes: buf.length, width: header.width, height: header.height, progressive: header.progressive };
  }
  const stats = analyseThumbnail(thumb);
  return {
    ok: true, bytes: buf.length,
    width: thumb.width, height: thumb.height,
    blocks: thumb.cols * thumb.rows,
    truncated: thumb.truncated,
    ...stats,
  };
}
