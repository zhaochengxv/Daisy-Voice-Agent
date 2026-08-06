import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { getWhisperGpuBinDir } from "../config/env";
import { runPowerShell } from "../utils/windowsShell";
import { log, logError } from "../utils/logger";

const CUBLAS_VERSION = "12.4.0";
const ZIP_NAME = `whisper-cublas-${CUBLAS_VERSION}-bin-x64.zip`;
const GH_BASE = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2";
const ZIP_URL = `${GH_BASE}/${ZIP_NAME}`;

// GitHub 大文件直连在国内经常超时/被限速。镜像（前缀代理）速度远优于直连。
// 镜像域名会不定期变动，这里尽量多备几组并全部并行探测，取最快者分片下载；
// 全部过慢时引导用户用浏览器/下载器手动下载（支持断点续传，往往远快于 Node https）。
const GH_MIRRORS = [
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://ghproxy.net/",
  "https://gh.llkk.cc/",
  "https://ghproxy.cc/",
  "https://gitproxy.click/",
  "https://gh.ddlc.top/",
  "https://ghps.cc/",
];

/** 从 cublas zip 提取并平铺到 userData/whisper-gpu/bin 的必要文件（其余 bench/stream 等工具丢弃） */
const REQUIRED_FILES = [
  "whisper-server.exe",
  "whisper-cli.exe",
  "whisper.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-cpu-x64.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-cascadelake.dll",
  "ggml-cuda.dll",
  "cublas64_12.dll",
  "cublasLt64_12.dll",
  "cudart64_12.dll",
  "nvblas64_12.dll",
  "nvrtc-builtins64_124.dll",
  "nvrtc64_120_0.dll",
];

const USER_AGENT = "Daisy-Voice-Agent/1.5.23";
const CONNECT_TIMEOUT_MS = 15000; // 建立连接/首包超时
const IDLE_TIMEOUT_MS = 30000;    // 两次数据块之间超时（分片级，快速失败换源）
const MAX_REDIRECTS = 4;
const PROBE_BYTES = 512 * 1024;   // 测速采样字节数（512KB）
const PROBE_TIMEOUT_MS = 4000;    // 测速时长上限
const PART_BYTES = 16 * 1024 * 1024; // 每个分片 16MB：进度平滑 + 快速换源
const WORKERS_PER_SOURCE = 3;     // 每个可用源开 3 个并发连接（聚合带宽）
const MAX_SOURCES = 3;            // 同时使用的源数（多源聚合带宽）
const SLOW_SOURCE_KBPS = 150;     // 全部源低于此速率时引导手动下载（670MB 需 >1 小时）
const SLOW_DOWNLOAD_MS = 300000;  // 下载 5 分钟内未达 5% 即判定过慢，切换手动引导

/** 下载进度信息（供 UI 展示字节数/速率，避免只看整数百分比而长时间停在 0%） */
export interface GpuDownloadProgress {
  source: string;
  received: number;
  total: number;
  speed: number; // bytes/s
}

/** 探测结果：某个源是否可用、总大小与测速速率 */
interface SourceProbe {
  url: string;        // 原始请求 URL（日志/进度展示）
  finalUrl: string;   // 跟随重定向后的实际承载 URL
  total: number;      // 文件总字节数
  speed: number;      // 测速 bytes/s
  supportsRange: boolean; // 支持 Range（206）→ 可参与分片
}

/**
 * 网络过慢错误：全部镜像源速率太低，自动下载需要数小时。
 * 携带可手动下载的 URL 与本地期望文件名，供 UI 引导用户用浏览器/下载器下载。
 */
export class SlowNetworkError extends Error {
  readonly url: string;
  readonly fileName: string;
  readonly expectedSize: number;
  constructor(url: string, fileName: string, expectedSize: number) {
    super(`网络较慢：自动下载预计耗时过长，建议使用浏览器/下载器手动下载`);
    this.name = "SlowNetworkError";
    this.url = url;
    this.fileName = fileName;
    this.expectedSize = expectedSize;
  }
}

