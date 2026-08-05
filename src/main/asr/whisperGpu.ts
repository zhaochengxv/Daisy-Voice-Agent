import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWhisperGpuBinDir } from "../config/env";
import { runPowerShell } from "../utils/windowsShell";
import { log } from "../utils/logger";

const CUBLAS_VERSION = "12.4.0";
const ZIP_NAME = `whisper-cublas-${CUBLAS_VERSION}-bin-x64.zip`;
const ZIP_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/${ZIP_NAME}`;

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

/** 下载官方 CUDA 版 whisper（~670MB），返回本地 zip 路径，进度 0-100 经 onProgress 上报 */
export async function downloadWhisperGpuComponent(
  onProgress?: (percent: number) => void
): Promise<string> {
  const zipPath = path.join(os.tmpdir(), `daisy-${ZIP_NAME}`);
  log(`whisperGpu: downloading ${ZIP_URL}`);
  try {
    const res = await fetch(ZIP_URL, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`download failed: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get("content-length") || 0);
    const out = fs.createWriteStream(zipPath);
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (total > 0) onProgress?.(Math.min(99, Math.round((received / total) * 100)));
      out.write(value);
    }
    await new Promise<void>((resolve, reject) => {
      out.end();
      out.on("finish", resolve);
      out.on("error", reject);
    });
    onProgress?.(100);
    log(`whisperGpu: downloaded ${received} bytes`);
    return zipPath;
  } catch (error) {
    fs.promises.unlink(zipPath).catch(() => {});
    throw error;
  }
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
