#!/usr/bin/env node
/**
 * 生成 CodeLens 应用图标 build/icon.png（512x512 RGBA，PNG 编码零依赖）。
 * 设计：深色圆角底 + 品牌蓝（#197FE6）镜头光圈 + 发光焦点，呼应「Lens」。
 * electron-builder 会基于该 PNG 自动派生 .ico 与任务栏图标。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const CENTER = SIZE / 2;

// ---------- PNG 编码 ----------
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 画布 ----------
const pixels = Buffer.alloc(SIZE * SIZE * 4);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const BG_TOP = [20, 33, 61];
const BG_BOTTOM = [10, 15, 30];
const BRAND = [25, 127, 230];
const BRAND_LIGHT = [111, 192, 255];

// 圆角矩形 SDF（角半径 112）
const CORNER = 112;
function roundedRectMask(x, y) {
  const hx = Math.abs(x - CENTER) - (CENTER - CORNER);
  const hy = Math.abs(y - CENTER) - (CENTER - CORNER);
  const qx = Math.max(hx, 0);
  const qy = Math.max(hy, 0);
  const outside = Math.hypot(qx, qy) - CORNER;
  const inside = Math.min(Math.max(hx, hy), 0) + Math.hypot(qx, qy) - CORNER;
  const d = Math.max(inside, -outside + 0.5); // 近似外部距离
  void d;
  return outside; // <0 在内
}

// 六边形（顶点半径 88）的边法线
const HEX_VERTEX_R = 88;
const HEX_NORMALS = [];
for (let i = 0; i < 6; i++) {
  const a = (Math.PI / 3) * i - Math.PI / 2;
  HEX_NORMALS.push([Math.cos(a + Math.PI / 6), Math.sin(a + Math.PI / 6)]);
}
const HEX_INRADIUS = HEX_VERTEX_R * Math.cos(Math.PI / 6); // 76.2

function hexEdgeDistance(x, y) {
  const dx = x - CENTER;
  const dy = y - CENTER;
  let best = -Infinity;
  for (const [nx, ny] of HEX_NORMALS) best = Math.max(best, dx * nx + dy * ny);
  return best; // 到最近边的有符号距离（内负外正）
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = ((px - ax) * abx + (py - ay) * aby) / len2;
  t = clamp01(t);
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const idx = (y * SIZE + x) * 4;
    const mask = roundedRectMask(x, y);
    if (mask > 0) {
      pixels[idx + 3] = 0;
      continue;
    }
    // 背景：纵向渐变 + 品牌蓝径向辉光
    const gradT = y / (SIZE - 1);
    let [r, g, b] = mix(BG_TOP, BG_BOTTOM, gradT);
    const glow = Math.exp(-((Math.hypot(x - CENTER, y - (CENTER - 24)) / 300) ** 2)) * 0.3;
    [r, g, b] = mix([r, g, b], BRAND, glow);

    const dx = x - CENTER;
    const dy = y - CENTER;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    // 光圈外环（半径 152，宽 18）
    const ringBand = Math.abs(dist - 152);
    if (ringBand < 11) {
      const aa = 1 - smoothstep(7, 11, ringBand);
      const shade = (Math.sin(angle - Math.PI / 2) + 1) / 2; // 上深下浅
      const [rr, rg, rb] = mix(BRAND, BRAND_LIGHT, shade * 0.85);
      r = mix([r, g, b], [rr, rg, rb], aa)[0];
      g = mix([r, g, b], [rr, rg, rb], aa)[1];
      b = mix([r, g, b], [rr, rg, rb], aa)[2];
    }

    // 六根辐条：六边形顶点 → 外环
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      const vx = CENTER + Math.cos(a) * (HEX_VERTEX_R - 2);
      const vy = CENTER + Math.sin(a) * (HEX_VERTEX_R - 2);
      const rx = CENTER + Math.cos(a) * 143;
      const ry = CENTER + Math.sin(a) * 143;
      const d = distToSegment(x, y, vx, vy, rx, ry);
      if (d < 4) {
        const aa = 1 - smoothstep(2, 4, d);
        [r, g, b] = mix([r, g, b], BRAND_LIGHT, aa * 0.55);
      }
    }

    // 六边形开口描边
    const hexD = hexEdgeDistance(x, y);
    const hexBand = Math.abs(hexD - HEX_INRADIUS);
    if (hexBand < 5) {
      const aa = 1 - smoothstep(3, 5, hexBand);
      [r, g, b] = mix([r, g, b], BRAND_LIGHT, aa * 0.9);
    }

    // 焦点：白芯 → 品牌蓝 + 辉光
    const core = Math.hypot(dx, dy);
    if (core < 46) {
      const glowA = (1 - smoothstep(16, 46, core)) * 0.35;
      [r, g, b] = mix([r, g, b], BRAND_LIGHT, glowA);
    }
    if (core < 24) {
      const t = 1 - smoothstep(8, 24, core);
      [r, g, b] = mix([r, g, b], [235, 245, 255], t * 0.95);
    }

    pixels[idx] = Math.round(clamp01(r / 255) * 255);
    pixels[idx + 1] = Math.round(clamp01(g / 255) * 255);
    pixels[idx + 2] = Math.round(clamp01(b / 255) * 255);
    pixels[idx + 3] = 255;
  }
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'icon.png');
const pngBuf = encodePng(SIZE, SIZE, pixels);
writeFileSync(outFile, pngBuf);
console.log(`icon.png written: ${outFile} (${(pngBuf.length / 1024).toFixed(0)} KB)`);

// ---------- 同时输出 Windows 安装包所需的 .ico（256x256 32位，避免 electron-builder 离线环境下 PNG→ICO 转换失败） ----------
function downscale2(src, srcSize) {
  const dstSize = srcSize / 2;
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const si = ((y * 2 + dy) * srcSize + (x * 2 + dx)) * 4;
          r += src[si]; g += src[si + 1]; b += src[si + 2]; a += src[si + 3];
        }
      }
      const di = (y * dstSize + x) * 4;
      dst[di] = r >> 2; dst[di + 1] = g >> 2; dst[di + 2] = b >> 2; dst[di + 3] = a >> 2;
    }
  }
  return dst;
}

function encodeIco(rgba256) {
  const S = 256;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // count = 1
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width (0 => 256)
  entry[1] = 0; // height (0 => 256)
  entry[2] = 0; // colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bitCount
  const infoHeader = Buffer.alloc(40);
  infoHeader.writeUInt32LE(40, 0);
  infoHeader.writeUInt32LE(S, 4);
  infoHeader.writeUInt32LE(S * 2, 8); // biHeight = height*2 (ICO 含 AND mask)
  infoHeader.writeUInt16LE(1, 12);
  infoHeader.writeUInt16LE(32, 14);
  const pixelData = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    const srcY = S - 1 - y; // BMP 行序自下而上
    for (let x = 0; x < S; x++) {
      const si = (srcY * S + x) * 4;
      const di = (y * S + x) * 4;
      pixelData[di] = rgba256[si + 2];     // B
      pixelData[di + 1] = rgba256[si + 1]; // G
      pixelData[di + 2] = rgba256[si];     // R
      pixelData[di + 3] = rgba256[si + 3]; // A
    }
  }
  const andMask = Buffer.alloc((S * S) / 8); // 全 0 => 完全不透明（实际透明由 alpha 通道表达）
  const image = Buffer.concat([infoHeader, pixelData, andMask]);
  entry.writeUInt32LE(image.length, 8); // bytesInRes
  entry.writeUInt32LE(22, 12); // imageOffset
  return Buffer.concat([header, entry, image]);
}

const icoRgba = downscale2(pixels, SIZE);
const icoBuf = encodeIco(icoRgba);
const icoFile = path.join(outDir, 'icon.ico');
writeFileSync(icoFile, icoBuf);
console.log(`icon.ico written: ${icoFile} (${(icoBuf.length / 1024).toFixed(0)} KB)`);
