import { describe, it, expect, vi } from "vitest";

// vision 模块读取 config.vision（env），这里隔离 process.env
vi.mock("../src/main/config/env", () => ({
  config: {
    vision: {
      apiKey: "",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.6v-flash",
      maxTokens: "512",
      backupApiKey: "",
      backupBaseUrl: "https://api.siliconflow.cn/v1",
      backupModel: "Qwen/Qwen2.5-VL-7B-Instruct",
    },
  },
  log: vi.fn(),
}));

const os = await import("node:os");
const fs = await import("node:fs");
const path = await import("node:path");

import { isVisionConfigured, analyzeImage, formatImageUrl, isRetryableVisionError } from "../src/main/vision/index";

describe("视觉理解工具（v1.5.13 默认智谱 GLM-4.6V-Flash）", () => {
  it("智谱平台传裸 base64，豆包等其他平台传标准 data URI", () => {
    const b64 = "AAAA";
    expect(formatImageUrl("https://open.bigmodel.cn/api/paas/v4", "image/png", b64)).toBe(b64);
    expect(formatImageUrl("https://ark.cn-beijing.volces.com/api/v3", "image/jpeg", b64)).toBe(
      "data:image/jpeg;base64,AAAA"
    );
    expect(formatImageUrl("https://api.openai.com/v1", "image/webp", b64)).toMatch(/^data:image\/webp;base64,/);
  });

  it("未配置视觉模型时 isVisionConfigured 为 false", () => {
    expect(isVisionConfigured()).toBe(false);
  });

  it("未配置视觉模型时 analyzeImage 抛出免费智谱配置引导", async () => {
    // 用系统存在的文件避免路径解析失败干扰断言
    const tmp = path.join(os.tmpdir(), `daisy-vision-test-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([137, 80, 78, 71]));
    try {
      await expect(analyzeImage(tmp)).rejects.toThrow(/GLM-4.6V-Flash/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("不存在的图片路径给出明确错误", async () => {
    await expect(analyzeImage("/no/such/file-xyz.png")).rejects.toThrow(/文件不存在/);
  });

  it("拥挤/过载/限流类错误判定为可重试", () => {
    expect(isRetryableVisionError(429, "")).toBe(true);
    expect(isRetryableVisionError(503, "")).toBe(true);
    expect(isRetryableVisionError(504, "upstream timeout")).toBe(true);
    expect(isRetryableVisionError(200, "1305 platform overload")).toBe(true);
    expect(isRetryableVisionError(200, "1302 rate limit")).toBe(true);
    expect(isRetryableVisionError(200, "当前请求繁忙，请稍后重试")).toBe(true);
    expect(isRetryableVisionError(401, "invalid api key")).toBe(false);
    expect(isRetryableVisionError(404, "model not found")).toBe(false);
  });
});
