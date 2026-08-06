import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/logger";
import { whisperServer } from "../asr/whisperServer";
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
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 8;   // 8s maximum
const SILENCE_THRESHOLD = 0.008;
const SILENCE_END_MS = 2000;
const SPEECH_START_MS = 0; // Trigger on first loud frame

const WAKE_WORD_PATTERNS: RegExp[] = [
  // 1. Chinese prefix + Chinese Daisy (e.g. 嘿黛西, 嘿代茜)
  /[嘿嗨黑喂][,\s]*[呆戴代带袋大达黛][西茜希溪喜细]/,
  
  // 2. English prefix + English Daisy (e.g. hey daisy, hi daisy, hello daisy)
  /\b(hey|hi|hello|okay|ok)[,\s]*(daisy|daysi|dayzi|deisy|deizy|daizy|dazy|dazie|dasi)\b/i,
  
  // 3. English prefix + Chinese Daisy (e.g. hey 黛西)
  /\b(hey|hi|hello|okay|ok)[,\s]*[呆戴代带袋大达黛][西茜希溪喜细]/i,
  
  // 4. Chinese prefix + English Daisy (e.g. 嘿 daisy)
  /[嘿嗨黑喂][,\s]*(daisy|daysi|dayzi|deisy|deizy|daizy|dazy|dazie)/i,

  // 5. 假名转写：whisper.cpp base 模型把 "Hey Daisy" 误识别为日文假名，
  //    真机实测输出 "かいで"（ka-i-de），不覆盖则语音唤醒永远不触发。
  /[かカ](?:[いぃイ]|[いいー])[でデ][いぃイー]?/,
  /[ひハ][いぃイ][ー]?[でデ][いぃイ][ー]?[じジ][ー]?/,   // ハイデイジー / ヒイデイジー
  /[へヘ][いぃイ][でデ][いぃイ][じジ]/,                    // ヘイデイジ family

  // 6. 拼音近似（"hei dai zi" 一类轻声朗读）
  /[hx][ae]i\s*(?:[d]?)[ae]i\s*(?:zi|si)/i,
];

// 宽松兜底：whisper.cpp base 模型中文前缀常误写（真机把「嘿 黛西」识别成
// 「可以 黛西」），主模式漏触发导致「唤醒词时灵时不灵」。对短语音段（≤8 字）
// 以「黛西/daisy」类字结尾即视为唤醒，前缀任意。
const LAX_SUFFIX_RE = /(?:[呆戴代带袋大达黛][西茜希溪喜细]|daisy|daysi|dayzi|deisy|deizy|daizy|dazy|dazie)/i;
const MAX_LAX_LEN = 8;
type MonitorState = "idle" | "recording" | "paused";

