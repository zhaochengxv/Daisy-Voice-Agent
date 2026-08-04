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
});
