import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EdgeTTS } from "node-edge-tts";
import { config } from "../config/env";
import { log } from "../utils/logger";

const TTS_DIR = path.join(os.tmpdir(), "diri-tts");

// 限制并发合成数：流式逐句合成时 LLM 生成速度可能远超 TTS 合成速度，
// 若无限制会同时建立多个 Edge TTS WebSocket 连接，触发服务端限流（429）。
// 2 个在途足够保持「边流边播」低延迟，同时规避限流与内存堆积。
class SynthesisLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }
}

const synthesisLimiter = new SynthesisLimiter(2);

// Clean old files on startup (in case of crash)
export function startTTSCleanup(): void {
  try {
    if (fs.existsSync(TTS_DIR)) {
      let deleted = 0;
      for (const file of fs.readdirSync(TTS_DIR)) {
        if (file.startsWith("diri-tts-") && file.endsWith(".mp3")) {
          fs.unlinkSync(path.join(TTS_DIR, file));
          deleted++;
        }
      }
      if (deleted > 0) log(`TTS startup cleanup: deleted ${deleted} leftover files`);
    }
  } catch {
    // ignore
  }
}

export class EdgeTTSPlayer {
  async synthesize(text: string): Promise<string | null> {
    if (!text.trim()) return null;

    await synthesisLimiter.acquire();
    try {
      if (!fs.existsSync(TTS_DIR)) {
        fs.mkdirSync(TTS_DIR, { recursive: true });
      }

      const fileName = `diri-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
      const filePath = path.join(TTS_DIR, fileName);

      try {
        let retries = 3;
        let lastError: any = null;
        while (retries > 0) {
          try {
            // node-edge-tts 默认 10s 全量合成截止（edge-tts.js:99 reject('Timed out')），
            // 长句/慢网络下频繁触发（真机日志反复 TTS synthesize failed: Timed out）。
            // 放到 30s：服务端正常约 1-2s/句，30s 足够覆盖慢网与长文本，同时仍能兜底死连接。
            const tts = new EdgeTTS({ voice: config.tts.voice, rate: config.tts.rate, timeout: 30000 });
            await tts.ttsPromise(text, filePath);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            retries--;
            if (retries > 0) {
              // 服务端 503/限流时固定 500ms 重试会连续撞限流（真机日志 02:52-02:56 连发 8 次 503），
              // 改为指数退避：1.5s → 3s，让限流窗口过去再试
              const msg = error instanceof Error ? error.message : String(error);
              const delay = retries === 2 ? 1500 : 3000;
              log(`TTS synthesize failed: ${msg}. Retrying in ${delay}ms (${retries} attempts left)...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }
        if (lastError) {
          throw lastError;
        }
        return filePath;
      } catch (error) {
        fs.promises.unlink(filePath).catch(() => {});
        log(`TTS synthesize failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    } finally {
      synthesisLimiter.release();
    }
  }
}
