import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log, logError } from "../utils/logger";
import { runAppleScript } from "../utils/appleScript";
import { isWindows } from "../utils/windowsShell";
import * as win from "./windows";

const execFileAsync = promisify(execFile);

/**
 * 全场景感知与控制模块（macOS 实现 + Windows 分派）。
 *
 * 对标 Codex/豆包「操控电脑」能力，为 LLM 提供三类新能力：
 * 1. 屏幕感知：captureScreen / analyzeScreen —— 截屏并用视觉模型解读当前界面；
 * 2. 鼠标控制：mouseMove / mouseClick / mouseScroll / getMousePosition —— 坐标级 GUI 操作；
 * 3. 窗口感知：getWindowList / getActiveWindow —— 列出可见窗口、获取活动窗口信息。
 */

/** 截图临时目录（阅后即焚：新截图会覆盖旧文件，避免磁盘堆积） */
function screenTmpDir(): string {
  const dir = path.join(os.tmpdir(), "daisy-screen");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newScreenshotPath(): string {
  return path.join(screenTmpDir(), `screen-${Date.now()}.png`);
}

// ── 屏幕截取 ──

/** 截取整个屏幕为 PNG，返回文件路径（macOS：screencapture） */
export async function captureScreen(): Promise<string> {
  if (isWindows()) return win.captureScreen();
  const out = newScreenshotPath();
  try {
    // -x 静音、-t png 指定格式；需要「屏幕录制」权限，未授权时命令失败
    await execFileAsync("screencapture", ["-x", "-t", "png", out], { timeout: 15000 });
    if (!fs.existsSync(out)) {
      throw new Error("screencapture 未生成文件");
    }
    log(`captureScreen: saved ${out}`);
    return out;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (fs.existsSync(out)) {
      // 部分系统 screencapture 返回非 0 但已落盘，视为成功
      return out;
    }
    throw new Error(
      `截屏失败（请确认已在「系统设置 → 隐私与安全性 → 屏幕录制」中授予 Daisy 权限）：${msg.slice(0, 200)}`
    );
  }
}

/** 截屏 + 视觉模型分析屏幕内容（感知-定位-操作闭环的入口） */
export async function analyzeScreen(question?: string): Promise<string> {
  if (isWindows()) return win.analyzeScreen(question);
  const shot = await captureScreen();
  const { analyzeImage, isVisionConfigured } = await import("../vision");
  if (!isVisionConfigured()) {
    return `已截屏保存到 ${shot}，但视觉模型未配置，无法解读屏幕内容。可在设置页「视觉理解」填入 API Key（推荐免费方案：智谱 GLM-4.6V-Flash）。截图路径：${shot}`;
  }
  const q = question?.trim()
    ? `${question}\n\n请同时提取界面上的关键元素，输出结构化清单：每项包含元素类型（按钮/输入框/链接/文本等）、可见文字、以及该元素中心点在屏幕中的逻辑坐标（横坐标百分比 0-100%、纵坐标百分比 0-100%，左上角为 0%）。请用「元素类型 | 可见文字 | x% | y%」格式逐行列出，不要拒绝坐标估计，只要给出大致位置即可。`
    : "请详细描述当前屏幕上的内容：这是什么应用/界面？有哪些关键元素（按钮、输入框、链接、文字）？请逐项列出结构化清单，每项包含：元素类型、可见文字、以及该元素中心点在屏幕中的逻辑坐标（横坐标百分比 0-100%、纵坐标百分比 0-100%，左上角为 0%）。请用「元素类型 | 可见文字 | x% | y%」格式逐行列出，不要拒绝坐标估计，只要给出大致位置即可。";
  try {
    const text = await analyzeImage(shot, q);
    return `【当前屏幕分析】\n${text}\n\n截图文件：${shot}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `截屏成功（${shot}），但视觉模型分析失败：${msg}`;
  }
}

// ── 鼠标控制 ──

/**
 * 定位 cliclick 可执行文件（macOS 鼠标移动/滚动/精确点击的标准工具）。
 * 优先打包目录（assets/bin），其次常见 brew 安装路径，最后让系统解析 PATH。
 */
function resolveCliclick(): string | null {
  const candidates = [
    path.join(path.dirname(process.execPath || ""), "cliclick"),
    "/opt/homebrew/bin/cliclick",
    "/usr/local/bin/cliclick",
    "cliclick",
  ];
  for (const c of candidates) {
    if (c.includes("/") && fs.existsSync(c)) return c;
  }
  return "cliclick";
}

const CLICLICK_INSTALL_HINT =
  "请先安装 cliclick 以获得完整鼠标控制能力：终端执行 brew install cliclick，然后重试。";

export async function mouseMove(x: number, y: number): Promise<string> {
  if (isWindows()) return win.mouseMove(x, y);
  const cli = resolveCliclick();
  if (!cli) return CLICLICK_INSTALL_HINT;
  try {
    await execFileAsync(cli, [`m:${Math.round(x)},${Math.round(y)}`], { timeout: 5000 });
    return `已移动鼠标到 (${Math.round(x)}, ${Math.round(y)})`;
  } catch (error) {
    return `移动鼠标失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function mouseClick(x: number, y: number, button = "left", double = false): Promise<string> {
  if (isWindows()) return win.mouseClick(x, y, button, double);
  const rx = Math.round(x);
  const ry = Math.round(y);
  // 优先 cliclick（支持右键/双击），否则 AppleScript System Events click at 兜底（仅左键单击）
  const cli = resolveCliclick();
  if (cli) {
    try {
      const action =
        double
          ? "d"
          : button === "right"
            ? "cr"
            : button === "middle"
              ? "cm"
              : "c";
      await execFileAsync(cli, [`${action}:${rx},${ry}`], { timeout: 5000 });
      return `已${double ? "双击" : "点击"} (${rx}, ${ry})${button === "right" ? "（右键）" : ""}`;
    } catch (error) {
      return `点击失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // AppleScript 兜底：System Events 支持坐标点击（左键单击）
  try {
    await runAppleScript(`tell application "System Events" to click at {${rx}, ${ry}}`);
    return `已点击 (${rx}, ${ry})`;
  } catch (error) {
    return `点击失败（${CLICLICK_INSTALL_HINT}）：${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function mouseScroll(delta: number): Promise<string> {
  if (isWindows()) return win.mouseScroll(delta);
  const cli = resolveCliclick();
  if (!cli) return CLICLICK_INSTALL_HINT;
  try {
    // 负数向下滚、正数向上滚（cliclick w: 用 - 表示下）
    await execFileAsync(cli, [`w:${delta > 0 ? "" : "-"}${Math.abs(Math.round(delta))}`], { timeout: 5000 });
    return `已滚动 ${delta > 0 ? "向上" : "向下"} ${Math.abs(delta)} 格`;
  } catch (error) {
    return `滚动失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getMousePosition(): Promise<string> {
  if (isWindows()) return win.getMousePosition();
  const cli = resolveCliclick();
  if (!cli) return CLICLICK_INSTALL_HINT;
  try {
    // cliclick p 输出形如 "x,y"
    const { stdout } = await execFileAsync(cli, ["p"], { timeout: 5000 });
    const pos = stdout.trim();
    if (pos && pos.includes(",")) {
      const [px, py] = pos.split(",").map((n) => parseInt(n.trim(), 10));
      return `当前鼠标位置: (${px}, ${py})`;
    }
    return `鼠标位置: ${pos}`;
  } catch (error) {
    return `获取鼠标位置失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── 窗口感知 ──

/** 列出所有可见窗口（应用名、窗口标题、位置、大小） */
export async function getWindowList(): Promise<string> {
  if (isWindows()) return win.getWindowList();
  const script = `
tell application "System Events"
    set output to ""
    repeat with p in (application processes whose visible is true)
        set pName to name of p
        try
            repeat with w in (windows of p)
                set wTitle to ""
                try
                    set wTitle to name of w
                end try
                set wPos to position of w
                set wSize to size of w
                set wX to item 1 of wPos
                set wY to item 2 of wPos
                set wW to item 1 of wSize
                set wH to item 2 of wSize
                if wTitle is not "" then
                    set output to output & pName & "|" & wTitle & "|" & wX & "," & wY & "|" & wW & "x" & wH & linefeed
                end if
            end repeat
        end try
    end repeat
    return output
end tell
`;
  try {
    const stdout = await runAppleScript(script);
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return "当前没有可见窗口。";
    const formatted = lines
      .map((line) => {
        const [app, title, pos, size] = line.split("|");
        return `- ${app}：「${title}」 位置(${pos}) 尺寸(${size})`;
      })
      .join("\n");
    return `当前可见窗口（${lines.length} 个）：\n${formatted}`;
  } catch (error) {
    return `获取窗口列表失败: ${error instanceof Error ? error.message : String(error)}。请确认已授予辅助功能权限。`;
  }
}

/** 获取当前活动窗口信息（应用、窗口标题、位置、大小） */
export async function getActiveWindow(): Promise<string> {
  if (isWindows()) return win.getActiveWindow();
  const script = `
tell application "System Events"
    set frontProc to first application process whose frontmost is true
    set appName to name of frontProc
    set winTitle to ""
    set winPos to ""
    set winSize to ""
    try
        set w to window 1 of frontProc
        set winTitle to name of w
        set p to position of w
        set s to size of w
        set winPos to (item 1 of p as text) & "," & (item 2 of p as text)
        set winSize to (item 1 of s as text) & "x" & (item 2 of s as text)
    end try
    return appName & "|" & winTitle & "|" & winPos & "|" & winSize
end tell
`;
  try {
    const stdout = await runAppleScript(script);
    const [app, title, pos, size] = stdout.split("|");
    return `当前活动窗口：\n- 应用：${app}\n- 标题：${title || "（无标题）"}\n- 位置：${pos || "未知"} 尺寸：${size || "未知"}`;
  } catch (error) {
    return `获取活动窗口失败: ${error instanceof Error ? error.message : String(error)}。请确认已授予辅助功能权限。`;
  }
}

// 防循环导入：Windows 分派函数若缺失会抛出，这里统一兜底
export async function captureScreenSafe(): Promise<string> {
  try {
    return await captureScreen();
  } catch (error) {
    logError("captureScreen failed", error);
    return `截屏失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