/** 用户手动下载 zip 的本地探测候选目录（下载/桌面/临时） */
/** 用户手动下载 zip 的本地探测候选目录（仅用户可触达的下载/桌面目录） */
function manualDownloadCandidates(): string[] {
  const dirs: string[] = [];
  const home = os.homedir();
  dirs.push(path.join(home, "Downloads"));
  dirs.push(path.join(home, "Desktop"));
  dirs.push(path.join(home, "下载"));
  dirs.push(path.join(home, "桌面"));
  if (process.env.USERPROFILE) {
    dirs.push(path.join(process.env.USERPROFILE, "Downloads"));
    dirs.push(path.join(process.env.USERPROFILE, "Desktop"));
  }
  return Array.from(new Set(dirs));
}

/** 期望 zip 完整大小（字节）。用于拦截半成品残留：上次下载失败的 tmp 残留也 >1MB 且带 PK 魔数，
 *  仅凭魔数校验会把它误认为「手动下载好的文件」→ 跳过真实下载 → 解压失败 → 死循环。 */
const EXPECTED_ZIP_BYTES = 670611449;

/** 校验 zip 是否完整：PK 魔数 + 尾部 EOCD 记录（PK\x05\x06）+ 大小接近预期。
 *  半成品/中断下载的 zip 缺 EOCD，或大小远小于预期，会被识别为损坏而丢弃。 */
function isCompleteZip(full: string): boolean {
  let st;
  try { st = fs.statSync(full); } catch { return false; }
  if (st.size < EXPECTED_ZIP_BYTES * 0.9) return false;
  const fd = fs.openSync(full, "r");
  try {
    // 头部 PK\x03\x04
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    if (!(head[0] === 0x50 && head[1] === 0x4b)) return false;
    // 尾部 EOCD（PK\x05\x06），允许最多 64KB 注释区
    const tailLen = Math.min(st.size, 22 + 65535);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
        return true;
      }
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 扫描常见目录，找用户手动下载好的 GPU zip（支持别名：daisy- 前缀 / whisper-cublas-*）。
 * 只认完整 zip（EOCD + 大小接近预期），半成品/损坏文件一律忽略并删除，
 * 避免上次下载失败的残留被误用而阻塞真实下载。找到返回完整路径；找不到返回 null。
 */
export function findLocalGpuZip(): string | null {
  const names = [`daisy-${ZIP_NAME}`, ZIP_NAME];
  for (const dir of manualDownloadCandidates()) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (!fs.existsSync(full)) continue;
        if (!isCompleteZip(full)) {
          // 半成品/损坏文件：删除并继续，防止死循环复用
          log(`whisperGpu: discarding incomplete zip ${full}`);
          try { fs.unlinkSync(full); } catch { /* ignore */ }
          continue;
        }
        return full;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/** 跟随重定向发起 HTTPS GET，返回最终响应与最终 URL */
function httpsGetFollow(
  url: string,
  headers: Record<string, string>
): Promise<{ res: import("node:http").IncomingMessage; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    const attempt = (target: string, depth: number) => {
      const req = https.get(target, { headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers } }, (res) => {
        const code = res.statusCode || 0;
        if ((code === 301 || code === 302 || code === 303 || code === 307 || code === 308) && res.headers.location) {
          res.resume();
          if (depth >= MAX_REDIRECTS) { reject(new Error("重定向次数过多")); return; }
          attempt(new URL(res.headers.location, target).toString(), depth + 1);
          return;
        }
        resolve({ res, finalUrl: target });
      });
      req.setTimeout(CONNECT_TIMEOUT_MS, () => { req.destroy(new Error("连接超时")); });
      req.on("error", reject);
    };
    attempt(url, 0);
  });
}

