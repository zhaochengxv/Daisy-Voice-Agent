import { describe, it, expect, vi, beforeEach } from "vitest";

// v1.5.10 修复：monitor 之前把裸 PCM 传给 whisperServer，server /inference 只接受
// 合法 WAV（FormData file=audio.wav），真机日志反复 `inference HTTP 400` 的根因。
// 这里 mock whisperServer，断言 processAudio 实际收到的是带 RIFF/WAVE 头的 WAV。
const transcribeMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/asr/whisperServer", () => ({
  whisperServer: { transcribe: transcribeMock },
}));

import { WakeWordMonitor } from "../src/main/wakeword/monitor";

const SAMPLE_RATE = 16000;

function buildFrame(amplitude: number): Buffer {
  // 16kHz mono s16le，10ms/帧 = 320 字节 = 160 个采样
  const buf = Buffer.alloc(320);
  for (let i = 0; i < buf.length; i += 2) {
    buf.writeInt16LE(amplitude, i);
  }
  return buf;
}

describe("WakeWordMonitor whisper-server 传参（v1.5.10 WAV 修复）", () => {
  beforeEach(() => {
    transcribeMock.mockReset();
    transcribeMock.mockResolvedValue("hey daisy");
  });

  it("processAudio 传给 whisperServer 的是带 RIFF/WAVE 头的 WAV，而非裸 PCM", async () => {
    const monitor = new WakeWordMonitor("嘿 Daisy");
    monitor.start();

    // 50 帧响音（500ms，共 16000 字节达到 MIN_AUDIO_BYTES）触发 speechStart 起音
    for (let i = 0; i < 50; i++) monitor.feedPcm(buildFrame(8000));
    // 250 帧静音（2500ms > 2000ms silenceEnd）结束本轮录音并触发转写
    for (let i = 0; i < 250; i++) monitor.feedPcm(buildFrame(0));

    // processAudio 是 fire-and-forget，等待 mock 被调用
    await vi.waitFor(() => {
      expect(transcribeMock).toHaveBeenCalled();
    }, { timeout: 5000 });

    expect(transcribeMock).toHaveBeenCalledTimes(1);
    const [sentBuffer] = transcribeMock.mock.calls[0] as [Buffer];

    // 必须是合法 WAV：RIFF + WAVE + fmt 块
    expect(sentBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(sentBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(sentBuffer.subarray(12, 16).toString("ascii")).toBe("fmt ");
    expect(sentBuffer.readUInt16LE(22)).toBe(1); // mono
    expect(sentBuffer.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(sentBuffer.subarray(36, 40).toString("ascii")).toBe("data");
    // data 长度 = 全部音频字节（不带 44 字节头）
    expect(sentBuffer.readUInt32LE(40)).toBe(sentBuffer.length - 44);
  });
});
