import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config/env";
import { log } from "../utils/logger";
import {
  AsrCredentials,
  buildAudioRequest,
  buildFullClientRequest,
  buildRequestHeaders,
  buildStreamingWavHeader,
  extractTranscript,
  parseVolcengineResponse,
} from "./volcengine";

const SAMPLE_RATE = 16000;
const AUDIO_SEGMENT_MS = 100;
const AUDIO_SEGMENT_BYTES = Math.floor((SAMPLE_RATE * 2 * AUDIO_SEGMENT_MS) / 1000);

export interface AsrSessionEvents {
  partial: (text: string) => void;
  final: (text: string) => void;
  error: (message: string) => void;
}

export class AsrSession extends EventEmitter {
  private socket: WebSocket | null = null;
  private seq = 1;
  private ready = false;
  private sentWavHeader = false;
  private audioBuffer = Buffer.alloc(0);
  private lastText = "";
  private sessionActive = false;
  private stopping = false;
  private lastSent = false;
  private finalEmitted = false;
  private credentials: AsrCredentials;
  private lastPartialTime = 0;
  private fastFinishTimer: NodeJS.Timeout | null = null;
  private endTimeout: NodeJS.Timeout | null = null;
  private totalAudioBytes = 0;

  constructor() {
    super();
    this.credentials = {
      appId: config.asr.appId,
      accessToken: config.asr.accessToken,
      resourceId: config.asr.resourceId,
    };
  }

  start(): void {
    if (this.sessionActive) return;
    this.sessionActive = true;
    this.stopping = false;
    this.lastSent = false;
    this.finalEmitted = false;
    this.lastText = "";
    this.totalAudioBytes = 0;
    log("ASR: start() called, connecting WebSocket");
    this.connect();
  }

  stop(): void {
    if (!this.sessionActive || this.stopping) return;
    this.stopping = true;
    this.sessionActive = false;
    log(`ASR: stop() called, total audio: ${this.totalAudioBytes} bytes, lastText="${this.lastText}"`);

    // A shortcut tap used only to interrupt TTS can finish before the audio
    // renderer has produced a single PCM frame. There is no audio for the
    // server to recognize in that case, so waiting the normal 10 seconds for
    // a delayed ASR result only leaves the orb visibly idle for too long.
    // Do not use lastText here: real recorded speech may still have an empty
    // partial result while the server is finishing recognition.
    if (this.totalAudioBytes === 0) {
      log("ASR: no audio captured; finalizing immediately");
      this.finish();
      return;
    }

    this.flushAudio(true);

    // Unified polling: check every 300ms for partial text stability.
    // - If partial is empty, wait for it to arrive (up to 10s)
    // - If partial is non-empty and stable for 1.5s, emit final
    // - If server returns isLastPackage, finish immediately (handled in message handler)
    if (this.endTimeout) clearTimeout(this.endTimeout);
    if (this.fastFinishTimer) clearTimeout(this.fastFinishTimer);

    let stableCount = 0;
    let lastText = this.lastText;
    let elapsed = 0;
    const STABLE_LIMIT = 5; // 5 × 300ms = 1.5s 稳定
    const checkStable = () => {
      if (this.finalEmitted) return;
      elapsed += 300;

      if (this.lastText !== lastText) {
        // Partial text changed — reset stability counter
        stableCount = 0;
        lastText = this.lastText;
      } else if (this.lastText.length > 0) {
        // Partial text stable and non-empty
        stableCount++;
      }

      // Finish if: stable for 1.5s (5 checks) with text, or max 10s elapsed
      // 优先级：isLastPackage 即时返回；此轮询作为兜底，缩短稳定阈值以降低感知延迟
      if ((this.lastText.length > 0 && stableCount >= STABLE_LIMIT) || elapsed >= 10000) {
        log(`ASR: finish (stable ${stableCount * 300}ms, elapsed ${elapsed}ms), lastText="${this.lastText}"`);
        this.finish();
      } else {
        this.fastFinishTimer = setTimeout(checkStable, 300);
      }
    };
    this.fastFinishTimer = setTimeout(checkStable, 300);
  }

  feedPcm(buffer: Buffer): void {
    if (!this.sessionActive) return;
    this.totalAudioBytes += buffer.length;
    this.audioBuffer = Buffer.concat([this.audioBuffer, buffer]);
    this.flushAudio(this.stopping);
  }

  getLastText(): string {
    return this.lastText;
  }

