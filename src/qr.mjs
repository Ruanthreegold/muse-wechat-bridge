// qr.mjs — Minimal QR encoder (byte mode, error-correction level M, versions 1–10)
// plus a grayscale PNG writer. Zero dependencies: only node:zlib is used.
//
// Implemented from the ISO/IEC 18004 model: GF(256) Reed–Solomon, block
// interleaving, mask evaluation with the four standard penalty rules.
// Verified module-for-module against the Python `qrcode` reference library
// during development (dev-time check only; not a runtime dependency).

import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// GF(256) arithmetic, primitive polynomial x^8+x^4+x^3+x^2+1 (0x11D)
// ---------------------------------------------------------------------------
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// ---------------------------------------------------------------------------
// Reed–Solomon: generator polynomial and remainder (Nayuki-style formulation)
// ---------------------------------------------------------------------------
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1; // start with monomial x^0
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i++) {
      result[i] ^= gfMul(divisor[i], factor);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Capacity tables for EC level M (ISO 18004, Table 9)
// [ecCodewordsPerBlock, [[numBlocks, dataCodewordsPerBlock], ...]]
// ---------------------------------------------------------------------------
const ECC_M_TABLE = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};
const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134,
  6: 172, 7: 196, 8: 242, 9: 292, 10: 346,
};
const REMAINDER_BITS = {
  1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0,
};
const ALIGNMENT_CENTERS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

function dataCapacityBytes(version) {
  const [, groups] = ECC_M_TABLE[version];
  const dataCw = groups.reduce((s, [n, c]) => s + n * c, 0);
  const lenBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCw * 8 - 4 - lenBits) / 8);
}

class BitBuffer {
  constructor() {
    this.bits = [];
  }
  append(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  appendBytes(bytes) {
    for (const b of bytes) this.append(b, 8);
  }
  get length() {
    return this.bits.length;
  }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] ?? 0);
      out.push(b);
    }
    return out;
  }
}

/** Encode payload bytes into the final interleaved codeword byte array. */
function encodeCodewords(bytes, version) {
  const [ecPerBlock, groups] = ECC_M_TABLE[version];
  const totalDataCw = groups.reduce((s, [n, c]) => s + n * c, 0);
  const capacityBits = totalDataCw * 8;

  const bb = new BitBuffer();
  bb.append(0b0100, 4); // byte mode
  bb.append(bytes.length, version <= 9 ? 8 : 16);
  bb.appendBytes(bytes);
  // Terminator + alignment + pad bytes
  bb.append(0, Math.min(4, capacityBits - bb.length));
  while (bb.length % 8 !== 0) bb.append(0, 1);
  const dataBytes = bb.toBytes();
  const pads = [0xec, 0x11];
  for (let i = 0; dataBytes.length < totalDataCw; i++) dataBytes.push(pads[i % 2]);

  // Split into blocks, compute ECC per block
  const blocks = [];
  const divisor = rsDivisor(ecPerBlock);
  let offset = 0;
  for (const [count, cwPerBlock] of groups) {
    for (let n = 0; n < count; n++) {
      const block = dataBytes.slice(offset, offset + cwPerBlock);
      offset += cwPerBlock;
      blocks.push({ data: block, ecc: rsRemainder(block, divisor) });
    }
  }
  // Interleave data then ECC
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of blocks) out.push(b.ecc[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------
function buildMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    }
  };

  // Timing patterns
  for (let i = 0; i < size; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  // Finder patterns with separators
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  // Alignment patterns
  const centers = ALIGNMENT_CENTERS[version];
  for (const cy of centers) {
    for (const cx of centers) {
      // Skip if overlapping a finder pattern
      if (modules[cy][cx] !== null && isFunction[cy][cx] && (cx === 6 || cy === 6)) {
        // alignment on timing line is fine; only skip finder corners
      }
      const overlapsFinder =
        (cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9);
      if (overlapsFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          set(cx + dx, cy + dy, dist !== 1);
        }
      }
    }
  }
  // Dark module
  set(8, size - 8, true);
  // Reserve format info areas
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      if (modules[8][i] === null) set(i, 8, false);
      if (modules[i][8] === null) set(8, i, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    if (modules[8][size - 1 - i] === null) set(size - 1 - i, 8, false);
    if (modules[size - 1 - i][8] === null) set(8, size - 1 - i, false);
  }
  set(8, size - 8, true); // dark module (again, after reserve pass)
  // Version info for version >= 7
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) !== 0;
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }
  return { modules, isFunction, size };
}

