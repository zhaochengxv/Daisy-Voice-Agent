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

// GitHub 大文件直连在国内经常超时/被限速。镜像（前缀代理）速度远优于直连，
// 因此按「镜像优先 → 直连兜底」的顺序尝试，任一成功即采用。
// 镜像域名会不定期变动，作为尽力而为的降级路径，全部失败则提示手动下载。
const GH_MIRRORS = [
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://ghproxy.net/",
  "https://gh.llkk.cc/",
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
const CONNECT_TIMEOUT_MS = 30000; // 建立连接/首包超时
const IDLE_TIMEOUT_MS = 60000;    // 两次数据块之间超时（慢速网络降级）
const TOTAL_TIMEOUT_MS = 480000;  // 单源整体时间预算：镜像一般几分钟内完成，
                                  // 直连兜底也可能需要 5 分钟+，防止涓流永久卡 0%
const MAX_REDIRECTS = 4;

/** 下载进度信息（供 UI 展示字节数/速率，避免只看整数百分比而长时间停在 0%） */
export interface GpuDownloadProgress {
  source: string;
  received: number;
  total: number;
  speed: number; // bytes/s，滚动估算
}

/** 单次下载一个源，返回 zip 本地路径 */
function downloadFrom(
  url: string,
  zipPath: string,
  onProgress?: (progress: GpuDownloadProgress) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(zipPath, { flags: "w" });
    let received = 0;
    let done = false;
    let redirects = 0;
    // 速率估算：最近 5 个采样（每约 1MB 一次）的滑动窗口
    const samples: { t: number; bytes: number }[] = [];
    let startedAt = Date.now();

    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      file.close();
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      reject(err);
    };

    const fetchOnce = (target: string): void => {
      const req = https.get(
        target,
        { headers: { "User-Agent": USER_AGENT, Accept: "*/*" } },
        (response) => {
          const code = response.statusCode || 0;
          if ((code === 301 || code === 302 || code === 303 || code === 307 || code === 308) && response.headers.location) {
            response.resume();
            redirects++;
            if (redirects > MAX_REDIRECTS) {
              fail(new Error("重定向次数过多"));
              return;
            }
            // 相对重定向拼接完整 URL
            const next = new URL(response.headers.location, target).toString();
            fetchOnce(next);
            return;
          }
          if (code !== 200) {
            response.resume();
            fail(new Error(`HTTP ${code}`));
            return;
          }
          const total = parseInt(response.headers["content-length"] || "0", 10);
          startedAt = Date.now();
          response.setTimeout(IDLE_TIMEOUT_MS, () => {
            response.destroy();
            fail(new Error("下载超时（长时间无数据）"));
          });
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            const now = Date.now();
            if (received - samples[0]?.bytes >= 1024 * 1024 || samples.length === 0) {
              samples.push({ t: now, bytes: received });
              if (samples.length > 5) samples.shift();
            }
            const speed = (() => {
              if (samples.length < 2) return 0;
              const span = samples[samples.length - 1].t - samples[0].t;
              if (span <= 0) return 0;
              return Math.round((samples[samples.length - 1].bytes - samples[0].bytes) / span * 1000);
            })();
            if (total > 0) {
              onProgress?.({ source: target, received, total, speed });
            }
            // 背压：写缓冲满时暂停读取，等待 drain，避免大文件内存膨胀
            if (!file.write(chunk)) {
              response.pause();
              file.once("drain", () => response.resume());
            }
          });
          response.on("end", () => file.end());
          response.on("error", (err) => fail(err));
        }
      );
      req.setTimeout(CONNECT_TIMEOUT_MS, () => {
        req.destroy(new Error("连接超时"));
      });
      // 整体时间预算：即使数据在涓流，超过预算也换源，避免用户看到长期 0%
      const budgetTimer = setTimeout(() => {
        req.destroy(new Error("下载过慢（超过时间预算）"));
      }, TOTAL_TIMEOUT_MS);
      budgetTimer.unref?.();
      req.on("error", (err) => fail(err));
    };

    file.on("error", (err) => fail(err));
    file.on("finish", () => {
      if (done) return;
      done = true;
      const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      log(`whisperGpu: downloaded ${received} bytes from ${url} in ${seconds}s`);
      resolve();
    });

    fetchOnce(url);
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
 * 镜像优先（国内速度快）→ 直连 GitHub 兜底；每源带连接超时、空闲读超时与整体时间预算。
 */
export async function downloadWhisperGpuComponent(
  onProgress?: (progress: GpuDownloadProgress) => void
): Promise<string> {
  // 镜像优先，直连 GitHub 放最后（国内直连最慢）
  const sources = [...GH_MIRRORS.map((m) => `${m}${ZIP_URL}`), ZIP_URL];
  let lastError: Error | null = null;
  for (const src of sources) {
    const zipPath = path.join(os.tmpdir(), `daisy-${ZIP_NAME}`);
    log(`whisperGpu: trying ${src}`);
    // 定期（每约 10%）记录一次进度，便于真机日志定位卡点
    let lastLoggedPct = 0;
    try {
      await downloadFrom(src, zipPath, (progress) => {
        const pct = Math.floor((progress.received / progress.total) * 1000) / 10;
        if (pct - lastLoggedPct >= 10) {
          lastLoggedPct = pct;
          log(`whisperGpu: ${pct}% (${progress.received}/${progress.total} bytes)`);
        }
        onProgress?.({ ...progress, source: src });
      });
      validateZip(zipPath);
      return zipPath;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logError(`whisperGpu: source failed ${src}`, lastError);
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      if (onProgress) onProgress({ source: src, received: 0, total: 0, speed: 0 });
    }
  }
  throw new Error(
    `下载失败（${lastError?.message || "未知错误"}）。可手动下载 ${ZIP_URL} 后重试。`
  );
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