  private finish(): void {
    if (this.finalEmitted) return;
    this.finalEmitted = true;
    this.sessionActive = false;
    this.emit("final", this.lastText);
    if (this.endTimeout) {
      clearTimeout(this.endTimeout);
      this.endTimeout = null;
    }
    if (this.fastFinishTimer) {
      clearTimeout(this.fastFinishTimer);
      this.fastFinishTimer = null;
    }
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      // finish() may run before the WebSocket handshake completes (for
      // example, a TTS-interrupt tap). Close that exact socket once it opens;
      // relying on this.socket later is unsafe because a new ASR session may
      // already have replaced it.
      socket.once("open", () => socket.close());
    }
    this.socket = null;
    this.audioBuffer = Buffer.alloc(0);
  }

  private connect(): void {
    if (!this.credentials.appId || !this.credentials.accessToken) {
      this.emit("error", "缺少火山引擎 App ID 或 Access Token");
      return;
    }

    log("ASR: creating WebSocket connection");
    this.socket = new WebSocket(config.asr.wsUrl, {
      headers: buildRequestHeaders(this.credentials),
    });
    const socket = this.socket;

    // 鉴权失败（401/403）时 ws 库只给 "Unexpected server response: 403"，
    // 不包含响应体，用户无法判断是 AppID/Token/ResourceId 哪个不对。
    // ws 提供 unexpected-response 事件，可读到真实 statusCode 与 body。
    socket.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      res.on("end", () => {
        const snippet = body.trim().slice(0, 300);
        log(`ASR: volcano HTTP ${res.statusCode ?? 0}, body="${snippet}"`);
        this.emit("error", volcanoHttpHint(res.statusCode ?? 0, snippet, config.asr.wsUrl));
      });
    });

    socket.on("open", () => {
      if (this.finalEmitted || (!this.sessionActive && !this.stopping)) {
        log("ASR: WS open but session no longer active, closing");
        socket.close();
        return;
      }
      this.ready = true;
      log("ASR: WebSocket connected, sending config + flushing audio");
      const modelName = deriveModelName(config.asr.wsUrl);
      socket.send(buildFullClientRequest(this.seq++, 16000, modelName));
      this.flushAudio(this.stopping);

      if (this.stopping && this.endTimeout) {
        clearTimeout(this.endTimeout);
        this.endTimeout = setTimeout(() => {
          if (this.finalEmitted) return;
          log(`ASR: post-connect timeout, emitting final="${this.lastText}"`);
          this.finish();
        }, 10000);
      }
    });

    this.socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const response = parseVolcengineResponse(Buffer.from(data as Buffer));
      if (response.code) {
        const detail = response.payloadMsg
          ? JSON.stringify(response.payloadMsg).slice(0, 200)
          : "";
        log(`ASR: server error code ${response.code}${detail ? ` detail=${detail}` : ""}`);
        this.emit("error", `火山 ASR 错误 ${response.code}${detail ? `：${detail}` : ""}`);
        return;
      }

      const text = extractTranscript(response.payloadMsg);
      if (text) {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (normalized !== this.lastText) {
          this.lastText = normalized;
          this.emit("partial", normalized);
        }
      }

      // Server signals this is the final result
      if (response.isLastPackage) {
        log(`ASR: received last package, final text="${this.lastText}"`);
        this.finish();
      }
    });

    this.socket.on("error", (error: Error) => {
      log(`ASR: WebSocket error: ${error.message}`);
      // ws 库对非 101 响应只报 "Unexpected server response: <status>"，
      // 把状态码解析出来映射成可操作的排查提示（unexpected-response 路径已在上面处理 body）。
      const statusMatch = error.message.match(/(\d{3})/);
      if (statusMatch) {
        this.emit("error", volcanoHttpHint(Number(statusMatch[1] ?? 0), "", config.asr.wsUrl));
      } else {
        this.emit("error", error.message);
      }
    });

    this.socket.on("close", () => {
      this.ready = false;
      log("ASR: WebSocket closed");
    });
  }

  private flushAudio(isLast: boolean): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.lastSent) return;

    while (this.audioBuffer.length >= AUDIO_SEGMENT_BYTES) {
      const segment = this.audioBuffer.subarray(0, AUDIO_SEGMENT_BYTES);
      this.audioBuffer = this.audioBuffer.subarray(AUDIO_SEGMENT_BYTES);
      this.sendAudioSegment(segment, false);
    }

    if (isLast) {
      if (this.audioBuffer.length > 0) {
        this.sendAudioSegment(this.audioBuffer, true);
        this.audioBuffer = Buffer.alloc(0);
      } else {
        this.sendAudioSegment(Buffer.alloc(0), true);
      }
      this.lastSent = true;
      log("ASR: sent last audio segment");
    }
  }

  private sendAudioSegment(segment: Buffer, isLast: boolean): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    let pcm = segment;
    if (!this.sentWavHeader) {
      this.sentWavHeader = true;
      pcm = Buffer.concat([buildStreamingWavHeader(SAMPLE_RATE), segment]);
    }

    try {
      this.socket.send(buildAudioRequest(this.seq++, pcm, isLast));
    } catch (error) {
      this.emit("error", `发送音频失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 从 wsUrl 推导 model_name：火山要求 payload 的 model_name 与 wsUrl 路径末段
 * 集群名一致（免费试用版 bigmodel / 正式版 bigmodel_async）。用户改了 wsUrl
 * 而 payload 仍是旧的 bigmodel → 403。推导失败默认 bigmodel（免费版最常见）。
 */
export function deriveModelName(wsUrl: string): string {
  try {
    const seg = new URL(wsUrl).pathname.split("/").filter(Boolean).pop();
    return seg || "bigmodel";
  } catch {
    return "bigmodel";
  }
}

/** 把火山 HTTP 状态码映射成可操作的排查提示；附加 body 片段供真机日志定位。 */
export function volcanoHttpHint(status: number, body: string, wsUrl: string): string {
  const hintByStatus: Record<number, string> = {
    400: "火山 ASR 请求格式错误(400)：请检查 VOLCENGINE_ASR_WS_URL 是否为有效的流式接口地址",
    401: "火山 ASR 鉴权失败(401)：VOLCENGINE_ACCESS_TOKEN 无效或已过期，请到火山控制台重新生成",
    403: "火山 ASR 鉴权失败(403)：VOLCENGINE_RESOURCE_ID 对应的服务未在控制台开通或与 AppID 不匹配。请到火山控制台「语音技术→语音识别→语音识别大模型」开通流式识别集群，并确认 resource_id 与开通版本一致：Seed ASR(v2) 用 volc.seedasr.sauc.duration，大模型 1.0 用 volc.bigasr.sauc.duration",
    404: "火山 ASR 接口不存在(404)：请检查 VOLCENGINE_ASR_WS_URL 路径是否填写正确",
    429: "火山 ASR 用量超限(429)：免费集群并发/时长配额已用尽，请稍后再试或升级正式版",
  };
  const base = hintByStatus[status] || `火山 ASR HTTP ${status}，请检查配置`;
  return body ? `${base} | 响应:${body}` : base;
}
