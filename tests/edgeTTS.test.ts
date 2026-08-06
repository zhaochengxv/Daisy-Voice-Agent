import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidMp3 } from "../src/main/tts/edgeTTS";

function writeTmp(buf: Buffer): string {
  const p = path.join(os.tmpdir(), `mp3-test-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(p, buf);
  return p;
}

describe("isValidMp3", () => {
  it("识别 ID3 标签头（Edge TTS 正常输出）", () => {
    const buf = Buffer.alloc(2048);
    buf.write("ID3", 0, "latin1");
    expect(isValidMp3(writeTmp(buf))).toBe(true);
  });

  it("识别 MPEG 帧同步字 0xFF 0xEx", () => {
    const buf = Buffer.alloc(2048);
    buf[0] = 0xff;
    buf[1] = 0xfb; // MPEG-1 Layer III
    expect(isValidMp3(writeTmp(buf))).toBe(true);
  });

  it("拒绝过小文件（<1KB，限流期坏响应体）", () => {
    expect(isValidMp3(writeTmp(Buffer.from("ID3")))).toBe(false);
  });

  it("拒绝随机字节（HTML 错误页等非 MP3 内容）", () => {
    const buf = Buffer.alloc(2048);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31) % 256;
    expect(isValidMp3(writeTmp(buf))).toBe(false);
  });

  it("不存在的文件返回 false", () => {
    expect(isValidMp3(path.join(os.tmpdir(), "no-such-file.mp3"))).toBe(false);
  });
});
