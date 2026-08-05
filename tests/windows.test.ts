import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const electronMockState = vi.hoisted(() => ({ userDataDir: "/__daisy_no_gpu__" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMockState.userDataDir,
    getAppPath: () => electronMockState.userDataDir,
  },
}));

vi.mock("../src/main/utils/windowsShell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/utils/windowsShell")>();
  return {
    ...actual,
    runPowerShell: vi.fn(async () => {
      throw new Error("powershell unavailable in test env");
    }),
  };
});

import {
  escapeSendKeys,
  buildSendKeys,
  keyToVk,
  parseHotkey,
  progIdToBrowserName,
  getWindowsDesktopPath,
  openUrl,
  openApplication,
} from "../src/main/control/windows";
import { isWindows, runPowerShell } from "../src/main/utils/windowsShell";

beforeEach(() => {
  vi.mocked(runPowerShell).mockClear();
});

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

describe("getWindowsDesktopPath", () => {
  it("runPowerShell 失败时回退到 ~/Desktop（不依赖真实平台）", async () => {
    const result = await getWindowsDesktopPath();
    expect(result).toBe(path.join(os.homedir(), "Desktop"));
  });
});

describe("openUrl（v1.5.10 explorer 退出码 1 修复）", () => {
  it("runPowerShell 正常返回时不再误报失败", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("");
    const result = await openUrl("example.com");
    expect(result).toContain("已用默认浏览器打开");
    expect(result).toContain("https://example.com");
    expect(runPowerShell).toHaveBeenCalledTimes(1);
  });

  it("URL 缺少协议时自动补 https://", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("");
    const result = await openUrl("example.com/a?q=1");
    expect(result).toContain("https://example.com/a?q=1");
  });

  it("已带协议不重复叠加", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("");
    const result = await openUrl("https://daisy.example.com/path");
    expect(result).toContain("https://daisy.example.com/path");
  });

  it("runPowerShell 抛错时返回失败信息而非永远成功", async () => {
    vi.mocked(runPowerShell).mockRejectedValueOnce(new Error("Start-Process failed"));
    const result = await openUrl("example.com");
    expect(result).toContain("打开网址失败");
  });
});

describe("openApplication（v1.5.10 PS 非零退出吞 OK 输出修复）", () => {
  it("OK: 前缀 → 返回已打开", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("OK:C:\\Windows\\System32\\notepad.exe");
    const result = await openApplication("notepad");
    expect(result).toBe("已打开 notepad");
    expect(runPowerShell).toHaveBeenCalledTimes(1);
  });

  it("FAIL:EXE_NOT_FOUND → 抛错（由调用方按 handled:false 处理，避免 LLM 空转）", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("FAIL:EXE_NOT_FOUND");
    await expect(openApplication("不存在的应用xyz")).rejects.toThrow();
  });

  it("runPowerShell 失败不再静默吞掉返回已打开", async () => {
    vi.mocked(runPowerShell).mockRejectedValueOnce(new Error("powershell exit 1"));
    await expect(openApplication("chrome")).rejects.toThrow();
  });
});

describe("isWindows", () => {
  it("linux 沙箱上为 false", () => {
    expect(isWindows()).toBe(process.platform === "win32");
  });
});

describe("whisperNeedsNoGpu", () => {
  it("非 win32 平台恒为 false（macOS 保留 GPU）", async () => {
    const { whisperNeedsNoGpu } = await import("../src/main/config/env");
    // 用 Object.defineProperty 隔离平台，避免污染其他用例
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      expect(whisperNeedsNoGpu()).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("win32 上无 ggml-cuda.dll 时强制 CPU（-ng）", async () => {
    const { whisperNeedsNoGpu } = await import("../src/main/config/env");
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      // 沙箱环境不是 win32 真实打包，getBundledBin 会返回带 .exe 的 PATH 兜底路径，
      // bin 目录不存在 ggml-cuda.dll → 应强制 CPU。
      expect(whisperNeedsNoGpu()).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("win32 已部署 GPU 组件（存在 ggml-cuda.dll）时自动放行 GPU", async () => {
    const env = await import("../src/main/config/env");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-gpu-test-"));
    const binDir = path.join(tmp, "whisper-gpu", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, "ggml-cuda.dll"), "");
    fs.writeFileSync(path.join(binDir, "whisper-server.exe"), "");
    electronMockState.userDataDir = tmp;
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      expect(env.hasWhisperGpu()).toBe(true);
      expect(env.whisperNeedsNoGpu()).toBe(false);
      // getWhisperBin 优先 GPU 目录下的 .exe
      expect(env.getWhisperBin("whisper-server")).toBe(path.join(binDir, "whisper-server.exe"));
    } finally {
      Object.defineProperty(process, "platform", original);
      electronMockState.userDataDir = "/__daisy_no_gpu__";
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("defaultWhisperModel", () => {
  it("≥8 核默认推荐 ggml-small.bin（高配提准确率）", async () => {
    const env = await import("../src/main/config/env");
    const cpusSpy = vi.spyOn(os, "cpus").mockReturnValue(new Array(8).fill({} as os.CpuInfo));
    try {
      expect(env.defaultWhisperModel()).toBe("ggml-small.bin");
    } finally {
      cpusSpy.mockRestore();
    }
  });

  it("低配(<8 核)默认推荐 ggml-base.bin（保响应）", async () => {
    const env = await import("../src/main/config/env");
    const cpusSpy = vi.spyOn(os, "cpus").mockReturnValue(new Array(4).fill({} as os.CpuInfo));
    try {
      expect(env.defaultWhisperModel()).toBe("ggml-base.bin");
    } finally {
      cpusSpy.mockRestore();
    }
  });
});
