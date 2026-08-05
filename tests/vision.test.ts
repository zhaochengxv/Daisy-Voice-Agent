import { describe, it, expect, vi } from "vitest";

// vision 模块读取 config.vision（env），这里隔离 process.env
vi.mock("../src/main/config/env", () => ({
  config: {
    vision: {
      apiKey: "",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "doubao-seed-1-6-vision-250815",
      maxTokens: "512",
    },
  },
  log: vi.fn(),
}));

const os = await import("node:os");
const fs = await import("node:fs");
const path = await import("node:path");

import { isVisionConfigured, analyzeImage } from "../src/main/vision/index";

describe("视觉理解工具（v1.5.12 analyze_image/analyze_video）", () => {
  it("未配置视觉模型时 isVisionConfigured 为 false", () => {
    expect(isVisionConfigured()).toBe(false);
  });

  it("未配置视觉模型时 analyzeImage 抛出配置引导而非空返回", async () => {
    // 用系统存在的文件避免路径解析失败干扰断言
    const tmp = path.join(os.tmpdir(), `daisy-vision-test-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.from([137, 80, 78, 71]));
    try {
      await expect(analyzeImage(tmp)).rejects.toThrow(/VISUAL_API_KEY/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("不存在的图片路径给出明确错误", async () => {
    await expect(analyzeImage("/no/such/file-xyz.png")).rejects.toThrow(/文件不存在/);
  });
});
