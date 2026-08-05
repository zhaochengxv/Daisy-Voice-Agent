#!/usr/bin/env node
/**
 * Daisy 应用图标生成器（纯 Node，无外部依赖）
 *
 * 生成三份资产：
 *   assets/icon.ico    Windows 应用 + 安装包图标（256/128/64/48/32/24/16 PNG-based ICO）
 *   assets/icon.icns   macOS 应用图标（ic10=1024/ic09=512/ic08=256/ic07=128 PNG-based ICNS）
 *   assets/tray.ico    Windows 托盘专用（32/16，16px 也保真）
 *
 * 视觉设计（科技感/神秘感 AI 语音助手）：
 *   深空圆徽 + 极光光球 + 环绕音波弧 + 斜行星环 + 星光
 * 用法：node scripts/generate-icons.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 1024;
const OUT_DIR = path.join(__dirname, "..", "assets");

/* ---------------------------- PNG 编码 ---------------------------- */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // compression/filter/interlace = 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------------------- 降采样 ---------------------------- */

/** 一般化 box-filter 降采样，输出 RGBA Buffer */
function downsample(src, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.floor((y * srcH) / dstH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.floor((x * srcW) / dstW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * srcW + sx) * 4;
          // 预乘 alpha 平均，避免深色边缘渗进透明区
          const pa = src[o + 3] / 255;
          r += src[o] * pa; g += src[o + 1] * pa; b += src[o + 2] * pa; a += pa;
          n++;
        }
      }
      if (a === 0) { out.fill(0, (y * dstW + x) * 4, (y * dstW + x) * 4 + 4); continue; }
      const o = (y * dstW + x) * 4;
      out[o] = Math.min(255, Math.round(r / a));
      out[o + 1] = Math.min(255, Math.round(g / a));
      out[o + 2] = Math.min(255, Math.round(b / a));
      out[o + 3] = Math.min(255, Math.round((a / n) * 255));
    }
  }
  return out;
}

/* ---------------------------- ICO / ICNS 容器 ---------------------------- */

function buildICO(sizes, rgbaCache) {
  const entries = [];
  const bodies = [];
  for (const size of sizes) {
    const png = encodePNG(size, size, rgbaCache(size));
    entries.push({ size, png });
  }
  let offset = 6 + entries.length * 16;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);
  const parts = [header];
  for (const e of entries) {
    const ent = Buffer.alloc(16);
    ent[0] = e.size >= 256 ? 0 : e.size;
    ent[1] = e.size >= 256 ? 0 : e.size;
    ent.writeUInt16LE(1, 4); // planes
    ent.writeUInt16LE(32, 6); // bpp
    ent.writeUInt32LE(e.png.length, 8);
    ent.writeUInt32LE(offset, 12);
    offset += e.png.length;
    parts.push(ent);
  }
  for (const e of entries) parts.push(e.png);
  return Buffer.concat(parts);
}

function buildICNS(types, rgbaCache) {
  const blocks = [];
  for (const [type, size] of types) {
    const png = encodePNG(size, size, rgbaCache(size));
    const block = Buffer.alloc(8 + png.length);
    block.write(type, 0, "ascii");
    block.writeUInt32BE(8 + png.length, 4);
    png.copy(block, 8);
    blocks.push(block);
  }
  const total = 8 + blocks.reduce((s, b) => s + b.length, 0);
  const out = Buffer.alloc(total);
  out.write("icns", 0, "ascii");
  out.writeUInt32BE(total, 4);
  let off = 8;
  for (const b of blocks) { b.copy(out, off); off += b.length; }
  return out;
}

/* ---------------------------- 像素绘制 ---------------------------- */

function createCanvas(size) {
  const buf = Buffer.alloc(size * size * 4); // 透明黑
  return {
    size,
    buf,
    set(x, y, r, g, b, a) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      const o = (y * size + x) * 4;
      const sa = a / 255;
      const da = buf[o + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) return;
      buf[o] = Math.round((r * sa + buf[o] * da * (1 - sa)) / outA);
      buf[o + 1] = Math.round((g * sa + buf[o + 1] * da * (1 - sa)) / outA);
      buf[o + 2] = Math.round((b * sa + buf[o + 2] * da * (1 - sa)) / outA);
      buf[o + 3] = Math.round(outA * 255);
    },
  };
}