/** 纯函数：文本是否命中唤醒词（含 whisper.cpp 方言/假名误识别）。供单测与内部共用。 */
export function isWakeWordMatch(text: string): boolean {
  const normalized = text.replace(/[\s,，。！!？?、~""'''.]/g, "");
  for (const pattern of WAKE_WORD_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(text)) {
      return true;
    }
  }
  if (normalized.length > 0 && normalized.length <= MAX_LAX_LEN && LAX_SUFFIX_RE.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * 清理唤醒词后文的纯标点/空残留（如 "Ei, Daisy." 只剩 "."），避免空命令空转。
 * 模块级纯函数，供单测与 WakeWordMonitor 内部共用。
 */
export function cleanCommand(remaining: string): string {
  const cleaned = remaining.replace(/^[,，。！!？?、.\s]+/, "").trim();
  // 只剩标点（无任何有效汉字/字母/数字）视为无命令
  if (!cleaned || !/[\u4e00-\u9fa5A-Za-z0-9]/.test(cleaned)) return "";
  return cleaned;
}

export class WakeWordMonitor extends EventEmitter {
  private state: MonitorState = "idle";
  private audioBuffer: Buffer[] = [];
  private preRollBuffer: Buffer[] = [];
  private totalBytes = 0;
  private vad: VAD;
  private processing = false;

  constructor(_keyword: string) {
    super();
    this.vad = new VAD(800);
  }

  start(): void {
    this.state = "idle";
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
    log("WakeWordMonitor: started, using whisper.cpp local detection");
  }

  stop(): void {
    this.pause();
    this.state = "paused";
  }

  pause(): void {
    this.state = "paused";
    this.audioBuffer = [];
    this.totalBytes = 0;
    this.vad.reset();
  }

  resume(): void {
    if (this.state === "paused") {
      this.state = "idle";
      this.audioBuffer = [];
      this.totalBytes = 0;
      this.vad.reset();
      log("WakeWordMonitor: resumed");
    }
  }

  feedPcm(buffer: Buffer): void {
    if (this.state === "paused") return;

    const vadEvent = this.vad.feed(buffer);

    if (this.state === "idle") {
      // Maintain a sliding window pre-roll buffer of 500ms (16000 bytes)
      this.preRollBuffer.push(buffer);
      let preRollBytes = this.preRollBuffer.reduce((sum, b) => sum + b.length, 0);
      while (preRollBytes > 16000 && this.preRollBuffer.length > 1) {
        preRollBytes -= this.preRollBuffer.shift()!.length;
      }

      if (vadEvent.speechStart) {
        this.state = "recording";
        this.audioBuffer = [...this.preRollBuffer];
        this.totalBytes = preRollBytes;
        this.preRollBuffer = [];
      }
    } else if (this.state === "recording") {
      this.audioBuffer.push(buffer);
      this.totalBytes += buffer.length;

      // Stop recording on silence or max length
      if (vadEvent.silenceEnd || this.totalBytes >= MAX_AUDIO_BYTES) {
        this.state = "idle";
        this.vad.reset();
        this.preRollBuffer = [];
        if (this.totalBytes >= MIN_AUDIO_BYTES) {
          this.processAudio();
        } else {
          this.audioBuffer = [];
          this.totalBytes = 0;
        }
      }
    }
  }

  private async processAudio(): Promise<void> {
    if (this.processing) {
      this.audioBuffer = [];
      this.totalBytes = 0;
      return;
    }

    this.processing = true;
    const audioData = Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    this.totalBytes = 0;

    try {
      const text = await this.transcribeWithWhisper(audioData);
      if (text) {
        log(`WakeWordMonitor: whisper.cpp result="${text}"`);
        // 处理期间 monitor 可能已被 stop()/pause()（锁屏/关闭唤醒词），
        // 在途音频不得再触发 wake，否则破坏隐私安全。
        if (this.state === "paused") {
          log("WakeWordMonitor: paused while processing, ignoring wake result");
          return;
        }
        if (this.containsWakeWord(text)) {
          const command = this.extractCommand(text);
          log(`WakeWordMonitor: wake word detected! command="${command}"`);
          this.emit("wake", command);
        }
      }
    } catch (error) {
      const err = error as (Error & { stdout?: string; stderr?: string });
      // 超时/崩溃时 whisper-cli 的 stderr 是判定根因的关键（初始化进度 vs 静默卡死 vs 明确报错）
      log(`WakeWordMonitor: whisper error: ${err.message} | stdout="${String(err.stdout ?? "").trim().slice(0, 300)}" stderr="${String(err.stderr ?? "").trim().slice(0, 500)}"`);
    }

    this.processing = false;
  }

  private async transcribeWithWhisper(audioData: Buffer): Promise<string> {
    const wavPath = path.join(TEMP_DIR, `wake-${Date.now()}.wav`);

    // Write WAV file with header
    const wav = this.toWav(audioData);
    fs.writeFileSync(wavPath, wav);

    try {
      // 优先走 whisper-server 常驻转写（唤醒词每次触发都重建进程 + 加载模型在低配
      // Windows 上可耗 40+ 秒）；server 不可用时回退 whisper-cli。
      // 注意：server 端 /inference 只接受合法 WAV（内部按 FormData file=audio.wav
      // 解析），传裸 PCM 会导致 HTTP 400（真机日志反复出现的根因），这里复用上面
      // 已生成好的 WAV 缓冲，与快捷键路径 whisper.ts 的写法保持一致。
      const serverText = await whisperServer.transcribe(wav, {
        language: "auto",
        prompt: "Hey Daisy, 嘿 黛西",
      });
      if (serverText !== null) {
        return serverText.trim().replace(/\[.*?\]/g, "").trim();
      }

      const modelPath = getWhisperModelPath();
      if (!fs.existsSync(modelPath)) {
        log(`WakeWordMonitor: whisper model not found: ${modelPath}`);
        return "";
      }
      const modelBytes = fs.statSync(modelPath).size;
      const expectedBytes = expectedWhisperModelBytes(config.whisper.model);
      if (expectedBytes > 0 && modelBytes < expectedBytes * 0.9) {
        log(`WakeWordMonitor: whisper model truncated (${modelBytes} bytes), skipping`);
        return "";
      }

      const { stdout, stderr } = await execFileAsync(WHISPER_CLI, [
        "-m", modelPath,
        "-f", wavPath,
        "-l", "auto",
        "--no-timestamps",
        "-t", String(getWhisperThreads()),
        "-np",
        "--prompt", "Hey Daisy, 嘿 黛西",
        "-sns",
        ...(whisperNeedsNoGpu() ? ["-ng"] : []),
      ], {
        env: getWhisperExecutionEnv(WHISPER_CLI),
        timeout: 25000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });

      // whisper-cli outputs transcript to stdout, clean it up
      const text = stdout.trim().replace(/\[.*?\]/g, "").trim();
      return text;
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
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

  private containsWakeWord(text: string): boolean {
    const clean = text.replace(/[\s,，。！!？?、~""'''.]/g, "");
    for (const pattern of WAKE_WORD_PATTERNS) {
      if (pattern.test(text) || pattern.test(clean)) {
        log(`WakeWordMonitor: matched pattern ${pattern.source}`);
        return true;
      }
    }
    // 宽松后缀兜底：短语音段以「黛西/daisy」结尾即唤醒（前缀误听如「可以 黛西」）
    if (clean.length > 0 && clean.length <= MAX_LAX_LEN && LAX_SUFFIX_RE.test(clean)) {
      log(`WakeWordMonitor: lax suffix match on "${text}"`);
      return true;
    }
    return false;
  }

  private extractCommand(text: string): boolean | string {
    for (const pattern of WAKE_WORD_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const idx = text.indexOf(match[0]);
        if (idx >= 0) {
          const remaining = text.slice(idx + match[0].length);
          return cleanCommand(remaining);
        }
      }
    }
    // 宽松模式：定位「黛西」出现位置取后文作为命令
    const clean = text.replace(/\s/g, "");
    const suffixMatch = clean.match(LAX_SUFFIX_RE);
    if (suffixMatch && suffixMatch.index !== undefined) {
      const remaining = clean.slice(suffixMatch.index + suffixMatch[0].length);
      return cleanCommand(remaining);
    }
    return "";
  }
}

