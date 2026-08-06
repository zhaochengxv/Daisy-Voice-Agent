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

// GitHub 大文件直连在国内经常超时/被限速。按顺序逐个尝试：
// 直连 → 多个社区 GitHub 加速镜像（前缀代理），任一成功即采用。
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

const USER_AGENT = "Daisy-Voice-Agent/1.5.22";
const CONNECT_TIMEOUT_MS = 30000; // 建立连接/首包超时
const IDLE_TIMEOUT_MS = 60000;    // 两次数据块之间超时（慢速网络降级）
const MAX_REDIRECTS = 4;

/** 单次下载一个源，返回 zip 本地路径 */
function downloadFrom(
  url: string,
  zipPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(zipPath, { flags: "w" });
    let received = 0;
    let done = false;
    let redirects = 0;

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
          response.setTimeout(IDLE_TIMEOUT_MS, () => {
            response.destroy();
            fail(new Error("下载超时（长时间无数据）"));
          });
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (total > 0) {
              onProgress?.(Math.min(99, Math.round((received / total) * 100)));
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
      req.on("error", (err) => fail(err));
    };

    file.on("error", (err) => fail(err));
    file.on("finish", () => {
      if (done) return;
      done = true;
      log(`whisperGpu: downloaded ${received} bytes from ${url}`);
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
 * 下载官方 CUDA 版 whisper（约 670MB），返回本地 zip 路径，进度 0-100 经 onProgress 上报。
 * 多源回退：直连 GitHub → 国内加速镜像依次尝试；每源带连接超时与空闲读超时。
 */
export async function downloadWhisperGpuComponent(
  onProgress?: (percent: number) => void
): Promise<string> {
  const sources = [ZIP_URL, ...GH_MIRRORS.map((m) => `${m}${ZIP_URL}`)];
  let lastError: Error | null = null;
  for (const src of sources) {
    const zipPath = path.join(os.tmpdir(), `daisy-${ZIP_NAME}`);
    log(`whisperGpu: trying ${src}`);
    try {
      await downloadFrom(src, zipPath, onProgress);
      validateZip(zipPath);
      return zipPath;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logError(`whisperGpu: source failed ${src}`, lastError);
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      if (onProgress) onProgress(0);
    }
  }
  throw new Error(
    `下载失败（${lastError?.message || "未知错误"}）。可手动下载 ${ZIP_URL} 后重试。`
  );
}

/** 解压 cublas zip，把 Release/ 下必需文件平铺到 userData/whisper-gpu/bin */
export async function extractWhisperGpuComponent(zipPath: string): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-gpu-x-"));
  try {
    // Expand-Archive 对超大 zip 较慢，放宽超时；失败抛错由调用方提示。
    await runPowerShell(
      `Expand-Archive -LiteralPath $env:DAISY_ARG0 -DestinationPath $env:DAISY_ARG1 -Force`,
      { args: [zipPath, tmpDir], timeoutMs: 180000 }
    );
    const binDir = getWhisperGpuBinDir();
    fs.mkdirSync(binDir, { recursive: true });
    const releaseDir = path.join(tmpDir, "Release");
    let copied = 0;
    for (const file of REQUIRED_FILES) {
      const src = path.join(releaseDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(binDir, file));
        copied++;
      } else {
        log(`whisperGpu: missing in zip: ${file}`);
      }
    }
    if (copied === 0) throw new Error("zip 中未找到 Release 目录，解压失败");
    log(`whisperGpu: extracted ${copied} files to ${binDir}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
