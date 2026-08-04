import os from "node:os";
import path from "node:path";
import { ChatMessage, DeepSeekClient } from "./deepseek";
import { getSystemPrompt, SYSTEM_PROMPT } from "./system-prompt";
import { isWindows } from "../utils/windowsShell";

const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_TOKENS_ESTIMATE = 20000;

/**
 * 粗略 token 估算：中英混合启发式。
 * 中文/全角字符按 1 token/字符，连续 ASCII 按 4 字符/1 token，
 * 比「1 token ≈ 4 字符」对所有语言的统一假设更贴合 DeepSeek 的 BPE 分词。
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  let asciiRun = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 127 || /[，。！？；：、（）《》“”‘’·…—]/.test(ch)) {
      tokens += 1 + Math.ceil(asciiRun / 4);
      asciiRun = 0;
    } else {
      asciiRun++;
    }
  }
  tokens += Math.ceil(asciiRun / 4);
  return Math.max(1, tokens);
}

function messageTokens(m: ChatMessage): number {
  let n = estimateTokens(m.content || "");
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      n += estimateTokens(tc.function.name || "");
      n += estimateTokens(tc.function.arguments || "");
    }
  }
  return n;
}

function getSystemPromptWithEnv(): string {
  try {
    const username = os.userInfo().username;
    const homedir = os.homedir();
    const desktop = path.join(homedir, "Desktop");
    const now = new Date();
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const weekday = weekdays[now.getDay()];
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${weekday} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const osName = isWindows() ? "Windows" : "macOS";
    return `${getSystemPrompt()}\n\n当前运行环境信息：\n- 当前时间 (Current Time): ${dateStr}\n- 当前 ${osName} 用户名 (Username): "${username}"\n- 用户主目录 (Home Directory): "${homedir}"\n- 桌面路径 (Desktop Path): "${desktop}"`;
  } catch (err) {
    return getSystemPrompt();
  }
}

export class ConversationManager {
  private messages: ChatMessage[] = [];
  private lastActiveAt = 0;

  constructor() {
    this.messages.push({ role: "system", content: getSystemPromptWithEnv() });
  }

  isExpired(timeoutMs: number): boolean {
    if (this.lastActiveAt === 0) return false;
    return Date.now() - this.lastActiveAt > timeoutMs;
  }

  touch(): void {
    this.lastActiveAt = Date.now();
  }

  reset(): void {
    this.messages = [{ role: "system", content: getSystemPromptWithEnv() }];
    this.lastActiveAt = 0;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  setMessages(newMessages: ChatMessage[]): void {
    this.messages = [...newMessages];
    this.trimHistory();
    this.lastActiveAt = Date.now();
  }

  addUserMessage(text: string): void {
    this.trimHistory();
    this.messages.push({ role: "user", content: text });
    this.lastActiveAt = Date.now();
  }

  addAssistantMessage(text: string): void {
    this.messages.push({ role: "assistant", content: text });
    this.lastActiveAt = Date.now();
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({
      role: "tool",
      content,
      tool_call_id: toolCallId,
    });
    this.lastActiveAt = Date.now();
  }

  private trimHistory(): void {
    const maxMessages = MAX_HISTORY_MESSAGES;
    const maxTokens = MAX_HISTORY_TOKENS_ESTIMATE;

    // Keep system message + last N messages
    if (this.messages.length > maxMessages + 1) {
      const system = this.messages[0];
      this.messages = [system, ...this.messages.slice(-maxMessages)];
    }

    // Token-based trimming：按消息时间顺序裁剪最旧的，确保总量不超预算
    let totalTokens = this.messages.reduce((sum, m) => sum + messageTokens(m), 0);
    while (totalTokens > maxTokens && this.messages.length > 2) {
      const removed = this.messages.splice(1, 1)[0];
      if (removed) {
        totalTokens -= messageTokens(removed);
      } else {
        break;
      }
    }

    // Clean orphaned tool calls/responses at the very end of trimming
    this.messages = this.cleanOrphanedTools(this.messages);
  }

  private cleanOrphanedTools(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    let i = 0;

    // Always keep system prompt
    if (messages.length > 0 && messages[0].role === "system") {
      result.push(messages[0]);
      i = 1;
    }

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id));
        const group: ChatMessage[] = [msg];
        i++;

        const actualIds = new Set<string>();
        let invalidGroup = expectedIds.size !== msg.tool_calls.length;

        // Gather consecutive tool messages
        while (i < messages.length && messages[i].role === "tool") {
          const toolMsg = messages[i];
          group.push(toolMsg);

          const id = toolMsg.tool_call_id;
          if (!id || !expectedIds.has(id) || actualIds.has(id)) {
            invalidGroup = true;
          } else {
            actualIds.add(id);
          }
          i++;
        }

        const isMatch = !invalidGroup && actualIds.size === expectedIds.size;

        if (isMatch) {
          result.push(...group);
        }
      } else if (msg.role === "tool") {
        // Discard standalone tool message
        i++;
      } else {
        result.push(msg);
        i++;
      }
    }

    return result;
  }
}
