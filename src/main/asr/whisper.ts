import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/logger";
import { VAD } from "../wakeword/monitor";
import { whisperServer } from "./whisperServer";
import {
  config,
  getWhisperModelPath,
  getBundledBin,
  getWhisperBin,
  getWhisperExecutionEnv,
  getWhisperThreads,
  expectedWhisperModelBytes,
  whisperNeedsNoGpu,
} from "../config/env";

const execFileAsync = promisify(execFile);

const WHISPER_CLI = getWhisperBin("whisper-cli");
const TEMP_DIR = path.join(os.tmpdir(), "diri-wakeword");

const SAMPLE_RATE = 16000;
const MIN_AUDIO_BYTES = SAMPLE_RATE * 2 * 0.5; // 0.5s minimum
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 15;  // 15s maximum for commands

export class WhisperAsrSession extends EventEmitter {
  private audioBuffer: Buffer[] = [];
  private preRollBuffer: Buffer[] = [];
  private totalBytes = 0;
  private vad: VAD;
  private sessionActive = false;
  private processing = false;
  private lastText = "";

  constructor(private readonly autoStopOnSilence = true) {
    super();
    this.vad = new VAD();
  }

  getLastText(): string {
    return this.lastText;
  }

  start(): void {
    this.sessionActive = true;
    this.audioBuffer = [];
    this.preRollBuffer = [];
    this.totalBytes = 0;
    this.vad.reset();
    log("WhisperAsrSession: started local Whisper command recognition");
  }

  stop(): void {
    if (!this.sessionActive) return;
    this.sessionActive = false;
    log(`WhisperAsrSession: stop() called, total audio: ${this.totalBytes} bytes`);
    if (this.totalBytes >= MIN_AUDIO_BYTES) {
      this.processAudio();
    } else {
      this.emit("final", "");
    }
  }

  feedPcm(buffer: Buffer): void {
    if (!this.sessionActive || this.processing) return;

    const vadEvent = this.vad.feed(buffer);

    if (this.audioBuffer.length === 0) {
      // Maintain sliding window pre-roll of 500ms (16000 bytes)
      this.preRollBuffer.push(buffer);
      let preRollBytes = this.preRollBuffer.reduce((sum, b) => sum + b.length, 0);
      while (preRollBytes > 16000 && this.preRollBuffer.length > 1) {
        preRollBytes -= this.preRollBuffer.shift()!.length;
      }

      if (vadEvent.speechStart) {
        // First chunk of speech
        this.emit("partial", "...");
        this.audioBuffer = [...this.preRollBuffer];
        this.totalBytes = preRollBytes;
        this.preRollBuffer = [];
      }
    } else {
      this.audioBuffer.push(buffer);
      this.totalBytes += buffer.length;

      // Stop on silence or max length
      if ((this.autoStopOnSilence && vadEvent.silenceEnd) || this.totalBytes >= MAX_AUDIO_BYTES) {
        log("WhisperAsrSession: silence or max length reached, transcribing...");
        this.sessionActive = false;
        this.preRollBuffer = [];
        if (this.totalBytes >= MIN_AUDIO_BYTES) {
          this.processAudio();
        } else {
          // 音频过短，重置缓冲避免误触发转写
          this.audioBuffer = [];
          this.totalBytes = 0;
        }
      }
    }
  }

  private async processAudio(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    const audioData = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    this.totalBytes = 0;

    const wavPath = path.join(TEMP_DIR, `cmd-${Date.now()}.wav`);
    const wav = this.toWav(audioData);
    fs.writeFileSync(wavPath, wav);

    try {
      const modelError = validateWhisperModel();
      if (modelError) {
        log(`WhisperAsrSession: ${modelError}`);
        this.emit("error", modelError);
        return;
      }

      log("WhisperAsrSession: running whisper-cli...");

      // 优先走 whisper-server 常驻转写（模型仅加载一次，低配机器提速显著）；
      // server 不可用时回退到一次一进程的 whisper-cli，行为不退化。
      const serverText = await whisperServer.transcribe(wav, {
        language: "zh",
        prompt: "Daisy, 黛西",
      });
      let text: string;
      let cliInfo = "";
      if (serverText === null) {
        const { stdout } = await execFileAsync(WHISPER_CLI, [
          "-m", getWhisperModelPath(),
          "-f", wavPath,
          "-l", "zh",
          "--no-timestamps",
          "-t", String(getWhisperThreads()),
          "-np",
          "--prompt", "Daisy, 黛西",
          "-sns",
          ...(whisperNeedsNoGpu() ? ["-ng"] : []),
        ], {
          env: getWhisperExecutionEnv(WHISPER_CLI),
          timeout: 45000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        text = stdout;
        cliInfo = " (cli fallback)";
      } else {
        text = serverText;
      }

      const clean = text.trim().replace(/\[.*?\]/g, "").trim();
      this.lastText = clean;
      log(`WhisperAsrSession: result="${clean}"${cliInfo}`);
      this.emit("final", clean);
    } catch (error) {
      const err = error as (Error & { stdout?: string; stderr?: string });
      // 超时/崩溃时 whisper-cli 的 stderr 是判定根因的关键（初始化进度 vs 静默卡死 vs 明确报错）
      log(`WhisperAsrSession error: ${err.message} | stdout="${String(err.stdout ?? "").trim().slice(0, 300)}" stderr="${String(err.stderr ?? "").trim().slice(0, 500)}"`);
      this.emit("error", err.message);
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
      this.processing = false;
    }
  }

  private toWav(pcm: Buffer): Buffer {
    const header = Buffer.alloc(44);
    const dataLength = pcm.length;
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(dataLength + 36, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);          // PCM
    header.writeUInt16LE(1, 22);          // mono
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);          // block align
    header.writeUInt16LE(16, 34);         // bits per sample
    header.write("data", 36, "ascii");
    header.writeUInt32LE(dataLength, 40);
    return Buffer.concat([header, pcm]);
  }
}

function validateWhisperModel(): string | null {
  const modelPath = getWhisperModelPath();
  if (!fs.existsSync(modelPath)) {
    return `Whisper model not found: ${modelPath}. 请先在设置页下载模型。`;
  }
  const actualBytes = fs.statSync(modelPath).size;
  const expectedBytes = expectedWhisperModelBytes(config.whisper.model);
  if (expectedBytes > 0 && actualBytes < expectedBytes * 0.9) {
    return `Whisper model truncated (${actualBytes} bytes < ${expectedBytes} bytes): ${modelPath}. 请重新下载模型。`;
  }
  return null;
}
