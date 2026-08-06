import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
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

vi.mock("../src/main/utils/pythonRuntime", () => ({
  findPython: vi.fn(async () => null),
  hasPythonLibrary: vi.fn(async () => false),
  runPythonCode: vi.fn(async () => ({ stdout: "", stderr: "" })),
  resetPythonCache: () => {},
  pythonMissingHint: (libs?: string[]) => `未检测到 Python 3${libs && libs.length ? `，需安装依赖：${libs.join(" ")}` : ""}`,
  pythonLibMissingHint: (_exe: string, libs: string[]) => `检测到 Python 但缺少依赖库：${libs.join("、")}，请 pip install ${libs.join(" ")}`,
}));

import {
  escapeSendKeys,
  buildSendKeys,
  keyToVk,
  parseHotkey,
  progIdToBrowserName,
  getWindowsDesktopPath,
  openUrl,
  openApplication,
  runShellCommand,
  translateBashToPowerShell,
  inferShellTimeout,
  convertDocument,
  formatBytes,
  editPdf,
  pdfToExcel,
  readExcel,
  runPython,
} from "../src/main/control/windows";
import { isWindows, runPowerShell } from "../src/main/utils/windowsShell";
import { findPython, hasPythonLibrary, runPythonCode } from "../src/main/utils/pythonRuntime";

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

describe("runShellCommand（v1.5.11 修复 $env:DAISY_ARG0 只回显不执行）", () => {
  it("用 Invoke-Expression 真实执行命令并合并 stderr 输出", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("notepad 正在运行");
    const result = await runShellCommand("Get-Process notepad | Out-String");
    expect(result.stdout).toBe("notepad 正在运行");
    expect(result.stderr).toBe("");
    const [script, options] = vi.mocked(runPowerShell).mock.calls[0];
    expect(script).toContain("Invoke-Expression $env:DAISY_ARG0");
    expect(script).toContain("2>&1");
    expect(options?.args).toEqual(["Get-Process notepad | Out-String"]);
    expect(options?.timeoutMs).toBe(30000);
  });

  it("用户命令经 DAISY_ARG0 注入而非拼接进脚本", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("");
    await runShellCommand("winget search wps");
    const [script, options] = vi.mocked(runPowerShell).mock.calls[0];
    expect(script).not.toContain("winget search wps");
    expect(options?.args).toEqual(["winget search wps"]);
  });

  it("runPowerShell 失败时错误回流 stderr 而非静默空输出", async () => {
    vi.mocked(runPowerShell).mockRejectedValueOnce(new Error("command not recognized"));
    const result = await runShellCommand("not-a-real-command");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("command not recognized");
  });
});

describe("translateBashToPowerShell（v1.5.16 新增：LLM 生成的 bash 语法自动翻译）", () => {
  it("&& 翻译为分号并给出警告", () => {
    const { translated, warnings } = translateBashToPowerShell("dir && echo done");
    expect(translated).toContain("dir");
    expect(translated).toContain("echo done");
    expect(translated).not.toContain("&&");
    expect(warnings.some((w) => w.includes("&&"))).toBe(true);
  });

  it("|| 翻译为换行依次执行", () => {
    const { translated, warnings } = translateBashToPowerShell("taskkill /f /im a.exe || echo killed");
    expect(translated).not.toContain("||");
    expect(warnings.some((w) => w.includes("||"))).toBe(true);
  });

  it("2>nul 与 /dev/null 翻译为 2>$null / $null", () => {
    const { translated } = translateBashToPowerShell("dir 2>nul && echo ok");
    expect(translated).toContain("2>$null");
    expect(translated).toContain("$null");
    expect(translated).not.toContain("2>nul");
  });

  it("where 改为 where.exe，which 改为 Get-Command", () => {
    const { translated } = translateBashToPowerShell("where python && which node");
    expect(translated).toContain("where.exe python");
    expect(translated).toContain("Get-Command node");
  });

  it("grep/head/tail 仅提示不改写", () => {
    const { translated, warnings } = translateBashToPowerShell("ls | grep foo | head -n 3");
    expect(warnings.some((w) => w.includes("Select-String"))).toBe(true);
    expect(warnings.some((w) => w.includes("Select-Object"))).toBe(true);
    expect(translated).toContain("grep foo");
  });

  it("纯 PowerShell 命令零改动零警告", () => {
    const { translated, warnings } = translateBashToPowerShell("Get-Process | Out-String");
    expect(translated).toBe("Get-Process | Out-String");
    expect(warnings).toHaveLength(0);
  });
});

