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
            const tts = new EdgeTTS({ voice: config.tts.voice, rate: config.tts.rate });
            await tts.ttsPromise(text, filePath);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            retries--;
            if (retries > 0) {
              log(`TTS synthesize failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 500ms (${retries} attempts left)...`);
              await new Promise(resolve => setTimeout(resolve, 500));
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
