import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/main/config/env", () => ({
  config: {
    vision: {
      apiKey: "zhipu-key",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.6v-flash",
      maxTokens: "512",
      backupApiKey: "silicon-key",
      backupBaseUrl: "https://api.siliconflow.cn/v1",
      backupModel: "Qwen/Qwen2.5-VL-7B-Instruct",
    },
  },
  log: vi.fn(),
}));

const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

import { analyzeImage, resetVisionBreaker } from "../src/main/vision/index";

function makeTmpImage(): string {
  const p = path.join(os.tmpdir(), `daisy-vision-fallback-${Date.now()}.png`);
  fs.writeFileSync(p, Buffer.from([137, 80, 78, 71]));
  return p;
}

describe("视觉双供应商自动降级（v1.5.15 拥挤→切备用）", () => {
  const calls: string[] = [];
  let tmp: string;

  beforeEach(() => {
    calls.length = 0;
    tmp = makeTmpImage();
    resetVisionBreaker();
  });
  afterEach(() => fs.rmSync(tmp, { force: true }));

  function stubFetchWithHandler(handler: (url: string) => Promise<Response>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        calls.push(String(url));
        return handler(String(url));
      })
    );
  }

  const okResp = (text: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;

  it("首选(智谱)拥挤 429 时自动降级到备用(硅基)并返回结果", async () => {
    stubFetchWithHandler(async (url) => {
      if (url.includes("bigmodel.cn")) {
        return new Response('{"error":"当前请求繁忙"}', { status: 429 }) as unknown as Response;
      }
      return okResp("这是硅基流动识别的结果");
    });
    const text = await analyzeImage(tmp);
    expect(text).toContain("硅基流动");
    // 智谱至少请求一次、硅基请求一次
    expect(calls.some((u) => u.includes("bigmodel.cn"))).toBe(true);
    expect(calls.some((u) => u.includes("siliconflow.cn"))).toBe(true);
  });

  it("首选请求成功时不会调用备用", async () => {
    stubFetchWithHandler(async (url) => {
      if (url.includes("bigmodel.cn")) return okResp("智谱识别成功");
      return okResp("备用");
    });
    const text = await analyzeImage(tmp);
    expect(text).toContain("智谱");
    expect(calls.some((u) => u.includes("siliconflow.cn"))).toBe(false);
  });

  it("首选无效 Key(401) 不重试、直接切备用", async () => {
    stubFetchWithHandler(async (url) => {
      if (url.includes("bigmodel.cn")) {
        return new Response('{"error":"invalid api key"}', { status: 401 }) as unknown as Response;
      }
      return okResp("备用成功");
    });
    const text = await analyzeImage(tmp);
    expect(text).toContain("备用");
    // 401 不重试：智谱只被调 1 次
    expect(calls.filter((u) => u.includes("bigmodel.cn")).length).toBe(1);
  });

  it("首选与备用均拥挤时抛出明确错误", async () => {
    stubFetchWithHandler(async () => new Response('{"error":"服务繁忙"}', { status: 503 }) as unknown as Response);
    await expect(analyzeImage(tmp)).rejects.toThrow(/首选与备用均不可用/);
  });
});
