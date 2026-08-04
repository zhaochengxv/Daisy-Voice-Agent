import { EventEmitter } from "node:events";
import fs from "node:fs";
import { log } from "../utils/logger";

/**
 * 事件驱动 TTS 播放流水线。
 *
 * 取代原先「500ms setInterval 轮询」方案：合成完成一帧就 enqueue，
 * 流水线立即 pump 播放，播放结束（renderer 通知）后再 pump 下一帧，
 * 全部播完且合成结束即触发 allDone，全程无定时器、无轮询。
 *
 * 事件：
 *  - "play"(filePath): 请求播放某一帧（调用方负责 unmute + 发送 TTS_PLAY 给 renderer）
 *  - "allDone": 队列空 + 合成结束 + 无正在播放帧（调用方处理 idle/voice-loop/ack-wait）
 *  - "error"(message): 扩展位，供后续接入播放异常处理
 */
export class TtsPipeline extends EventEmitter {
  private queue: string[] = [];
  private currentFile: string | null = null;
  private synthesisActive = false;
  private inFlightJobs = 0;
  private playing = false;
  private stopped = false;

  get isSynthesisActive(): boolean {
    return this.synthesisActive;
  }

  /** 是否被显式 stop()（中止/静音/静默完成） */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** 标记开始合成一段响应（阻止空队列时触发 allDone）；不重置 stopped，避免复活已中止的轮次 */
  beginSynthesis(): void {
    this.synthesisActive = true;
  }

  /** 新一轮响应开始：清除 stopped 状态，允许入队播放 */
  clearStopped(): void {
    this.stopped = false;
  }

  /** 标记合成结束；若恰好无排队/播放内容则触发 allDone */
  endSynthesis(): void {
    this.synthesisActive = false;
    this.pump();
  }

  /** 单次合成任务开始（流式逐句 / 批量逐块），计入 inFlight */
  beginSynthesisJob(): void {
    this.inFlightJobs++;
  }

  /** 单次合成任务结束，全部结束后恢复 allDone 判定 */
  endSynthesisJob(): void {
    this.inFlightJobs = Math.max(0, this.inFlightJobs - 1);
    this.pump();
  }

  /** 一帧合成完成，入队并尝试立即播放 */
  enqueue(filePath: string): void {
    if (!filePath) return;
    this.queue.push(filePath);
    this.pump();
  }

  /** renderer 播放完毕回调；filePath 缺省时删除当前帧 */
  onPlayEnded(filePath?: string): void {
    const toDelete = filePath || this.currentFile;
    if (toDelete) {
      fs.promises.unlink(toDelete).catch(() => {});
      log(`TTS pipeline: deleted played file ${toDelete}`);
    }
    this.currentFile = null;
    this.playing = false;
    this.pump();
  }

  /** 立即停止播放并清空队列（物理删除全部临时文件） */
  stop(): void {
    this.stopped = true;
    this.playing = false;
    this.synthesisActive = false;
    this.inFlightJobs = 0;
    const doomed = this.queue.slice();
    if (this.currentFile) doomed.push(this.currentFile);
    this.queue = [];
    this.currentFile = null;
    for (const f of doomed) {
      fs.promises.unlink(f).catch(() => {});
    }
  }

  private pump(): void {
    if (this.playing) return;
    if (this.queue.length > 0) {
      const filePath = this.queue.shift()!;
      this.currentFile = filePath;
      this.playing = true;
      log(`TTS pipeline: playing ${filePath} (${this.queue.length} queued)`);
      this.emit("play", filePath);
      return;
    }
    if (!this.synthesisActive && this.inFlightJobs === 0 && !this.stopped) {
      log("TTS pipeline: all done");
      this.emit("allDone");
    }
  }
}