/** 并行探测所有源：连接 + 首 512KB 测速 + 判断 Range 支持 */
async function probeSources(sources: string[]): Promise<SourceProbe[]> {
  const results = await Promise.all(
    sources.map(async (url): Promise<SourceProbe | null> => {
      try {
        const { res, finalUrl } = await httpsGetFollow(url, { Range: `bytes=0-${PROBE_BYTES - 1}` });
        const code = res.statusCode || 0;
        if (code !== 200 && code !== 206) {
          res.resume();
          return null;
        }
        // 206 时 content-range 带文件总长；200（忽略 Range）时 content-length 即总长
        let total = 0;
        const cr = res.headers["content-range"];
        if (cr) {
          const m = /\/\s*(\d+)/.exec(cr);
          if (m) total = parseInt(m[1], 10);
        }
        if (total <= 0) total = parseInt(res.headers["content-length"] || "0", 10);
        let received = 0;
        const t0 = Date.now();
        res.on("data", (c: Buffer) => {
          received += c.length;
          if (received >= PROBE_BYTES) res.destroy();
        });
        await new Promise<void>((finish) => {
          res.on("end", () => finish());
          res.on("close", () => finish());
          res.on("error", () => finish());
          setTimeout(() => { try { res.destroy(); } catch { /* ignore */ } finish(); }, PROBE_TIMEOUT_MS);
        });
        const elapsed = (Date.now() - t0) / 1000;
        const speed = elapsed > 0 ? received / elapsed : 0;
        if (received <= 0 || total <= 0) return null;
        return { url, finalUrl, total, speed, supportsRange: code === 206 };
      } catch {
        return null;
      }
    })
  );
  return results.filter((p): p is SourceProbe => p !== null);
}

/** 下载一个分片 [start,end] 到 partPath；源忽略 Range（200）且非首片时视为失败 */
function downloadPart(target: SourceProbe, start: number, end: number, partPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(partPath, { flags: "w" });
    let done = false;
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      file.close();
      try { fs.unlinkSync(partPath); } catch { /* ignore */ }
      reject(err);
    };
    httpsGetFollow(target.finalUrl, { Range: `bytes=${start}-${end}` })
      .then(({ res }) => {
        const code = res.statusCode || 0;
        if (code === 200 && start > 0) {
          // 源忽略 Range 返回全量：从 start 起写入会错位，视为不支持 Range
          res.resume();
          fail(new Error("该源不支持断点续传"));
          return;
        }
        if (code !== 200 && code !== 206) {
          res.resume();
          fail(new Error(`HTTP ${code}`));
          return;
        }
        res.setTimeout(IDLE_TIMEOUT_MS, () => {
          res.destroy();
          fail(new Error("分片下载超时（长时间无数据）"));
        });
        res.on("data", (chunk: Buffer) => {
          if (!file.write(chunk)) {
            res.pause();
            file.once("drain", () => res.resume());
          }
        });
        res.on("end", () => file.end());
        res.on("error", fail);
      })
      .catch(fail);
    file.on("error", fail);
    file.on("finish", () => {
      if (done) return;
      done = true;
      resolve();
    });
  });
}

/** 按序拼接全部分片为最终 zip，合并后删除分片 */
function mergeParts(zipPath: string, partPaths: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    let index = 0;
    const next = (): void => {
      if (index >= partPaths.length) {
        out.end();
        return;
      }
      const part = partPaths[index++];
      const rs = fs.createReadStream(part);
      rs.on("error", reject);
      rs.on("end", () => {
        try { fs.unlinkSync(part); } catch { /* ignore */ }
        next();
      });
      rs.pipe(out, { end: false });
    };
    out.on("error", reject);
    out.on("finish", resolve);
    next();
  });
}

