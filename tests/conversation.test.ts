import { describe, it, expect, vi, afterEach } from "vitest";
import { ConversationManager } from "../src/main/llm/conversation";

function newManager(): ConversationManager {
  return new ConversationManager();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConversationManager", () => {
  it("构造函数包含系统提示词", () => {
    const msgs = newManager().getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("system");
  });

  it("添加用户与助手消息保持顺序", () => {
    const cm = newManager();
    cm.addUserMessage("你好");
    cm.addAssistantMessage("你好！有什么可以帮你？");
    const msgs = cm.getMessages();
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(msgs[1].content).toBe("你好");
  });

  it("超过 30 条按消息数裁剪最旧（保留系统提示）", () => {
    const cm = newManager();
    for (let i = 1; i <= 40; i++) cm.addUserMessage(`消息${i}`);
    const msgs = cm.getMessages();
    // trim 发生在 push 前，最终保留 system + 最新 30 条 + 当前新消息
    expect(msgs.length).toBe(32);
    expect(msgs[1].content).toBe("消息10");
    expect(msgs[31].content).toBe("消息40");
  });

  it("token 超预算时按时间裁剪最旧消息", () => {
    const cm = newManager();
    for (let i = 1; i <= 8; i++) {
      cm.addUserMessage(`M${i}` + "长".repeat(6000));
    }
    const msgs = cm.getMessages();
    // 每条约 6000 tokens，预算 32000：必须裁掉最旧的，且最新消息 M8 必须保留。
    // （系统提示词含技能目录/环境信息，长度随版本浮动，故只断言裁剪不变量而非精确条数）
    expect(msgs[0].role).toBe("system");
    expect(msgs.length).toBeLessThan(9);
    expect(msgs[msgs.length - 1].content.startsWith("M8")).toBe(true);
    expect(msgs[1].content.startsWith("M1")).toBe(false);
  });

  it("保留完整有效的工具调用组", () => {
    const cm = newManager();
    cm.setMessages([
      { role: "system", content: "你是 Daisy" },
      { role: "user", content: "几点了" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }] },
      { role: "tool", content: "10:00", tool_call_id: "call_1" },
      { role: "assistant", content: "现在是十点" },
    ]);
    const msgs = cm.getMessages();
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(msgs[2].tool_calls?.[0].id).toBe("call_1");
  });

  it("清理孤立工具消息与不匹配的工具调用组", () => {
    const cm = newManager();
    cm.setMessages([
      { role: "system", content: "你是 Daisy" },
      { role: "user", content: "查一下天气" },
      { role: "assistant", content: "好的" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_current_time", arguments: "{}" } }] },
      { role: "tool", content: "10:00", tool_call_id: "call_1" },
      { role: "tool", content: "孤立的", tool_call_id: "call_99" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "weather_forecast", arguments: "{}" } }] },
      { role: "tool", content: "晴", tool_call_id: "call_3" },
    ]);
    const msgs = cm.getMessages();
    // 孤立 tool 与不匹配组整体剔除，仅保留有效对话
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    expect(msgs.some((m) => m.tool_calls)).toBe(false);
  });

  it("reset 清空历史并重建系统提示", () => {
    const cm = newManager();
    cm.addUserMessage("你好");
    cm.reset();
    const msgs = cm.getMessages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("system");
    expect(cm.isExpired(1000)).toBe(false);
  });

  it("过期判断基于最近活跃时间", () => {
    const cm = newManager();
    expect(cm.isExpired(300000)).toBe(false);
    cm.touch();
    expect(cm.isExpired(300000)).toBe(false);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 400000);
    expect(cm.isExpired(300000)).toBe(true);
  });
});
