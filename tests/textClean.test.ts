import { describe, it, expect } from "vitest";
import { cleanTextForTTS } from "../src/main/utils/textClean";

describe("cleanTextForTTS", () => {
  it("剥离 display 块（历史兼容）并去 speech 标签", () => {
    expect(cleanTextForTTS("<display>你好</display>")).toBe("");
    expect(cleanTextForTTS("<speech>语音</speech>")).toBe("语音");
  });

  it("JSON 残余清理为最佳努力（保留可读内容）", () => {
    const r = cleanTextForTTS('{"display":"Markdown文本","speech":"纯文本"}');
    expect(r).toContain("Markdown文本");
    expect(r).toContain("纯文本");
    expect(r).not.toContain("{");
    expect(r).not.toContain("display");
    expect(r).not.toContain("speech");
  });

  it("还原转义换行", () => {
    expect(cleanTextForTTS("第一行\\n第二行")).toBe("第一行 第二行");
  });

  it("代码块整体移除、行内代码解包", () => {
    expect(cleanTextForTTS("```js\nconsole.log(1)\n``` 这是 `code`")).toBe("这是 code");
  });

  it("去除加粗与斜体", () => {
    expect(cleanTextForTTS("**粗体** 和 *斜体* 和 ***粗斜体***")).toBe("粗体 和 斜体 和 粗斜体");
  });

  it("去除标题符，保留单换行（句间停顿）", () => {
    expect(cleanTextForTTS("# 标题\n## 二级标题")).toBe("标题\n二级标题");
  });

  it("链接转文字、图片链接整体删除", () => {
    expect(cleanTextForTTS("[Daisy](https://example.com) ![图](img.png)")).toBe("Daisy");
    expect(cleanTextForTTS("![装饰图](a.png)[链接](b.com)")).toBe("链接");
  });

  it("去除列表符号，保留换行", () => {
    expect(cleanTextForTTS("- 第一项\n- 第二项")).toBe("第一项\n第二项");
    expect(cleanTextForTTS("1. 第一步\n2. 第二步")).toBe("第一步\n第二步");
  });

  it("去除引用符号", () => {
    expect(cleanTextForTTS("> 引用内容")).toBe("引用内容");
  });

  it("去除 emoji", () => {
    expect(cleanTextForTTS("你好 🎉 世界")).toBe("你好 世界");
  });

  it("温度单位统一替换为度", () => {
    expect(cleanTextForTTS("今天 35℃ 很热")).toBe("今天 35度 很热");
    expect(cleanTextForTTS("36°C")).toBe("36度");
    expect(cleanTextForTTS("30°")).toBe("30度");
  });

  it("~ 替换为到", () => {
    expect(cleanTextForTTS("3~5 天")).toBe("3到5 天");
  });

  it("折叠多余空白并去除首尾", () => {
    expect(cleanTextForTTS("  你好    世界  ")).toBe("你好 世界");
  });

  it("保留纯中文文本原样", () => {
    expect(cleanTextForTTS("今天天气真不错")).toBe("今天天气真不错");
  });
});