/** 校验下载完成的 zip 魔数（PK\x03\x04）与最小体积，防止缓存损坏文件被解压 */
function validateZip(zipPath: string): void {
  const stat = fs.statSync(zipPath);
  if (stat.size < 1024 * 1024) {
    throw new Error(`下载文件过小（${stat.size} bytes），视为失败`);
  }
  const fd = fs.openSync(zipPath, "r");
  const buf = Buffer.alloc(4);
  try {
    fs.readSync(fd, buf, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  // ZIP 本地文件头魔数 PK\x03\x04；极少数空 zip 为 PK\x05\x06（不应出现在本场景）
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new Error("下载文件不是有效的 ZIP（魔数校验失败）");
  }
}

/**
 * 下载官方 CUDA 版 whisper（约 670MB），返回本地 zip 路径，进度经 onProgress 上报。
 *
 * 网络策略（v1.5.23 用户反馈：单个镜像源串行尝试 + 超长超时，用户网络下三源全废、
 * 干等十几分钟）。本实现改为：
 * 1. 所有源【并行】探测连接与测速（≤4s），瞬时找出可用源，绝不串行干等；
 * 2. 取最快的若干源，按 16MB 分片【并发下载】——哪个源快谁多干活，带宽聚合；
 * 3. 任一分片失败立即【换源续传】（Range 断点），不重头再来；
 * 4. 探测后全部源速率过低（预计 >1 小时）时抛 SlowNetworkError，
 *    引导用户用浏览器/下载器手动下载（断点续传+多线程远快于 Node https）。
 * 5. 全部分片完成后按序拼接 + 校验 zip 魔数。
 */
export async function downloadWhisperGpuComponent(
  onProgress?: (progress: GpuDownloadProgress) => void
): Promise<string> {
  // 优先复用用户手动下载好的 zip（仅下载/桌面目录，且必须是完整 zip；tmp 残留早已被排除）
  const local = findLocalGpuZip();
  if (local) {
    log(`whisperGpu: found locally downloaded zip at ${local}, skipping download`);
    return local;
  }

  const sources = [...GH_MIRRORS.map((m) => `${m}${ZIP_URL}`), ZIP_URL];
  const zipPath = path.join(os.tmpdir(), `daisy-${ZIP_NAME}`);
  // 清理 tmp 下载目标的旧残留（上次中断的半成品），避免 merge 写入已有文件时损坏或误判
  try { if (fs.existsSync(zipPath)) { fs.unlinkSync(zipPath); log(`whisperGpu: cleaned stale download target ${zipPath}`); } } catch { /* ignore */ }

  log(`whisperGpu: probing ${sources.length} sources in parallel`);
  const probes = await probeSources(sources);
  const available = probes
    .filter((p) => p.speed > 0)
    .sort((a, b) => b.speed - a.speed);
  if (available.length === 0) {
    throw new Error(`所有下载源均不可用。可手动下载 ${ZIP_URL} 后重试。`);
  }
  log(
    `whisperGpu: ${available.length} source(s) available: ` +
    available.map((p) => `${p.url} ${(p.speed / 1024).toFixed(0)}KB/s${p.supportsRange ? " (range)" : ""}`).join(", ")
  );

  const total = available[0].total;
  // 聚合估算速率（最快的 MAX_SOURCES 个源 × 并发数），低于阈值则手动下载
  const bestSources = available.slice(0, MAX_SOURCES);
  const aggSpeed = bestSources.reduce((sum, p) => sum + p.speed * WORKERS_PER_SOURCE, 0);
  if (aggSpeed < SLOW_SOURCE_KBPS * 1024) {
    throw new SlowNetworkError(ZIP_URL, ZIP_NAME, total);
  }
  const rangeSources = available.filter((p) => p.supportsRange);
  const workers: { url: string }[] = [];

  if (rangeSources.length > 0) {
    // 多源分片并发：取最快的源，每源 WORKERS_PER_SOURCE 个并发连接
    const active = rangeSources.slice(0, MAX_SOURCES);
    for (const src of active) {
      for (let i = 0; i < WORKERS_PER_SOURCE; i++) workers.push({ url: src.url });
    }

    const partPaths: string[] = [];
    const partCount = Math.ceil(total / PART_BYTES);
    const parts = Array.from({ length: partCount }, (_, i) => {
      const start = i * PART_BYTES;
      const end = i === partCount - 1 ? total - 1 : Math.min(start + PART_BYTES - 1, total - 1);
      return { index: i, start, end, done: false };
    });
    partPaths.push(...parts.map((p) => `${zipPath}.part${p.index}`));

    const report = { received: 0 };
    let cursor = 0;
    const pickNext = (): { index: number; start: number; end: number; done: boolean } | null => {
      while (cursor < parts.length && parts[cursor].done) cursor++;
      if (cursor >= parts.length) return null;
      return parts[cursor];
    };

    const t0 = Date.now();
    // 慢速看门狗：5 分钟内未达 5% 说明实际速率远低于探测值（探测快慢仅 512KB），
    // 立即中止并转手动下载，避免用户再等数小时。
    const abort = { current: false };
    const abortReason = { slow: false };
    const slowTimer = setTimeout(() => {
      const elapsed = Math.max(1, (Date.now() - t0) / 1000);
      const kbps = Math.round(report.received / elapsed / 1024);
      const pct = report.received / total;
      if (pct < 0.05) {
        logError(`whisperGpu: download too slow (${kbps}KB/s, ${(pct * 100).toFixed(1)}% in ${Math.round(elapsed)}s), switching to manual guidance`, undefined);
        abort.current = true;
        abortReason.slow = true;
      }
    }, SLOW_DOWNLOAD_MS);
    slowTimer.unref?.();

    await Promise.all(
      workers.map(async (worker, wi) => {
        let part: { index: number; start: number; end: number; done: boolean } | null;
        while ((part = pickNext()) !== null && !abort.current) {
          const partIdx = part.index;
          let success = false;
          // 换源重试：先从最快的源开始，失败后轮换其余源
          for (let attempt = 0; attempt <= active.length; attempt++) {
            const src = active[(wi + attempt) % active.length];
            try {
              await downloadPart(src, part.start, part.end, `${zipPath}.part${partIdx}`);
              success = true;
              break;
            } catch (err) {
              logError(`whisperGpu: part ${partIdx} from ${src.url} failed`, err);
            }
          }
          if (!success && !abort.current) {
            throw new Error(`下载失败：分片 ${partIdx} 所有源重试均失败`);
          }
          part.done = true;
          report.received += part.end - part.start + 1;
          const elapsed = Math.max(1, (Date.now() - t0) / 1000);
          const pct = Math.floor((report.received / total) * 1000) / 10;
          log(`whisperGpu: ${pct}% (${report.received}/${total} bytes, ${Math.round(report.received / elapsed / 1024)}KB/s)`);
          onProgress?.({
            source: worker.url,
            received: report.received,
            total,
            speed: Math.round(report.received / elapsed),
          });
        }
      })
    );
    clearTimeout(slowTimer);

    if (abort.current) {
      // 清理半成品分片，避免下次误用
      for (const p of partPaths) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      if (abortReason.slow) {
        throw new SlowNetworkError(ZIP_URL, ZIP_NAME, total);
      }
      throw new Error("下载被中止");
    }

    await mergeParts(zipPath, partPaths);
    log(`whisperGpu: merged ${partCount} parts -> ${zipPath}`);
  } else {
    // 无源支持 Range：退化为单源整包下载（首个最快源）
    const src = available[0];
    log(`whisperGpu: no Range support, falling back to single-source download from ${src.url}`);
    const t0 = Date.now();
    await downloadWhole(src, zipPath, (received) => {
      const elapsed = Math.max(1, (Date.now() - t0) / 1000);
      onProgress?.({
        source: src.url,
        received,
        total,
        speed: Math.round(received / elapsed),
      });
    });
  }

  validateZip(zipPath);
  return zipPath;
}

/** 单源整包下载（无 Range 支持时的兜底路径） */
function downloadWhole(
  target: SourceProbe,
  zipPath: string,
  onChunk: (received: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath, { flags: "w" });
    let received = 0;
    let done = false;
    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      file.close();
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      reject(err);
    };
    httpsGetFollow(target.finalUrl, {})
      .then(({ res }) => {
        const code = res.statusCode || 0;
        if (code !== 200) {
          res.resume();
          fail(new Error(`HTTP ${code}`));
          return;
        }
        res.setTimeout(IDLE_TIMEOUT_MS, () => {
          res.destroy();
          fail(new Error("下载超时（长时间无数据）"));
        });
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          onChunk(received);
          if (!file.write(chunk)) {
            res.pause();
            file.once("drain", () => res.resume());
          }
        });
        res.on("end", () => file.end());
        res.on("error", fail);
      })
      .catch(fail);
    file.on("error", fail);
    file.on("finish", () => {
      if (done) return;
      done = true;
      resolve();
    });
  });
}