describe("inferShellTimeout（v1.5.16 新增：超时分层防 15s 误杀长任务）", () => {
  it("下载/安装/视频处理类命令给 5 分钟", () => {
    expect(inferShellTimeout("curl.exe -L -o ffmpeg.zip https://x/ffmpeg.zip")).toBe(5 * 60 * 1000);
    expect(inferShellTimeout("winget install -e --id Python.Python")).toBe(5 * 60 * 1000);
    expect(inferShellTimeout("ffmpeg -i in.mp4 out.mp4")).toBe(5 * 60 * 1000);
    expect(inferShellTimeout("yt-dlp https://example.com/video")).toBe(5 * 60 * 1000);
  });

  it("sleep/等待/脚本类命令给 2 分钟", () => {
    expect(inferShellTimeout("Start-Sleep -Seconds 60")).toBe(2 * 60 * 1000);
    expect(inferShellTimeout("python script.py")).toBe(2 * 60 * 1000);
  });

  it("常规命令 30 秒", () => {
    expect(inferShellTimeout("Get-Process | Out-String")).toBe(30 * 1000);
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

describe("convertDocument 落盘校验（杜绝假成功）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-cvt-test-"));
  const srcPdf = path.join(tmp, "source.pdf");
  const srcTxt = path.join(tmp, "source.txt");
  fs.writeFileSync(srcPdf, "%PDF-1.4 fake content");
  fs.writeFileSync(srcTxt, "你好，Daisy 纯文本内容");

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("纯文本 txt→md 直转：落盘确定，返回成功", async () => {
    const dst = path.join(tmp, "out.md");
    const r = await convertDocument(srcTxt, dst);
    expect(r).toContain("已转换文档");
    expect(fs.existsSync(dst)).toBe(true);
    expect(r).toContain("out.md");
  });

  it("Word 路由 OUTPUT_OK 时如实返回成功（含产物大小）", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("OUTPUT_OK:2048");
    const dst = path.join(tmp, "out.docx");
    const r = await convertDocument(srcTxt, dst);
    expect(r).toContain("已转换文档");
    expect(r).toContain("2.0 KB");
  });

  it("Word 路由 OUTPUT_MISSING 时如实报失败，不虚报成功", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("OUTPUT_MISSING");
    const dst = path.join(tmp, "out_missing.docx");
    const r = await convertDocument(srcTxt, dst);
    expect(r).not.toContain("已转换");
    expect(r).toContain("转换失败");
  });

  it("Word 路由 OUTPUT_EMPTY 时如实报失败（产物为空）", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("OUTPUT_EMPTY");
    const dst = path.join(tmp, "out_empty.docx");
    const r = await convertDocument(srcTxt, dst);
    expect(r).not.toContain("已转换");
    expect(r).toContain("为空");
  });

  it("Word 返回 NO_WORD 时返回 Office 引导提示", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("NO_WORD");
    const dst = path.join(tmp, "out_noword.docx");
    const r = await convertDocument(srcTxt, dst);
    expect(r).toContain("Outlook/Word");
  });

  it("PDF→txt：无 Python 且 Word 未落盘时，如实报失败并给出安装提示", async () => {
    vi.mocked(runPowerShell).mockResolvedValueOnce("OUTPUT_MISSING");
    const dst = path.join(tmp, "out.pdf.txt");
    const r = await convertDocument(srcPdf, dst);
    expect(r).not.toContain("已转换");
    expect(r).toContain("提取失败");
    expect(r).toContain("Python");
  });

  it("PDF→txt：Python 提取为空时明确提示可能是扫描图片版", async () => {
    // 模拟有 Python 但提取结果为空（execFileAsync 走 no_python → Word 兜底 → 空）
    vi.mocked(runPowerShell).mockResolvedValueOnce("OUTPUT_EMPTY");
    const dst = path.join(tmp, "scan.txt");
    const r = await convertDocument(srcPdf, dst);
    expect(r).not.toContain("已转换");
    expect(r).toContain("扫描");
  });

  it("源文件不存在时给出明确提示", async () => {
    const r = await convertDocument(path.join(tmp, "nope.pdf"), path.join(tmp, "nope.txt"));
    expect(r).toContain("找不到源文件");
  });

  it("formatBytes 人类可读", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("Python 技能工具（v1.5.17：edit_pdf 跨平台化 + pdf_to_excel/read_excel/run_python）", () => {
  beforeEach(() => {
    vi.mocked(findPython).mockReset();
    vi.mocked(hasPythonLibrary).mockReset();
    vi.mocked(runPythonCode).mockReset();
    vi.mocked(findPython).mockResolvedValue(null);
  });

  it("edit_pdf：无 Python 时给出安装引导（不再仅支持 macOS）", async () => {
    const r = await editPdf("a.pdf", "b.pdf", "find", "资产负债表");
    expect(r).not.toContain("仅支持 macOS");
    expect(r).toContain("Python");
  });

  it("edit_pdf：find 操作成功时返回坐标", async () => {
    vi.mocked(findPython).mockResolvedValueOnce({ exe: "py", isWindows: true });
    vi.mocked(hasPythonLibrary).mockResolvedValue(true);
    vi.mocked(runPythonCode).mockResolvedValueOnce({ stdout: "找到 2 处\n页3 (100,200,300,400)", stderr: "" });
    const r = await editPdf("a.pdf", "b.pdf", "find", "资产负债表");
    expect(r).toContain("找到 2 处");
    expect(r).toContain("页3");
  });

  it("edit_pdf：fill 操作成功时返回保存信息", async () => {
    vi.mocked(findPython).mockResolvedValueOnce({ exe: "py", isWindows: true });
    vi.mocked(hasPythonLibrary).mockResolvedValue(true);
    vi.mocked(runPythonCode).mockResolvedValueOnce({ stdout: "已填入 1 处", stderr: "" });
    const r = await editPdf("a.pdf", "b.pdf", "fill", undefined, "签名处", "张三");
    expect(r).toContain("已编辑 PDF");
    expect(r).toContain("b.pdf");
  });

  it("pdf_to_excel：成功时返回表格统计", async () => {
    vi.mocked(findPython).mockResolvedValueOnce({ exe: "py", isWindows: true });
    vi.mocked(hasPythonLibrary).mockResolvedValue(true);
    vi.mocked(runPythonCode).mockResolvedValueOnce({ stdout: "OK:sheets=2 rows=45", stderr: "" });
    const r = await pdfToExcel("report.pdf", "report.xlsx");
    expect(r).toContain("2 个表格");
    expect(r).toContain("45 行");
  });

  it("pdf_to_excel：无表格时如实提示", async () => {
    vi.mocked(findPython).mockResolvedValueOnce({ exe: "py", isWindows: true });
    vi.mocked(hasPythonLibrary).mockResolvedValue(true);
    vi.mocked(runPythonCode).mockResolvedValueOnce({ stdout: "NO_TABLES", stderr: "" });
    const r = await pdfToExcel("scan.pdf", "out.xlsx");
    expect(r).toContain("未");
  });

  it("read_excel：返回结构化 JSON", async () => {
    vi.mocked(findPython).mockResolvedValueOnce({ exe: "py", isWindows: true });
    vi.mocked(hasPythonLibrary).mockResolvedValue(true);
    vi.mocked(runPythonCode).mockResolvedValueOnce({
      stdout: '[{"sheet": "收支表", "row_count": 3, "rows": [["项目", "金额"], ["收入", "100"]]}]',
      stderr: "",
    });
    const r = await readExcel("t.xlsx", 10);
    expect(r).toContain("收支表");
    expect(r).toContain("100");
  });

  it("run_python：透传脚本输出", async () => {
    vi.mocked(findPython).mockResolvedValueOnce({ exe: "py", isWindows: true });
    vi.mocked(runPythonCode).mockResolvedValueOnce({ stdout: "[1, 2, 3]\n均值 2.0", stderr: "" });
    const r = await runPython("print([1,2,3])");
    expect(r).toContain("均值 2.0");
  });

  it("run_python：无 Python 时给出安装引导", async () => {
    const r = await runPython("print(1)");
    expect(r).toContain("Python");
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
