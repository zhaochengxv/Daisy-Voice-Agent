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
  return Boolean(config.vision.apiKey);
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

async function callVisionModel(imagePaths: string[], question: string): Promise<string> {
  if (!isVisionConfigured()) {
    throw new Error(
      "视觉模型未配置：请在设置页「视觉理解」填入 API Key（推荐免费方案：智谱 bigmodel.cn 的 GLM-4.6V-Flash，注册即可用）"
    );
  }
  const baseUrl = (config.vision.baseUrl || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, "");
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: question || "请详细描述这张图片的内容。" },
  ];
  for (const imgPath of imagePaths) {
    const mime = MIME_BY_EXT[path.extname(imgPath).toLowerCase()] || "image/png";
    const b64 = fs.readFileSync(imgPath).toString("base64");
    content.push({ type: "image_url", image_url: { url: formatImageUrl(baseUrl, mime, b64) } });
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.vision.apiKey}`,
    },
    body: JSON.stringify({
      model: config.vision.model,
      messages: [{ role: "user", content }],
      max_tokens: Number(config.vision.maxTokens || 512),
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`视觉模型请求失败(HTTP ${resp.status})：${body.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const contentStr = data.choices?.[0]?.message?.content?.trim() || "";
  if (!contentStr) throw new Error("视觉模型返回为空");
  return contentStr;
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