/** 从 PowerShell 抛出的错误中提取 stderr，便于把真实失败原因透传 UI */
function extractPowerShellStderr(error: unknown): string {
  if (error instanceof Error) {
    const err = error as Error & { stderr?: string; code?: number };
    const parts: string[] = [];
    if (err.message) parts.push(err.message);
    if (err.stderr) parts.push(String(err.stderr).trim());
    return parts.join(" | ").slice(0, 500);
  }
  return String(error);
}

/** 带重试的拷贝：Windows 下目标 DLL 可能被 transient 锁占用（杀软/索引服务） */
function copyWithRetry(src: string, dest: string): void {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      fs.copyFileSync(src, dest);
      return;
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
      // 文件锁占用：等 300ms 重试，最多等 1.2s
      const waitMs = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waitMs, 0, 0, 300);
    }
  }
}

/** 解压 cublas zip，把 Release/ 下必需文件平铺到 userData/whisper-gpu/bin */
export async function extractWhisperGpuComponent(zipPath: string): Promise<void> {
  const binDir = getWhisperGpuBinDir();
  fs.mkdirSync(binDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-gpu-x-"));
  try {
    // Expand-Archive 对超大 zip 较慢，放宽超时；失败重试一次（transient 网络/磁盘抖动）
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      log(`whisperGpu: extracting (attempt ${attempt}) ${zipPath} -> ${tmpDir}`);
      try {
        await runPowerShell(
          `Expand-Archive -LiteralPath $env:DAISY_ARG0 -DestinationPath $env:DAISY_ARG1 -Force`,
          { args: [zipPath, tmpDir], timeoutMs: 180000 }
        );
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        logError(`whisperGpu: Expand-Archive failed (attempt ${attempt})`, error);
        // 清理不完整解压产物后重试
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
        if (attempt < 2) {
          const waitMs = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(waitMs, 0, 0, 800);
        }
      }
    }
    if (lastError !== null) {
      throw new Error(`解压失败：${extractPowerShellStderr(lastError)}`);
    }

    const releaseDir = path.join(tmpDir, "Release");
    let copied = 0;
    for (const file of REQUIRED_FILES) {
      const src = path.join(releaseDir, file);
      if (fs.existsSync(src)) {
        copyWithRetry(src, path.join(binDir, file));
        copied++;
      } else {
        log(`whisperGpu: missing in zip: ${file}`);
      }
    }
    if (copied === 0) throw new Error("zip 中未找到 Release 目录，解压失败");
    // 部署后验证关键产物，确认 GPU 路径真的可用了
    const gpuDll = path.join(binDir, "ggml-cuda.dll");
    if (!fs.existsSync(gpuDll)) {
      throw new Error("解压完成但缺少 ggml-cuda.dll，部署失败");
    }
    log(`whisperGpu: extracted ${copied} files to ${binDir} (ggml-cuda.dll verified)`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 删除已部署的 GPU 组件（需先 dispose whisper-server 释放 DLL 占用） */
export function removeWhisperGpuComponent(): void {
  fs.rmSync(getWhisperGpuBinDir(), { recursive: true, force: true });
  log("whisperGpu: removed GPU component");
}

export function gpuComponentDownloaded(): boolean {
  return fs.existsSync(path.join(getWhisperGpuBinDir(), "ggml-cuda.dll"));
}
