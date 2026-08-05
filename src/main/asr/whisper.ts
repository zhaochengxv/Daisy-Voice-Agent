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
    // 自愈：上一轮 processAudio 若中途异常（写盘失败等）processing 会残留 true，
    // 导致后续 feedPcm 全部被吞 → 长按永远 0 字节。新会话无条件复位。
    this.processing = false;
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

    // Hold-to-talk（快捷键按住说话，autoStopOnSilence=false）：
    // 按下即采集，不依赖 VAD speechStart 判起音。真机低音量（energy 0.0002~0.0006
    // vs threshold 0.02）导致 speechStart 永不触发 → audioBuffer 恒空 → 0 字节空转写。
    // 会话由松键/超时结束，VAD 静音门控在这里不适用。
    if (!this.autoStopOnSilence) {
      if (this.audioBuffer.length === 0) {
        this.emit("partial", "...");
      }
      this.audioBuffer.push(buffer);
      this.totalBytes += buffer.length;
      if (this.totalBytes >= MAX_AUDIO_BYTES) {
        log("WhisperAsrSession: max length reached, transcribing...");
        this.sessionActive = false;
        this.preRollBuffer = [];
        this.processAudio();
      }
      return;
    }

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
    let wav: Buffer;
    try {
      // 写盘在 try 内：writeFileSync 抛错（临时目录不可写/磁盘满）时也会走
      // finally 复位 processing，杜绝转写永久卡死（否则后续 feedPcm 全被吞）。
      wav = this.toWav(audioData);
      fs.writeFileSync(wavPath, wav);
    } catch (error) {
      log(`WhisperAsrSession: failed to write wav: ${error}`);
      this.emit("error", "临时音频文件写入失败");
      return;
    }

    try {
      const modelError = validateWhisperModel();
      if (modelError) {
        log(`WhisperAsrSession: ${modelError}`);
        this.emit("error", modelError);
        return;
      }

      log("WhisperAsrSession: running whisper-cli...");

      // 命令转写热词：whisper.cpp base 模型中文准确率有限，prompt 注入命令高频词
      // 能显著压低误听（真机「打开微博」曾被识别为「打开微博叔叔今年的世界被观看」）。
      const COMMAND_PROMPT =
        "Daisy, 黛西, 打开, 关闭, 启动, 天气, 时间, 提醒, 闹钟, 日历, 备忘录, 微信, 微博, 抖音, 哔哩哔哩, 浏览器, 音量, 搜索, 计时器, 邮件, 音乐, 视频, 截图";

      // 优先走 whisper-server 常驻转写（模型仅加载一次，低配机器提速显著）；
      // server 不可用时回退到一次一进程的 whisper-cli，行为不退化。
      const serverText = await whisperServer.transcribe(wav, {
        language: "zh",
        prompt: COMMAND_PROMPT,
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
          "--prompt", COMMAND_PROMPT,
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