export class VAD {
  private noiseFloor = 0.005; // adaptive noise baseline
  private speechStartMs = 0;
  private silenceEndMs = 2000;
  private inSpeech = false;
  private speechCounter = 0;
  private silenceCounter = 0;
  private frameCount = 0;
  private lowEnergyStreak = 0;
  private silentLogged = false;

  constructor(silenceEndMs = 2000) {
    this.silenceEndMs = silenceEndMs;
  }

  feed(buffer: Buffer): { speechStart: boolean; silenceEnd: boolean } {
    const energy = this.calculateEnergy(buffer);
    const chunkMs = ((buffer.length / 2) / SAMPLE_RATE) * 1000;

    // 真机排障诊断：麦克风电平持续过低（几乎无帧超过 0.001）说明音频根本没进来
    // 或增益太低，VAD 永不判起音。只在首次进入静默态时记一次，避免刷屏。
    if (energy < 0.001) {
      this.lowEnergyStreak++;
      if (this.lowEnergyStreak > 100 && !this.silentLogged) {
        this.silentLogged = true;
        log(`VAD: input appears silent (${this.lowEnergyStreak} frames < 0.001). Check mic gain/permission; wake word will not trigger without real audio.`);
      }
    } else {
      this.lowEnergyStreak = 0;
    }

    // Adaptive noise floor: only update when NOT in speech
    if (!this.inSpeech) {
      // Slowly adapt to background noise
      this.noiseFloor = this.noiseFloor * 0.97 + energy * 0.03;
    }
    // Threshold is 2x above noise floor, minimum 0.002（唤醒匹配由 whisper 兜底，
    // 阈值放低可让轻声"嘿黛西"越过门限；仅唤醒词监控使用，不影响快捷键按住说话）。
    // 真机实测：Realtek 麦克风阵列远场说话时 VAD 平均能量仅 0.004~0.013（峰值可到 0.27），
    // 旧下界 0.012 使多数语音帧判为不响 → 唤醒词录音永远不触发（whisper 只拿到残缺噪声段，
    // 转出 かいてやすい/you/Okay 等乱码）。0.002 下界在安静(≤0.0003)与语音(≥0.004)之间留足间隔。
    const threshold = Math.max(this.noiseFloor * 2, 0.002);
    const isLoud = energy > threshold;

    this.frameCount++;
    if (this.frameCount % 50 === 0) {
      log(`VAD: energy=${energy.toFixed(4)} noiseFloor=${this.noiseFloor.toFixed(4)} threshold=${threshold.toFixed(4)} isLoud=${isLoud} inSpeech=${this.inSpeech}`);
    }

    if (!this.inSpeech) {
      if (isLoud) {
        this.speechCounter += chunkMs;
        this.silenceCounter = 0;
        if (this.speechCounter >= this.speechStartMs) {
          this.inSpeech = true;
          return { speechStart: true, silenceEnd: false };
        }
      } else {
        this.speechCounter = 0;
      }
      return { speechStart: false, silenceEnd: false };
    } else {
      if (isLoud) {
        this.silenceCounter = 0;
      } else {
        this.silenceCounter += chunkMs;
        if (this.silenceCounter >= this.silenceEndMs) {
          this.inSpeech = false;
          this.speechCounter = 0;
          this.silenceCounter = 0;
          return { speechStart: false, silenceEnd: true };
        }
      }
      return { speechStart: false, silenceEnd: false };
    }
  }

  reset(): void {
    this.inSpeech = false;
    this.speechCounter = 0;
    this.silenceCounter = 0;
    this.noiseFloor = 0.005;
    this.lowEnergyStreak = 0;
    this.silentLogged = false;
  }

  private calculateEnergy(buffer: Buffer): number {
    let sum = 0;
    const samples = buffer.length / 2;
    if (samples === 0) return 0;
    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += Math.abs(sample);
    }
    return sum / samples / 32768;
  }
}
