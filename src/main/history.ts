import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { log } from "./utils/logger";

export interface ChatEntry {
  sender: "user" | "daisy";
  text: string;
  timestamp: number;
}

const MAX_HISTORY = 20; // 保存最近 20 组（用户 + Daisy）

function getHistoryFilePath(): string {
  return path.join(app.getPath("userData"), "conversation-history.json");
}

/** 会话历史：持久化到 userData，供设置页展示与清空。 */
export class ConversationHistory {
  private entries: ChatEntry[] = [];

  load(): void {
    try {
      const p = getHistoryFilePath();
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
        this.entries = Array.isArray(parsed) ? parsed : [];
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(getHistoryFilePath(), JSON.stringify(this.entries), "utf-8");
    } catch {
      // ignore
    }
  }

  add(sender: "user" | "daisy", text: string): void {
    if (!text.trim()) return;
    this.entries.push({ sender, text: text.trim(), timestamp: Date.now() });
    if (this.entries.length > MAX_HISTORY * 2) {
      // Keep last MAX_HISTORY pairs (user + daisy)
      this.entries = this.entries.slice(-MAX_HISTORY * 2);
    }
    this.save();
  }

  get(): ChatEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.save();
    log("Conversation history cleared");
  }
}
