import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { log } from "../utils/logger";

export interface TaskSnapshot {
  savedAt: number;
  lastUserText: string;
  summary: string;
  context: Array<{ role: string; content: string }>;
}

const MAX_SNAPSHOT_MESSAGES = 12;
const MAX_SNAPSHOT_CHARS = 8000;

function getSnapshotPath(): string {
  return path.join(app.getPath("userData"), "task-snapshot.json");
}

/**
 * 「上次未完成任务」快照：LLM 因步数上限/异常中断时把当前任务上下文持久化到
 * 磁盘。新会话创建时若检测到未完成任务（用户说「继续/你之前没做完的」），
 * 将快照注入系统提示词，让助手有依据地恢复任务，而不是失忆后瞎猜。
 *
 * 真机日志根因（v1.5.15）：100 步安全阀强制中断后，新会话完全丢失任务上下文，
 * 用户两次催促「继续」助手都无法恢复，只能翻目录猜任务。
 */
export class TaskMemory {
  private snapshot: TaskSnapshot | null = null;

  load(): void {
    try {
      const p = getSnapshotPath();
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as TaskSnapshot;
        if (parsed && parsed.savedAt && parsed.lastUserText) {
          this.snapshot = parsed;
          log(`TaskMemory: loaded snapshot from ${new Date(parsed.savedAt).toLocaleString()} (${parsed.summary.slice(0, 60)})`);
        }
      }
    } catch {
      this.snapshot = null;
    }
  }

  /** 保存快照（中断/异常时调用），覆盖旧快照 */
  save(context: Array<{ role: string; content: string }>, lastUserText: string): void {
    const picked = [...context].reverse().slice(0, MAX_SNAPSHOT_MESSAGES).reverse();
    const entries: Array<{ role: string; content: string }> = [];
    let total = 0;
    for (const m of picked) {
      const content = (m.content || "").slice(0, 600);
      total += content.length;
      if (total > MAX_SNAPSHOT_CHARS) break;
      entries.push({ role: m.role, content });
    }
    this.snapshot = {
      savedAt: Date.now(),
      lastUserText,
      summary: lastUserText.slice(0, 120),
      context: entries,
    };
    try {
      fs.writeFileSync(getSnapshotPath(), JSON.stringify(this.snapshot), "utf-8");
      log(`TaskMemory: saved snapshot (${entries.length} messages) — ${this.snapshot.summary.slice(0, 60)}`);
    } catch (err) {
      log(`TaskMemory: failed to persist snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 任务正常完成时清除快照（避免旧任务被当作「未完成」恢复） */
  clear(): void {
    if (!this.snapshot) return;
    this.snapshot = null;
    try {
      if (fs.existsSync(getSnapshotPath())) fs.unlinkSync(getSnapshotPath());
      log("TaskMemory: cleared snapshot");
    } catch {
      // ignore
    }
  }

  hasPending(): boolean {
    return Boolean(this.snapshot);
  }

  getPending(): TaskSnapshot | null {
    return this.snapshot;
  }
}
