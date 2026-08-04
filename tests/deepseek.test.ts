import { describe, it, expect } from "vitest";
import { getChatCompletionsUrl, isCompoundActionRequest } from "../src/main/llm/deepseek";

describe("getChatCompletionsUrl", () => {
  it("无 v1 后缀自动补全", () => {
    expect(getChatCompletionsUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("已有 v1 后缀不重复", () => {
    expect(getChatCompletionsUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("去除尾部斜杠", () => {
    expect(getChatCompletionsUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("保留自定义网关路径", () => {
    expect(getChatCompletionsUrl("https://gateway.example.com/v1")).toBe("https://gateway.example.com/v1/chat/completions");
  });
});

describe("isCompoundActionRequest", () => {
  it("含连接词判定为复合请求", () => {
    expect(isCompoundActionRequest("打开浏览器然后搜索天气")).toBe(true);
  });

  it("单一动作不误判", () => {
    expect(isCompoundActionRequest("打开微信")).toBe(false);
  });

  it("多个动作动词判定为复合请求", () => {
    expect(isCompoundActionRequest("打开微信搜索天气")).toBe(true);
  });
});
