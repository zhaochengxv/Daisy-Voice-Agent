import { describe, it, expect } from "vitest";
import { isWakeWordMatch, VAD } from "../src/main/wakeword/monitor";
import { deriveModelName, volcanoHttpHint } from "../src/main/asr/index";

describe("isWakeWordMatch（v1.5.9 唤醒词方言/假名误识别）", () => {
  it("中文前缀 + 中文黛西", () => {
    expect(isWakeWordMatch("嘿黛西")).toBe(true);
    expect(isWakeWordMatch("嘿 黛西 帮我查天气")).toBe(true);
  });

  it("英文前缀 + daisy 变体", () => {
    expect(isWakeWordMatch("hey daisy")).toBe(true);
    expect(isWakeWordMatch("hello daisy, 打开音乐")).toBe(true);
    expect(isWakeWordMatch("hi daysi")).toBe(true);
    expect(isWakeWordMatch("hey daizy")).toBe(true);
  });

  it("whisper.cpp 把 hey daisy 误识别为日文假名（真机实测 'かいで'）", () => {
    expect(isWakeWordMatch("かいで")).toBe(true);
    expect(isWakeWordMatch("カイデ")).toBe(true);
    expect(isWakeWordMatch("ハイデイジー")).toBe(true);
    expect(isWakeWordMatch("ヘイデイジ")).toBe(true);
  });

  it("拼音近似", () => {
    expect(isWakeWordMatch("hei dai zi")).toBe(true);
  });

  it("普通语音不含唤醒词不误触发", () => {
    expect(isWakeWordMatch("今天天气怎么样")).toBe(false);
    expect(isWakeWordMatch("帮我打开音乐")).toBe(false);
    expect(isWakeWordMatch("好的")).toBe(false);
  });
});

describe("VAD 阈值（v1.5.9 从 0.02 放宽到 0.012）", () => {
  // 16kHz mono s16le：10ms/帧 = 320 字节
  function buildPcm(amplitude: number, frames = 32): Buffer {
    const buf = Buffer.alloc(320 * frames);
    for (let i = 0; i < buf.length; i += 2) {
      const sample = Math.round(amplitude * 32767);
      buf.writeInt16LE(sample, i);
    }
    return buf;
  }

  it("静音基线收敛后，0.015 的突发轻声可越过 0.012 阈值触发起音（旧阈值 0.02 则不行）", () => {
    const vad = new VAD();
    // 先喂 50 帧静音让 noiseFloor 收敛到接近 0.0005，threshold 落到下限 0.012
    for (let i = 0; i < 50; i++) {
      vad.feed(buildPcm(0.0005, 1));
    }
    // 突发语音 0.015：0.015 > 0.012 → speechStart
    const event = vad.feed(buildPcm(0.015, 1));
    expect(event.speechStart).toBe(true);
  });

  it("环境静音(全零帧)不误判为起音", () => {
    const vad = new VAD();
    const event = vad.feed(Buffer.alloc(320));
    expect(event.speechStart).toBe(false);
  });

  it("静音基线收敛后，突发 0.008 的远场语音可越过 0.002 阈值下限触发（v1.5.11 下界从 0.012 放宽）", () => {
    const vad = new VAD();
    for (let i = 0; i < 50; i++) {
      vad.feed(buildPcm(0.0005, 1));
    }
    const event = vad.feed(buildPcm(0.008, 1));
    expect(event.speechStart).toBe(true);
  });

  it("静音基线收敛后，突发 0.0015 仍低于 0.002 阈值下限不触发", () => {
    const vad = new VAD();
    for (let i = 0; i < 50; i++) {
      vad.feed(buildPcm(0.0005, 1));
    }
    const event = vad.feed(buildPcm(0.0015, 1));
    expect(event.speechStart).toBe(false);
  });

  it("reset 后恢复初值", () => {
    const vad = new VAD();
    vad.feed(buildPcm(0.5, 32));
    vad.reset();
    const event = vad.feed(Buffer.alloc(320));
    expect(event.speechStart).toBe(false);
  });
});

describe("火山 ASR model_name 推导（v1.5.9 修复 403）", () => {
  it("从 wsUrl 路径末段推导 model_name", () => {
    expect(deriveModelName("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async")).toBe("bigmodel_async");
    expect(deriveModelName("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel")).toBe("bigmodel");
  });

  it("非法 URL 默认免费版 bigmodel", () => {
    expect(deriveModelName("not-a-url")).toBe("bigmodel");
    expect(deriveModelName("")).toBe("bigmodel");
  });
});

describe("volcanoHttpHint（v1.5.9 状态码透传）", () => {
  it("403 给出鉴权排查方向", () => {
    const hint = volcanoHttpHint(403, "", "wss://x/api/v3/sauc/bigmodel");
    expect(hint).toContain("403");
    expect(hint).toContain("RESOURCE_ID");
    expect(hint).toContain("volc.seedasr.sauc.duration");
    expect(hint).toContain("volc.bigasr.sauc.duration");
  });

  it("401 提示 token 过期", () => {
    expect(volcanoHttpHint(401, "", "")).toContain("重新生成");
  });

  it("附加 body 片段", () => {
    expect(volcanoHttpHint(403, "InvalidAppId", "")).toContain("InvalidAppId");
  });

  it("未知状态码给通用提示", () => {
    expect(volcanoHttpHint(502, "", "")).toContain("502");
  });
});
