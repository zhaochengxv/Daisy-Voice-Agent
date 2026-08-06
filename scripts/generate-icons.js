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

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 确定性随机（mulberry32），保证每次构建图标一致 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * 液态玻璃极光水晶球（v2 高逼格版）：
 *   深邃太空圆徽 + 3D 光照水晶球 + 内部封印极光（青/紫/粉）+ 玻璃菲涅尔壳
 *   + 真实穿越球体的斜行星环（前方覆盖/后方被遮）+ 声波弧 + 弥散星光
 */
function drawIcon(size) {
  const cv = createCanvas(size);
  const S = size;
  const cx = S / 2, cy = S / 2;

  // 徽章圆半径，球体略偏上给行星环留视觉重心
  const R = S * 0.47;
  const bcx = cx;
  const bcy = cy - R * 0.015;
  const br = R * 0.55;

  // 预生成星点（位置/大小/亮度确定性随机）
  const rand = mulberry32(20260806);
  const stars = [];
  for (let i = 0; i < 34; i++) {
    const a = rand() * Math.PI * 2;
    const rr = R * (0.12 + rand() * 0.8);
    stars.push({
      x: cx + Math.cos(a) * rr,
      y: cy + Math.sin(a) * rr * 0.96,
      r: S * (0.0018 + rand() * 0.0036),
      a: 0.28 + rand() * 0.5,
      big: rand() > 0.8,
    });
  }

  // 内部极光色斑（相对球心偏移 / 半径比例 / RGB）
  const blobs = [
    { dx: -0.26, dy: -0.10, r: 0.58, cr: 64, cg: 238, cb: 255 },  // 青
    { dx: 0.24, dy: 0.22, r: 0.66, cr: 145, cg: 92, cb: 246 },     // 紫
    { dx: 0.04, dy: -0.42, r: 0.42, cr: 246, cg: 118, cb: 182 },   // 粉
  ];

  // 斜行星环（真实 3D 穿越：环下方朝观察者覆盖球体，环上方被球遮）
  const ox = cx + R * 0.04;
  const oy = cy - R * 0.02;
  const ringRx = R * 0.90, ringRy = R * 0.265;
  const ringAng = -0.30;
  const cosA = Math.cos(ringAng), sinA = Math.sin(ringAng);
  const ringW = R * 0.014;

  // 音波弧
  const arcR0 = [1.20, 1.36, 1.54]; // 相对 br
  const arcAlpha = [0.55, 0.42, 0.30];
  const arcWidth = [0.020, 0.024, 0.028]; // 相对 br

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const dx = px - cx, dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // —— 0. 外圈环境辉光（青紫，仅近边缘，先画可被徽章底覆盖） ——
      if (dist > R) {
        const g = Math.max(0, 1 - (dist - R) / (R * 0.16));
        const ga = g * g * 0.42;
        if (ga > 0.015) cv.set(px, py, 96, 182, 255, Math.round(ga * 255));
        continue;
      }

      const t = dist / R; // 0 中心 → 1 边缘

      // —— 1. 徽章深空底：中心紫蓝 → 边缘近黑 ——
      let r = lerp(46, 16, t), g = lerp(36, 10, t), b = lerp(96, 30, t);
      // 内缘微光：徽章边缘一圈青紫描边
      const rimD = R - dist;
      if (rimD < S * 0.016) {
        const ra = smoothStep(0, S * 0.016, rimD) * 0.5;
        r = lerp(r, 118, ra); g = lerp(g, 186, ra); b = lerp(b, 255, ra);
      }

      // —— 2. 弥散星光（在球体后，中心区会被球盖住） ——
      for (let si = 0; si < stars.length; si++) {
        const st = stars[si];
        const sdx = px - st.x, sdy = py - st.y;
        const sd2 = sdx * sdx + sdy * sdy;
        const rr2 = st.r * 2.2;
        if (sd2 < rr2 * rr2) {
          const sd = Math.sqrt(sd2);
          const sa = smoothStep(st.r * 2.2, st.r * 0.4, sd) * st.a;
          const br2 = st.big ? 0.95 : 0.72;
          r = lerp(r, 250 * br2, sa); g = lerp(g, 252 * br2, sa); b = lerp(b, 255 * br2, sa);
        }
      }

      // 徽章底落盘（后续球/环/弧半透明叠加）
      cv.set(px, py, Math.round(r), Math.round(g), Math.round(b), 255);

      // —— 3. 液态玻璃水晶球 ——
      const bdx = px - bcx, bdy = py - bcy;
      const bdist = Math.sqrt(bdx * bdx + bdy * bdy);
      const bd = bdist / br;

      if (bd < 1.06) {
        const nx = bdist > 0.0001 ? bdx / bdist : 0;
        const ny = bdist > 0.0001 ? bdy / bdist : 0;
        // 3D 漫反射：主光源位于左上（-0.55, -0.83）
        const diff = Math.max(0, nx * -0.55 + ny * -0.83);
        const diffS = diff * diff;
        let cr = lerp(88, 222, diffS);      // 紫蓝 → 亮青
        let cg = lerp(84, 248, diffS);
        let cb = lerp(190, 255, diffS);

        // 内部封印极光色斑
        for (let bi = 0; bi < blobs.length; bi++) {
          const bl = blobs[bi];
          const bldx = (px - (bcx + bl.dx * br)) / (br * bl.r);
          const bldy = (py - (bcy + bl.dy * br)) / (br * bl.r);
          const bld2 = bldx * bldx + bldy * bldy;
          if (bld2 < 1.8) {
            const ba = smoothStep(1.34, 0, Math.sqrt(bld2)) * 0.52;
            cr = lerp(cr, bl.cr, ba); cg = lerp(cg, bl.cg, ba); cb = lerp(cb, bl.cb, ba);
          }
        }

        // 玻璃壳：边缘菲涅尔亮边（bd→1 时最亮），制造立体玻璃感
        const fres = bd * bd * bd * bd;
        cr = lerp(cr, 214, fres * 0.9);
        cg = lerp(cg, 246, fres * 0.9);
        cb = lerp(cb, 255, fres * 0.9);

        // 玻璃盖顶部弧光：球内偏上的一条椭圆亮带（模拟壳面反光）
        const arcx = (px - (bcx - br * 0.10)) / (br * 0.78);
        const arcy = (py - (bcy - br * 0.10)) / (br * 0.66);
        const arcD = Math.sqrt(arcx * arcx + arcy * arcy);
        if (arcD > 0.82 && arcD < 1.02) {
          const w = smoothStep(0.82, 0.86, arcD) * smoothStep(1.02, 0.96, arcD);
          const topHalf = ny < -0.05;
          if (topHalf) {
            cr = lerp(cr, 255, w * 0.55); cg = lerp(cg, 255, w * 0.55); cb = lerp(cb, 255, w * 0.55);
          }
        }

        // 底部次表面透光：球下缘内侧一圈淡蓝（光从底部反弹）
        if (ny > 0.25 && bd > 0.55) {
          const sss = smoothStep(0.55, 1.0, bd) * Math.max(0, ny);
          cr = lerp(cr, 150, sss * 0.4); cg = lerp(cg, 210, sss * 0.4); cb = lerp(cb, 255, sss * 0.4);
        }

        // 球体边缘羽化（bd 0.96~1.06 过渡），中心不透明
        const ballA = smoothStep(1.06, 0.98, bd);
        cv.set(px, py, Math.round(cr), Math.round(cg), Math.round(cb), Math.round(ballA * 255));
      }

      // —— 4. 斜行星环（真实穿越） ——
      const ex = px - ox, ey = py - oy;
      const rrx = ex * cosA + ey * sinA;
      const rry = -ex * sinA + ey * cosA;
      const rD = Math.sqrt((rrx * rrx) / (ringRx * ringRx) + (rry * rry) / (ringRy * ringRy));
      if (Math.abs(rD - 1) < ringW * 3.2) {
        const inFront = rry >= 0;                    // 环下方朝观察者
        const hiddenByBall = !inFront && bd < 0.98;  // 环后方且处于球内 → 被球遮
        if (!hiddenByBall) {
          const core = smoothStep(ringW * 3.2, ringW * 0.5, Math.abs(rD - 1));
          // 环色沿椭圆周 青→紫→青 循环渐变
          const phase = ((rrx / ringRx) + 1) / 2;
          let cr2, cg2, cb2;
          if (phase < 0.5) {
            const p = phase * 2;
            cr2 = lerp(96, 196, p); cg2 = lerp(238, 118, p); cb2 = lerp(255, 246, p);
          } else {
            const p = (phase - 0.5) * 2;
            cr2 = lerp(196, 96, p); cg2 = lerp(118, 238, p); cb2 = lerp(246, 255, p);
          }
          const a2 = core * (inFront ? 0.92 : 0.6);
          cv.set(px, py, Math.round(cr2), Math.round(cg2), Math.round(cb2), Math.round(a2 * 255));
        }
        // 环外光晕（柔和扩散）
        if (Math.abs(rD - 1) > ringW * 0.5) {
          const haloA = Math.max(0, 1 - Math.abs(rD - 1) / (ringW * 3.2)) * 0.14;
          if (haloA > 0.01) cv.set(px, py, 120, 220, 255, Math.round(haloA * 255));
        }
      }

      // —— 5. 声波弧：球右侧三条细弧（语音意象） ——
      const th = Math.atan2(dy, dx);
      for (let i = 0; i < 3; i++) {
        const r0 = br * arcR0[i];
        const w0 = br * arcWidth[i];
        if (Math.abs(dist - r0) < w0 * 2) {
          const spread = Math.PI * 0.40;
          const dTh = Math.abs(normalizeAngle(th));
          if (dTh < spread) {
            const edge = smoothStep(spread, spread * 0.55, dTh);
            const a3 = arcAlpha[i] * edge * smoothStep(w0 * 2, w0 * 0.45, Math.abs(dist - r0));
            if (a3 > 0.01) cv.set(px, py, 150, 242, 255, Math.round(a3 * 255));
          }
        }
      }

      // —— 6. 主镜面高光（球体左上小圆斑，玻璃真实感的点睛） ——
      const hlx = bcx - br * 0.40, hly = bcy - br * 0.42;
      const hdx = px - hlx, hdy = py - hly;
      const hd = Math.sqrt(hdx * hdx + hdy * hdy) / (br * 0.24);
      if (hd < 1.35 && bd < 1.05) {
        const ha = smoothStep(1.35, 0, hd);
        const halo = ha * 0.35;
        const core = ha * ha * 0.85;
        if (bd < 1) {
          if (core > 0.02) cv.set(px, py, 255, 255, 255, Math.min(255, Math.round(core * 255)));
          if (halo > 0.03 && ha > 0.55) cv.set(px, py, 235, 248, 255, Math.round(halo * 255));
        }
      }
    }
  }

  return cv.buf;
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
