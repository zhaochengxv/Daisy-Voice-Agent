import fs from "node:fs";
import { EdgeTTSPlayer } from "./edgeTTS";
import { TtsPipeline } from "./pipeline";
import { cleanTextForTTS } from "../utils/textClean";
import { log } from "../utils/logger";

const SENTENCE_END = /[。！？；\n]/;

/**
 * 边流边播：把 LLM 流式原文按句末标点切句，逐句实时合成并入队播放。
 *
 * 状态按「一轮生成」管理（一次 handleLLMRequest 内共享，跨工具轮 reset）：
 * - raw：本轮累计的原始流式文本
 * - spokenRawEnd：已被切句进入合成队列的原始下标
 * - enqueuedClean：已入队合成的清洗后文本（用于 tool_ack 去重判断）
 */
export class StreamTts {
  private raw = "";
  private spokenRawEnd = 0;
  private enqueuedClean = "";
  private generation = 0;
  private pending = 0;
  private drainResolvers: Array<() => void> = [];
  private readonly sessionId: number;
  private readonly isCurrent: () => boolean;

  constructor(sessionId: number, isCurrent: () => boolean) {
    this.sessionId = sessionId;
    this.isCurrent = isCurrent;
  }

  /** 本轮已入队合成的清洗后文本（供 tool_ack 判断是否已朗读） */
  get currentEnqueuedClean(): string {
    return this.enqueuedClean;
  }

  /** 流式原文增量。出现新句末标点时切出完整句并异步合成入队。 */
  feed(chunk: string, pipeline: TtsPipeline): void {
    this.raw += chunk;
    // 快路径：本块无句末标点则没有新句可切
    if (!SENTENCE_END.test(chunk)) return;

    // 从末尾向前找最后一个句末标点，切出从 spokenRawEnd 到该标点之间的完整句
    let lastBoundary = -1;
    for (let i = this.raw.length - 1; i >= 0; i--) {
      if (SENTENCE_END.test(this.raw[i])) {
        lastBoundary = i;
        break;
      }
    }
    if (lastBoundary < 0 || lastBoundary < this.spokenRawEnd) return;

    const segmentRaw = this.raw.slice(this.spokenRawEnd, lastBoundary + 1);
    this.spokenRawEnd = lastBoundary + 1;

    const segmentClean = cleanTextForTTS(segmentRaw);
    if (!segmentClean.trim()) return;
    this.enqueuedClean += segmentClean;

    const gen = this.generation;
    pipeline.beginSynthesis();
    pipeline.beginSynthesisJob();
    this.pending++;
    const player = new EdgeTTSPlayer();
    const settle = () => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0 && this.drainResolvers.length > 0) {
        const resolvers = this.drainResolvers.splice(0);
        for (const resolve of resolvers) resolve();
      }
      pipeline.endSynthesisJob();
    };
    player.synthesize(segmentClean).then(
      (filePath) => {
        try {
          if (filePath) {
            // 抢占（tool_ack 触发 reset 递增 generation）或显式 stop 后丢弃该帧，
            // 防止旧轮次句子晚到入队，混在 ack 抢占内容之后播放
            if (!this.isCurrent() || gen !== this.generation || pipeline.isStopped) {
              fs.promises.unlink(filePath).catch(() => {});
              return;
            }
            pipeline.enqueue(filePath);
            log(`StreamTTS: enqueued sentence (${segmentClean.length} chars)`);
          }
        } finally {
          settle();
        }
      },
      () => {
        // synthesize 内部已捕获错误并返回 null；此处兜底确保 inFlight 计数不泄漏
        settle();
      }
    );
  }

  /**
   * 等待所有已发起的在途句子合成完成并入队/丢弃。
   * done 时用于保证结尾块（synthesizeRemaining）不会因合成更快而插队到
   * 尚未入队的流式句子之前，维持逐句顺序。
   */
  waitForDrain(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  /** 剩余尚未切句的原文清洗结果（done 时用于合成结尾句） */
  remainingClean(): string {
    return cleanTextForTTS(this.raw.slice(this.spokenRawEnd));
  }

  /**
   * 本轮自然结束（done）：仅清空累计文本，不递增 generation，
   * 让仍在合成中的最后一句正常入队播放，避免末尾内容丢失。
   */
  finish(): void {
    this.raw = "";
    this.spokenRawEnd = 0;
    this.enqueuedClean = "";
  }

  /**
   * 新一轮生成 / 抢占（tool_ack 未流式朗读时调用）：
   * 递增 generation 丢弃全部在途句子的入队资格，防止旧轮次内容混入。
   */
  reset(): void {
    this.generation++;
    this.raw = "";
    this.spokenRawEnd = 0;
    this.enqueuedClean = "";
  }
}