function applyMask(modules, isFunction, mask) {
  const size = modules.length;
  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ][mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && maskFn(x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

function drawFormatBits(modules, mask) {
  const size = modules.length;
  // EC level M = 0b00
  const data = mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const getBit = (i) => ((bits >>> i) & 1) !== 0;
  // First copy
  for (let i = 0; i <= 5; i++) modules[i][8] = getBit(i);
  modules[7][8] = getBit(6);
  modules[8][8] = getBit(7);
  modules[8][7] = getBit(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = getBit(i);
  // Second copy
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = getBit(i);
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = getBit(i);
  modules[size - 8][8] = true; // dark module
}

function placeData(modules, isFunction, codewords, version) {
  const size = modules.length;
  const bits = [];
  for (const b of codewords) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version]; i++) bits.push(0);
  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) {
          modules[y][x] = bitIdx < bits.length ? bits[bitIdx] === 1 : false;
          bitIdx++;
        }
      }
    }
  }
}

// --- Penalty evaluation (ISO 18004 rules) ---
function penaltyScore(modules) {
  const size = modules.length;
  let penalty = 0;
  // Rule 1: runs
  for (let y = 0; y < size; y++) {
    for (const line of [modules[y], modules.map((r) => r[y])]) {
      let runColor = line[0];
      let runLen = 1;
      for (let i = 1; i < size; i++) {
        if (line[i] === runColor) runLen++;
        else {
          if (runLen >= 5) penalty += 3 + (runLen - 5);
          runColor = line[i];
          runLen = 1;
        }
      }
      if (runLen >= 5) penalty += 3 + (runLen - 5);
    }
  }
  // Rule 2: 2x2 blocks
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        penalty += 3;
      }
    }
  }
  // Rule 3: finder-like patterns
  for (let y = 0; y < size; y++) {
    for (const line of [modules[y], modules.map((r) => r[y])]) {
      for (let i = 0; i + 7 <= size; i++) {
        const pat = [1, 0, 1, 1, 1, 0, 1];
        let match = true;
        for (let j = 0; j < 7; j++) if ((line[i + j] ? 1 : 0) !== pat[j]) { match = false; break; }
        if (!match) continue;
        const before = i >= 4 && line.slice(i - 4, i).every((v) => !v);
        const after = i + 11 <= size && line.slice(i + 7, i + 11).every((v) => !v);
        if (before || after) penalty += 40;
      }
    }
  }
  // Rule 4: dark ratio
  let dark = 0;
  for (const row of modules) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  penalty += Math.max(0, k) * 10;
  return penalty;
}

/**
 * Encode a string payload into a QR module matrix.
 * Returns { size, modules } where modules[y][x] is true for dark.
 * Supports byte mode, EC level M, versions 1–10 (max 213 bytes payload).
 */
export function encodeQrMatrix(text) {
  const bytes = Buffer.from(text, "utf-8");
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length <= dataCapacityBytes(v)) { version = v; break; }
  }
  if (version === 0) {
    throw new Error(`QR payload too long: ${bytes.length} bytes (max 213 for V10-M)`);
  }
  const codewords = encodeCodewords(Array.from(bytes), version);
  if (codewords.length !== TOTAL_CODEWORDS[version]) {
    throw new Error(`internal: codeword count ${codewords.length} != ${TOTAL_CODEWORDS[version]}`);
  }
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const { modules, isFunction } = buildMatrix(version);
    placeData(modules, isFunction, codewords, version);
    applyMask(modules, isFunction, mask);
    drawFormatBits(modules, mask);
    const score = penaltyScore(modules);
    if (best === null || score < best.score) best = { score, modules, mask, version };
  }
  return { size: best.modules.length, modules: best.modules, version: best.version, mask: best.mask };
}

// ---------------------------------------------------------------------------
// PNG writer (8-bit grayscale, zlib deflate from node:zlib)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Render a QR matrix to a PNG buffer. Quiet zone of 4 modules included. */
export function qrMatrixToPng({ size, modules }, targetPx = 512) {
  const quiet = 4;
  const totalModules = size + quiet * 2;
  const scale = Math.max(1, Math.floor(targetPx / totalModules));
  const px = totalModules * scale;
  const raw = Buffer.alloc(px * (px + 1));
  for (let y = 0; y < px; y++) {
    const rowStart = y * (px + 1);
    raw[rowStart] = 0; // filter: none
    const my = Math.floor(y / scale) - quiet;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - quiet;
      let dark = false;
      if (mx >= 0 && mx < size && my >= 0 && my < size) dark = modules[my][mx];
      raw[rowStart + 1 + x] = dark ? 0x00 : 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

/** Encode text directly to a PNG buffer. */
export function encodeQrPng(text) {
  return qrMatrixToPng(encodeQrMatrix(text));
}
