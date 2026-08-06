import { describe, it, expect } from "vitest";
import {
  availableTools,
  adaptToolsForPlatform,
  MAC_ONLY_TOOLS,
} from "../src/main/llm/tools";

describe("adaptToolsForPlatform", () => {
  it("macOS 平台不修改任何工具定义", () => {
    const adapted = adaptToolsForPlatform(availableTools, false);
    expect(adapted).toBe(availableTools);
  });

  it("Windows 平台给全部 macOS 专属工具加降级标注", () => {
    const adapted = adaptToolsForPlatform(availableTools, true);
    for (const name of MAC_ONLY_TOOLS) {
      const tool = adapted.find((t) => t.function.name === name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool!.function.description).toContain("仅支持 macOS");
    }
  });

  it("Windows 平台不修改跨平台工具", () => {
    const adapted = adaptToolsForPlatform(availableTools, true);
    const crossPlatform = ["web_search", "weather_forecast", "open_url", "set_timer", "read_file"];
    for (const name of crossPlatform) {
      const tool = adapted.find((t) => t.function.name === name);
      const original = availableTools.find((t) => t.function.name === name);
      expect(tool!.function.description).toBe(original!.function.description);
    }
  });

  it("macOS 专属工具在可用工具中全部存在", () => {
    const names = new Set(availableTools.map((t) => t.function.name));
    for (const name of MAC_ONLY_TOOLS) {
      expect(names.has(name), `tool ${name} missing from availableTools`).toBe(true);
    }
  });

  it("Windows 平台给已实现等价功能的工具替换 Windows 描述", () => {
    const adapted = adaptToolsForPlatform(availableTools, true);
    const checks: Array<[string, (d: string) => boolean]> = [
      ["create_note", (d) => d.includes("Daisy备忘录")],
      ["create_reminder", (d) => d.includes("蜂鸣")],
      ["create_calendar_event", (d) => d.includes("Outlook")],
      ["convert_document", (d) => d.includes("Word")],
      ["send_email", (d) => d.includes("Outlook")],
    ];
    for (const [name, predicate] of checks) {
      const tool = adapted.find((t) => t.function.name === name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(predicate(tool!.function.description), `${name} description should be Windows-specific`).toBe(true);
    }
  });

  it("Windows 平台已实现工具不再带仅支持 macOS 标注", () => {
    const adapted = adaptToolsForPlatform(availableTools, true);
    for (const name of ["create_note", "search_notes", "create_reminder", "create_calendar_event", "get_calendar_events", "switch_audio_output", "send_email", "read_unread_emails", "get_recent_emails", "search_emails", "convert_document", "edit_document", "edit_pdf", "run_python", "pdf_to_excel", "read_excel"]) {
      const tool = adapted.find((t) => t.function.name === name);
      expect(tool, `tool ${name} should exist`).toBeDefined();
      expect(tool!.function.description, `${name} should not claim macOS-only`).not.toContain("仅支持 macOS");
    }
  });

  it("Windows 平台新增 Python 技能工具带专属描述", () => {
    const adapted = adaptToolsForPlatform(availableTools, true);
    const tool = adapted.find((t) => t.function.name === "pdf_to_excel");
    expect(tool!.function.description).toContain("pdfplumber");
  });
});
