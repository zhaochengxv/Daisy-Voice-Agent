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

/** 按 CPU 核数推荐默认唤醒词模型：高配(8 核+)用 Small 提准确率，低配默认 Base 保响应。 */
export function defaultWhisperModel(): string {
  const cores = os.cpus().length;
  return cores >= 8 ? "ggml-small.bin" : "ggml-base.bin";
}

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
  // 视觉理解（图片/视频关键帧）：独立于 DeepSeek 的 OpenAI 兼容视觉模型。
  // 默认智谱 GLM-4.6V-Flash（官方免费、支持视觉推理与 128K 上下文）；
  // 若改回豆包：baseUrl=https://ark.cn-beijing.volces.com/api/v3，model=doubao-seed-2-1-turbo-260628
  //（注意：doubao-seed-1-6-vision-250815 已官方下线不可用，Seed 2.x 系列均支持多模态视觉）。
  // 未配置时 analyze_image/analyze_video 返回引导提示，不阻塞其他功能。
  vision: {
    apiKey: process.env.VISUAL_API_KEY || "",
    baseUrl: process.env.VISUAL_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    model: process.env.VISUAL_MODEL || "glm-4.6v-flash",
    maxTokens: process.env.VISUAL_MAX_TOKENS || "2048",
    // 备用视觉供应商（可选）：免费模型高峰期限流时自动降级切换，保证识别可用。
    // 推荐硅基流动（cloud.siliconflow.cn，注册送额度）：baseUrl=https://api.siliconflow.cn/v1，
    // model=Qwen/Qwen2.5-VL-7B-Instruct（或 Qwen/Qwen3-VL-8B-Instruct）。
    backupApiKey: process.env.VISUAL_BACKUP_API_KEY || "",
    backupBaseUrl: process.env.VISUAL_BACKUP_BASE_URL || "https://api.siliconflow.cn/v1",
    backupModel: process.env.VISUAL_BACKUP_MODEL || "Qwen/Qwen2.5-VL-7B-Instruct",
  },
  tts: {
    voice: process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural",
    rate: process.env.EDGE_TTS_RATE || "+20%",
  },
  whisper: {
    model: process.env.WHISPER_MODEL || defaultWhisperModel(),
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
  // 悬浮球形态与智能收纳：FLOAT_DEFAULT_MODE=standard|mini，FLOAT_AUTO_COLLAPSE 默认开启
  float: {
    defaultMode: process.env.FLOAT_DEFAULT_MODE === "mini" ? "mini" : "standard",
    autoCollapse: process.env.FLOAT_AUTO_COLLAPSE !== "false",
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

/** userData 下的 GPU 版 whisper 组件目录（可选 CUDA 一键部署，无需写 Program Files） */
export function getWhisperGpuBinDir(): string {
  try {
    return path.join(app.getPath("userData"), "whisper-gpu", "bin");
  } catch {
    return path.join(os.homedir(), ".daisy-whisper-gpu");
  }
}

/** 是否已部署 GPU 版 whisper（以 bin 目录存在 ggml-cuda.dll 为准，仅 win32 有意义） */
export function hasWhisperGpu(): boolean {
  if (process.platform !== "win32") return false;
  return fs.existsSync(path.join(getWhisperGpuBinDir(), "ggml-cuda.dll"));
}

/**
 * whisper 二进制查找：GPU 版优先（userData/whisper-gpu），其次打包 CPU 版。
 * 非 win32 或未部署 GPU 时等价于 getBundledBin。
 */
export function getWhisperBin(name: string): string {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  if (hasWhisperGpu()) {
    const gpuBin = path.join(getWhisperGpuBinDir(), name + exeSuffix);
    if (fs.existsSync(gpuBin)) return gpuBin;
  }
  return getBundledBin(name);
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
 * 决定 whisper 是否强制 CPU 推理（-ng）。
 *
 * Windows 默认打包为官方 CPU 版（仅 ggml-cpu-*.dll，无 ggml-cuda.dll）。
 * 该构建下 use_gpu=true 会在 GPU 后端初始化路径触发 ACCESS_VIOLATION
 * (0xC0000005) 段错误反复崩溃（v1.5.6 真机复现），必须 -ng。
 *
 * 高配 N 卡用户可在设置页一键部署 CUDA 组件到 userData/whisper-gpu/bin
 * （出现 ggml-cuda.dll），此时自动放行 GPU。macOS 保留默认（Metal GPU），不判 -ng。
 */
export function whisperNeedsNoGpu(): boolean {
  if (process.platform !== "win32") return false;
  return !hasWhisperGpu();
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
