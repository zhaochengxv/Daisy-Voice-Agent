import { describe, it, expect } from "vitest";
import {
  escapeSendKeys,
  buildSendKeys,
  keyToVk,
  parseHotkey,
  progIdToBrowserName,
} from "../src/main/control/windows";
import { isWindows } from "../src/main/utils/windowsShell";

describe("escapeSendKeys", () => {
  it("普通文本不受影响", () => {
    expect(escapeSendKeys("你好 world 123")).toBe("你好 world 123");
  });

  it("特殊字符包进 {} 中", () => {
    expect(escapeSendKeys("a+b")).toBe("a{+}b");
    expect(escapeSendKeys("100%")).toBe("100{%}");
    expect(escapeSendKeys("(test)")).toBe("{(}test{)}");
  });

  it("花括号自身被转义", () => {
    expect(escapeSendKeys("{x}")).toBe("{{}x{}}");
  });

  it("波浪号与脱字符被转义", () => {
    expect(escapeSendKeys("a~^b")).toBe("a{~}{^}b");
  });
});

describe("buildSendKeys", () => {
  it("单字符无修饰键", () => {
    expect(buildSendKeys("a")).toBe("a");
  });

  it("ctrl+shift+a", () => {
    expect(buildSendKeys("ctrl+shift+a")).toBe("^+a");
  });

  it("alt 别名 → %", () => {
    expect(buildSendKeys("alt+tab")).toBe("%{TAB}");
  });

  it("command/cmd/win 在 Windows 映射为 % (ALT)", () => {
    expect(buildSendKeys("cmd+c")).toBe("%c");
    expect(buildSendKeys("command+c")).toBe("%c");
    expect(buildSendKeys("win+d")).toBe("%d");
  });

  it("大小写与空格归一化", () => {
    expect(buildSendKeys(" Ctrl + Shift + Enter ")).toBe("^+{ENTER}");
  });

  it("已知功能键映射为 SendKeys 常量", () => {
    expect(buildSendKeys("ctrl+esc")).toBe("^{ESC}");
    expect(buildSendKeys("ctrl+backspace")).toBe("^{BACKSPACE}");
  });

  it("未知修饰词被忽略", () => {
    expect(buildSendKeys("foo+a")).toBe("a");
  });
});

describe("progIdToBrowserName", () => {
  it("已知 ProgId 映射为浏览器名", () => {
    expect(progIdToBrowserName("ChromeHTML")).toBe("Google Chrome");
    expect(progIdToBrowserName("MSEdgeHTM")).toBe("Microsoft Edge");
    expect(progIdToBrowserName("FirefoxURL")).toBe("Firefox");
  });

  it("未知 ProgId 默认 Microsoft Edge", () => {
    expect(progIdToBrowserName("WhateverApp")).toBe("Microsoft Edge");
  });
});

describe("keyToVk", () => {
  it("字母映射为 VK 大写 ASCII", () => {
    expect(keyToVk("a")).toBe(0x41);
    expect(keyToVk("Z")).toBe(0x5A);
  });

  it("数字映射为 VK", () => {
    expect(keyToVk("1")).toBe(0x31);
  });

  it("功能键映射为系统 VK", () => {
    expect(keyToVk("enter")).toBe(0x0D);
    expect(keyToVk("esc")).toBe(0x1B);
    expect(keyToVk("space")).toBe(0x20);
    expect(keyToVk("delete")).toBe(0x2E);
  });

  it("无法映射的符号返回 null", () => {
    expect(keyToVk(".")).toBeNull();
    expect(keyToVk("-")).toBeNull();
  });
});

describe("parseHotkey", () => {
  it("无修饰键", () => {
    const hk = parseHotkey("a");
    expect(hk).not.toBeNull();
    expect(hk!.ctrl).toBe(false);
    expect(hk!.win).toBe(false);
    expect(hk!.mainKey).toBe("a");
  });

  it("win+ctrl+d 全解析", () => {
    const hk = parseHotkey("win+ctrl+d");
    expect(hk!.win).toBe(true);
    expect(hk!.ctrl).toBe(true);
    expect(hk!.mainKey).toBe("d");
  });

  it("cmd/command 别名映射为 win", () => {
    expect(parseHotkey("cmd+c")!.win).toBe(true);
    expect(parseHotkey("command+c")!.win).toBe(true);
  });

  it("大小写与空格归一化", () => {
    const hk = parseHotkey(" Ctrl + Shift + Enter ");
    expect(hk!.ctrl).toBe(true);
    expect(hk!.shift).toBe(true);
    expect(hk!.mainKey).toBe("enter");
  });

  it("未知修饰词返回 null", () => {
    expect(parseHotkey("foo+a")).toBeNull();
  });

  it("空输入返回 null", () => {
    expect(parseHotkey("")).toBeNull();
    expect(parseHotkey("++")).toBeNull();
  });
});

describe("isWindows", () => {
  it("linux 沙箱上为 false", () => {
    expect(isWindows()).toBe(process.platform === "win32");
  });
});
