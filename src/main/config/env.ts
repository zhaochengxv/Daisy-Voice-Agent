import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { app } from "electron";
import dotenv from "dotenv";

function getUserDataEnvPath(): string {
  try {
    return path.join(app.getPath("userData"), "daisy.env");
  } catch {
    return path.join(os.homedir(), ".daisy.env");
  }
}

function findEnvFile(): string | null {
  const userDataEnv = getUserDataEnvPath();
  const candidates = [
    userDataEnv,
    path.join(process.cwd(), "daisy.env"),
    path.join(__dirname, "..", "..", "..", "daisy.env"),
    path.join(__dirname, "..", "..", "daisy.env"),
    path.join(app?.getAppPath?.() || "", "daisy.env"),
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", "..", "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
    path.join(app?.getAppPath?.() || "", ".env"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadEnv(): void {
  const envPath = findEnvFile();
  if (envPath) {
    dotenv.config({ path: envPath });
  }
}

loadEnv();

export function getWritableEnvPath(): string {
  const userDataEnv = getUserDataEnvPath();
  if (fs.existsSync(userDataEnv)) return userDataEnv;
  const found = findEnvFile();
  if (found) {
    try {
      fs.accessSync(found, fs.constants.W_OK);
      return found;
    } catch {
      // bundled file is read-only, fall through to userData
    }
  }
  return userDataEnv;
}

export const config = {
  asr: {
    appId: process.env.VOLCENGINE_APP_ID || "",
    accessToken: process.env.VOLCENGINE_ACCESS_TOKEN || "",
    resourceId: process.env.VOLCENGINE_RESOURCE_ID || "volc.seedasr.sauc.duration",
    wsUrl: process.env.VOLCENGINE_ASR_WS_URL || "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  },
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.AI_TRANSLATION_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || process.env.AI_TRANSLATION_MODEL || "deepseek-v4-flash",
    thinkingEnabled: process.env.DEEPSEEK_THINKING_ENABLED !== "false",
    reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT || "high",
  },
  tts: {
    voice: process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
    rate: process.env.EDGE_TTS_RATE || "+20%",
  },
  whisper: {
    model: process.env.WHISPER_MODEL || "ggml-base.bin",
    shortcutUseWhisper: process.env.SHORTCUT_USE_WHISPER === "true",
  },
  audio: {
    inputDevice: process.env.AUDIO_INPUT_DEVICE || "",
  },
  shortcut: {
    globalShortcut: process.env.GLOBAL_SHORTCUT || "RightOption",
  },
  wakeWord: {
    enabled: process.env.WAKE_WORD_ENABLED !== "false",
    keyword: process.env.WAKE_WORD || "嘿 Daisy",
  },
  firecrawl: {
    apiKey: process.env.FIRECRAWL_API_KEY || "",
  },
  autoLaunch: process.env.AUTO_LAUNCH === "true",
};

export const WHISPER_MODELS: Record<string, { label: string; size: string; url: string; mirror: string }> = {
  "ggml-tiny.bin": {
    label: "Tiny (39MB, 最快)",
    size: "39MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    mirror: "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  },
  "ggml-base.bin": {
    label: "Base (142MB, 推荐)",
    size: "142MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    mirror: "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  },
  "ggml-small.bin": {
    label: "Small (466MB, 最准)",
    size: "466MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    mirror: "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  },
};

export function getWhisperModelPath(modelName?: string): string {
  const name = modelName || config.whisper.model;
  const appPath = app?.getAppPath?.() || "";
  const bundled = path.join(appPath, "assets", "models", name);
  if (fs.existsSync(bundled)) {
    // Resolve asar path to real filesystem path for external binaries (whisper-cli)
    if (appPath.includes(".asar")) {
      const unpacked = bundled.replace(".asar", ".asar.unpacked");
      if (fs.existsSync(unpacked)) return unpacked;
    }
    return bundled;
  }
  return path.join(os.homedir(), "Models", "whisper", name);
}

export function getBundledBin(name: string): string {
  const appPath = app?.getAppPath?.() || "";
  const bundled = path.join(appPath, "assets", "bin", name);
  // Windows 下可执行文件带 .exe 后缀
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  // child_process 不认 asar 虚拟路径，必须优先返回 .asar.unpacked 的真实文件系统路径。
  // 顺序关键：unpacked + exe 在前，否则 Electron 的 asar fs 会让 existsSync 命中 asar 内
  // 的 .exe（Windows 打包产物），spawn 会失败。
  const candidates = [
    ...(appPath.includes(".asar") ? [bundled.replace(".asar", ".asar.unpacked") + exeSuffix] : []),
    bundled + exeSuffix,
    "/opt/homebrew/bin/" + name,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return name + exeSuffix; // fallback to PATH
}

export function getWhisperThreads(): number {
  const cores = os.cpus().length;
  if (cores <= 0) return 2;
  // 单次进程启动时线程争抢会让 -t 过高反而更慢；但至少保留 2 线程，
  // 低配 2 核机器上单线程推理 base 模型会拖到几十秒。
  return Math.min(4, Math.max(2, cores - 1));
}

/**
 * whisper-server 常驻转写的线程数：模型只加载一次，可放心用满多核。
 * 低配(≤4 核)用满全部可用核加速单次推理；高配(8 核+)上限 8 线程，
 * 留余量给 LLM/TTS/系统，避免推理时整体卡顿。
 */
export function getWhisperServerThreads(): number {
  const cores = os.cpus().length;
  if (cores <= 0) return 2;
  if (cores >= 8) return 8;
  return Math.max(2, cores - 1);
}

/**
 * Windows 打包仅含 CPU 后端 DLL（ggml-cpu-*.dll）。whisper 默认 use_gpu=true，
 * 在无 GPU 后端时初始化仍走 GPU 路径，导致 ACCESS_VIOLATION (0xC0000005) 段错误
 * 反复崩溃，必须显式 -ng 禁 GPU。macOS 上保留默认（Apple Silicon Metal GPU 加速，
 * 强制 CPU 会显著拖慢推理），故 -ng 仅 Windows 生效。
 */
export function whisperNeedsNoGpu(): boolean {
  return process.platform === "win32";
}

export function expectedWhisperModelBytes(modelName: string): number {
  const size = WHISPER_MODELS[modelName]?.size || "";
  const match = size.match(/^(\d+)\s*MB/i);
  if (!match) return 0;
  return parseInt(match[1], 10) * 1024 * 1024;
}

export function getWhisperBackendName(cpuModel = os.cpus()[0]?.model || ""): string | null {
  if (/Apple M1\b/i.test(cpuModel)) return "libggml-cpu-apple_m1.so";
  if (/Apple M[23]\b/i.test(cpuModel)) return "libggml-cpu-apple_m2_m3.so";
  if (/Apple M\d+\b/i.test(cpuModel)) return "libggml-cpu-apple_m4.so";
  return null;
}

export function getWhisperExecutionEnv(cliPath = getBundledBin("whisper-cli")): NodeJS.ProcessEnv {
  const backendName = getWhisperBackendName();
  if (!backendName || !path.isAbsolute(cliPath)) return process.env;

  const backendPath = path.resolve(path.dirname(cliPath), "..", "lib", backendName);
  if (!fs.existsSync(backendPath)) return process.env;

  return {
    ...process.env,
    GGML_BACKEND_PATH: backendPath,
  };
}

export function isAsrConfigured(): boolean {
  return Boolean(config.asr.appId && config.asr.accessToken);
}

export function isLlmConfigured(): boolean {
  return Boolean(config.llm.apiKey);
}
