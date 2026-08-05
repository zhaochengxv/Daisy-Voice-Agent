import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegStaticPath from "ffmpeg-static";
import { config } from "../config/env";
import { log } from "../utils/logger";

const execFileAsync = promisify(execFile);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/**
 * 构造视觉模型的 image_url：智谱开放平台要求裸 base64，
 * 其余 OpenAI 兼容平台（豆包/通义/OpenAI）用标准 data URI。
 */
export function formatImageUrl(baseUrl: string, mime: string, b64: string): string {
  return /bigmodel\.cn/i.test(baseUrl) ? b64 : `data:${mime};base64,${b64}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 视觉供应商：首选 + 可选备用（免费模型高峰期限流时自动降级） */
interface VisionProvider {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: string;
}

function listProviders(): VisionProvider[] {
  const providers: VisionProvider[] = [];
  if (config.vision.apiKey) {
    providers.push({
      name: "首选",
      apiKey: config.vision.apiKey,
      baseUrl: config.vision.baseUrl || "https://open.bigmodel.cn/api/paas/v4",
      model: config.vision.model || "glm-4.6v-flash",
      maxTokens: config.vision.maxTokens || "512",
    });
  }
  if (config.vision.backupApiKey) {
    providers.push({
      name: "备用",
      apiKey: config.vision.backupApiKey,
      baseUrl: config.vision.backupBaseUrl || "https://api.siliconflow.cn/v1",
      model: config.vision.backupModel || "Qwen/Qwen2.5-VL-7B-Instruct",
      maxTokens: config.vision.maxTokens || "512",
    });
  }
  return providers;
}

/** 是否属于「拥挤/过载/限流」类可重试错误（智谱免费模型高峰期的典型形态） */
export function isRetryableVisionError(status: number, body: string): boolean {
  const low = body.toLowerCase();
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /1302|1305|busy|overload|too many|rate\s*limit|拥挤|繁忙|过载|请求过多|服务繁忙/.test(low)
  );
}

function getFfmpegPath(): string {
  if (!ffmpegStaticPath) return "ffmpeg";
  if (ffmpegStaticPath.includes(".asar")) {
    const unpacked = ffmpegStaticPath.replace(".asar", ".asar.unpacked");
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return ffmpegStaticPath;
}

/** 视觉模型是否已配置（未配置时工具给出引导而非报错） */
export function isVisionConfigured(): boolean {
  return Boolean(config.vision.apiKey || config.vision.backupApiKey);
}

function resolveImagePath(input: string): string {
  const p = String(input).replace(/^["']|["']$/g, "").replace(/^~/, os.homedir());
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  if (!fs.existsSync(abs)) {
    // 常见桌面/下载兜底
    const home = path.join(os.homedir(), "Desktop", p);
    if (fs.existsSync(home)) return home;
    throw new Error(`文件不存在：${input}`);
  }
  return abs;
}

/** 单次请求单供应商，返回解析后的正文 */
async function requestOnce(provider: VisionProvider, content: Array<Record<string, unknown>>): Promise<string> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content }],
      max_tokens: Number(provider.maxTokens || 512),
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw { status: resp.status, body };
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const contentStr = data.choices?.[0]?.message?.content?.trim() || "";
  if (!contentStr) throw new Error("视觉模型返回为空");
  return contentStr;
}

/** 拥挤重试 + 双供应商自动降级：免费模型高峰期 429/503 时自动切备用供应商 */
async function callVisionModel(imagePaths: string[], question: string): Promise<string> {
  const providers = listProviders();
  if (providers.length === 0) {
    throw new Error(
      "视觉模型未配置：请在设置页「视觉理解」填入 API Key（推荐免费方案：智谱 bigmodel.cn 的 GLM-4.6V-Flash，注册即可用）"
    );
  }

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: question || "请详细描述这张图片的内容。" },
  ];
  for (const imgPath of imagePaths) {
    const mime = MIME_BY_EXT[path.extname(imgPath).toLowerCase()] || "image/png";
    const b64 = fs.readFileSync(imgPath).toString("base64");
    content.push({ type: "image_url", image_url: { url: formatImageUrl(providers[0].baseUrl, mime, b64) } });
  }

  let lastErr: unknown;
  for (const provider of providers) {
    const maxAttempts = provider === providers[0] ? 3 : 2; // 首选多试，备用兜底试 2 次
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const text = await requestOnce(provider, content);
        if (provider !== providers[0]) log(`vision: 首选拥挤，已降级到备用供应商 ${provider.name}(${provider.model})`);
        return text;
      } catch (err) {
        lastErr = err;
        const { status = 0, body = "" } = err as { status?: number; body?: string };
        const retryable = isRetryableVisionError(status, body);
        if (!retryable) break; // 非拥挤类错误（如 key 无效/模型不存在），直接切下一个供应商
        if (attempt < maxAttempts) {
          await sleep(700 * attempt); // 指数退避，等限流窗口过去
          continue;
        }
        log(`vision: ${provider.name}供应商(${provider.model}) 拥挤重试 ${maxAttempts} 次后仍失败`);
      }
    }
    // 当前供应商失败，落到下一个
  }

  const e = lastErr as { status?: number; body?: string };
  const detail = e?.body ? e.body.slice(0, 300) : String(lastErr);
  const hasBackup = providers.length > 1;
  throw new Error(
    `视觉模型请求失败${hasBackup ? "（首选与备用均不可用）" : ""}(HTTP ${e?.status ?? "?"})：${detail}`
  );
}

/** 图片理解：读取本地图片 → 视觉模型 → 返回描述/回答 */
export async function analyzeImage(imagePath: string, question?: string): Promise<string> {
  const abs = resolveImagePath(imagePath);
  const text = await callVisionModel([abs], question || "请详细描述这张图片的内容，包括主体、文字、场景与风格。");
  log(`vision.analyzeImage: ${abs} -> ${text.slice(0, 80)}...`);
  return text;
}

/** 视频理解：ffmpeg 等间隔抽 3~5 帧 → 视觉模型逐帧理解 → 汇总 */
export async function analyzeVideo(videoPath: string, question?: string): Promise<string> {
  const abs = resolveImagePath(videoPath);
  const ffmpeg = getFfmpegPath();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-vision-"));
  const framePattern = path.join(tmpDir, "frame-%02d.jpg");

  // 探测时长，按时长分配帧数（3~5 帧），避免首帧必抓
  let duration = 0;
  try {
    const { stderr } = await execFileAsync(ffmpeg, ["-i", abs], { timeout: 15000, encoding: "utf8" });
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    // 探测失败也不阻断，抽帧命令会报错并回退
  }

  const frameCount = Math.min(5, Math.max(3, Math.ceil(duration / 20)));
  const fps = frameCount / Math.max(duration, 1); // 均匀采样，至少保证出帧

  try {
    const { stderr } = await execFileAsync(
      ffmpeg,
      ["-y", "-i", abs, "-vf", `fps=${fps.toFixed(4)}`, "-frames:v", String(frameCount), "-q:v", "4", framePattern],
      { timeout: 90000 }
    );
    log(`vision.analyzeVideo: extracted frames (${stderr.trim().slice(-120)})`);
  } catch (error) {
    const err = error as Error;
    throw new Error(`视频抽帧失败（该文件可能不是可解码视频）：${err.message.slice(0, 200)}`);
  }

  const frames = fs
    .readdirSync(tmpDir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(tmpDir, f));

  if (frames.length === 0) throw new Error("视频抽帧失败：未生成任何帧");

  try {
    const q = question || "请根据这些视频关键帧，总结视频内容：场景、人物/主体、发生的事件、画面里的文字信息。";
    const text = await callVisionModel(frames, q);
    return text;
  } finally {
    // 阅后即焚：抽帧临时目录立即清理
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