function smoothStep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function drawIcon(size) {
  const cv = createCanvas(size);
  const S = size;
  const cx = S / 2, cy = S / 2;

  // 徽章圆半径（外圆），留出边缘辉光空间
  const R = S * 0.47;
  const R_in = R - S * 0.012;

  // 逐像素绘制主体
  const star = [
    [0.18, 0.24], [0.30, 0.14], [0.76, 0.20], [0.84, 0.42],
    [0.72, 0.68], [0.26, 0.78], [0.14, 0.52], [0.46, 0.12],
    [0.88, 0.70], [0.55, 0.86],
  ];

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const dx = px - cx, dy = py - cy;
      const dist = Math.hypot(dx, dy);

      // —— 徽章：深空径向渐变圆 + 辉光描边 ——
      const disk = smoothStep(R_in - 1, R_in + 1, R - dist);
      if (disk <= 0) {
        // 外圈辉光（淡青紫，仅在近边缘）
        const glow = Math.max(0, 1 - (dist - R) / (S * 0.05)) * 0.35;
        if (glow > 0.01) cv.set(px, py, 124, 176, 255, Math.round(glow * 255));
        continue;
      }
      const t = dist / R; // 0 中心 → 1 边缘
      // 底：中心深蓝紫 → 边缘近黑蓝
      const bgR = 24 + 6 * t, bgG = 18 + 2 * t, bgB = 46 + 4 * t;
      cv.set(px, py, bgR, bgG, bgB, Math.round(disk * 255));

      // —— 极光光球 ——
      const br = R * 0.52;
      const bd = Math.hypot(dx, dy) / br;
      if (bd < 1.25) {
        const core = Math.max(0, 1 - bd); // 球体不透明度
        // 径向渐变：白核心 → 青 → 紫
        const g = smoothStep(0.0, 1.15, bd);
        const cr = 233 + (124 - 233) * g;
        const cg = 244 + (210 - 244) * g;
        const cb = 255 + (250 - 255) * g;
        cv.set(px, py, cr, cg, cb, Math.round(core * 255));
      }

      // —— 斜行星环（神秘科技感）：椭圆环穿过球体 ——
      // 椭圆长轴水平倾斜 -18°，中心略偏右上
      const rx = R * 0.92, ry = R * 0.34;
      const ang = -Math.PI / 10;
      const cosA = Math.cos(ang), sinA = Math.sin(ang);
      const ox = cx + R * 0.10, oy = cy - R * 0.14;
      const ex = (px - ox), ey = (py - oy);
      const rrx = ex * cosA + ey * sinA;
      const rry = -ex * sinA + ey * cosA;
      const ringD = Math.hypot(rrx / rx, rry / ry);
      const ringW = R * 0.016;
      if (Math.abs(ringD - 1) < ringW) {
        const a = smoothStep(ringW, ringW * 0.4, Math.abs(ringD - 1)) * 0.85;
        // 环颜色：青→紫渐变（依环上位置）
        const huePhase = (rrx / rx + 1) / 2;
        const r2 = 129 + (167 - 129) * huePhase;
        const g2 = 235 + (139 - 235) * huePhase;
        const b2 = 254 + (250 - 254) * huePhase;
        cv.set(px, py, r2, g2, b2, Math.round(a * 255));
      }

      // —— 音波弧：从球边缘向外扩散的三条弧（语音） ——
      const arcAlpha = [0.55, 0.4, 0.28];
      const arcR0 = [0.62, 0.74, 0.86]; // 相对 R
      const arcWidth = [0.045, 0.05, 0.055];
      for (let i = 0; i < 3; i++) {
        const r0 = R * arcR0[i];
        const w0 = R * arcWidth[i];
        if (Math.abs(dist - r0) < w0) {
          const theta = Math.atan2(dy, dx);
          // 开口朝左下 130°，左右各 70°
          const openAt = Math.PI * 0.75;
          const spread = Math.PI * 0.42;
          const dTheta = Math.abs(normalizeAngle(theta - openAt));
          if (dTheta < spread) {
            const edge = smoothStep(spread, spread * 0.55, dTheta);
            const a = arcAlpha[i] * edge * smoothStep(w0, w0 * 0.35, Math.abs(dist - r0));
            cv.set(px, py, 125, 225, 255, Math.round(a * 255));
          }
        }
      }

      // —— 星点 ——
      for (const [sx, sy] of star) {
        const sdx = px - sx * S, sdy = py - sy * S;
        const sd = Math.hypot(sdx, sdy);
        const sr = S * 0.0065;
        if (sd < sr * 1.6) {
          const a = smoothStep(sr * 1.6, sr * 0.3, sd) * 0.9;
          cv.set(px, py, 235, 245, 255, Math.round(a * 255));
        }
      }

      // —— 球体左上高光 ——
      const hlx = cx - br * 0.38, hly = cy - br * 0.42;
      const hd = Math.hypot(px - hlx, py - hly) / (br * 0.55);
      if (hd < 1) {
        const a = smoothStep(1, 0, hd) * 0.85;
        cv.set(px, py, 255, 255, 255, Math.round(a * 255));
      }
    }
  }

  return cv.buf;
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/* ---------------------------- 主流程 ---------------------------- */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("drawing 1024 master...");
  const master = drawIcon(SIZE);

  const cache = new Map();
  const rgbaAt = (size) => {
    if (cache.has(size)) return cache.get(size);
    const data = size === SIZE ? master : downsample(master, SIZE, SIZE, size, size);
    cache.set(size, data);
    return data;
  };

  // Windows ICO（Vista+ 支持 PNG 数据）：多尺寸
  const ico = buildICO([256, 128, 64, 48, 32, 24, 16], rgbaAt);
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), ico);
  console.log("assets/icon.ico", ico.length, "bytes");

  // Windows 托盘：小尺寸专用（16/32 保真，深色底在托盘更醒目）
  const trayIco = buildICO([32, 16], rgbaAt);
  fs.writeFileSync(path.join(OUT_DIR, "tray.ico"), trayIco);
  console.log("assets/tray.ico", trayIco.length, "bytes");

  // macOS ICNS：PNG-based types
  const icns = buildICNS([["ic10", 1024], ["ic09", 512], ["ic08", 256], ["ic07", 128]], rgbaAt);
  fs.writeFileSync(path.join(OUT_DIR, "icon.icns"), icns);
  console.log("assets/icon.icns", icns.length, "bytes");

  // 预览/设置页引用用 1024 PNG
  fs.writeFileSync(path.join(OUT_DIR, "icon.png"), encodePNG(SIZE, SIZE, master));
  console.log("assets/icon.png", SIZE, "px");

  console.log("done.");
}

main();
