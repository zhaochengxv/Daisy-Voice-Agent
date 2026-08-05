import path from "node:path";
import { BrowserWindow, screen } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { log } from "../utils/logger";
import { isWindows } from "../utils/windowsShell";
import { getSettingsWindow, createSettingsWindow } from "./settingsWindow";

const ORB_SIZE = 92;
// 三区布局：左 orb（点击录音开关）+ 中 ASR 实时文本 + 右 LLM 滚动输出。
// 窗口整体加宽，orb 仍按 ORB_SIZE 定位在左侧，两个文本区依次排开。
const ASR_TEXT_WIDTH = 220;
const LLM_OUTPUT_WIDTH = 280;
const PANEL_HEIGHT = 140;

let floatWindow: BrowserWindow | null = null;

let hideTimeout: NodeJS.Timeout | null = null;
let isLoaded = false;
let pendingShow = false;

export function createFloatWindow(): BrowserWindow {
  if (floatWindow && !floatWindow.isDestroyed()) {
    return floatWindow;
  }

  const { x: screenX, y: screenY, width: screenWidth } = screen.getPrimaryDisplay().bounds;
  const x = screenX + Math.round((screenWidth - ORB_SIZE - ASR_TEXT_WIDTH - LLM_OUTPUT_WIDTH) / 2);
  // 原实现 y = screenY - 20 把窗口顶出屏幕上缘 20px：透明无边框窗口的这部分
  // 既不可见又拦截不到点击（orb 顶部触摸区失效）。改为贴屏幕上缘下压 8px。
  const y = screenY + 8;

  floatWindow = new BrowserWindow({
    width: ORB_SIZE + ASR_TEXT_WIDTH + LLM_OUTPUT_WIDTH,
    height: PANEL_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  floatWindow.loadFile(path.join(__dirname, "../../renderer/float.html"));
  floatWindow.webContents.on("did-finish-load", () => {
    isLoaded = true;
    // 若加载期间已有 show 请求，补发 SHOW_WINDOW，避免首帧事件丢失
    if (pendingShow) {
      pendingShow = false;
      log("[floatWindow] Replaying pending SHOW_WINDOW after load.");
      sendToFloatWindow(IPC_CHANNELS.SHOW_WINDOW);
    }
  });
  // Do not use Electron's system-wide content protection here. It also hides
  // the orb from third-party screen recorders such as Screen Studio. Daisy's
  // own full-screen capture path hides the orb only for that single frame.
  // macOS：悬浮球为纯状态指示，鼠标穿透不挡操作。
  // Windows：无 dock 图标，悬浮球兼作交互入口，允许点击/拖动，点击打开设置。
  floatWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  floatWindow.setAlwaysOnTop(true, "screen-saver");
  if (isWindows()) {
    floatWindow.setIgnoreMouseEvents(false);
    floatWindow.setMovable(true);
  } else {
    floatWindow.setIgnoreMouseEvents(true);
  }

  floatWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("Float window render process gone:", details);
  });

  floatWindow.webContents.on("console-message", (_event, level, message) => {
    const levels = ["debug", "log", "warn", "error"];
    console.error(`[float:${levels[level] ?? level}] ${message}`);
  });

  floatWindow.on("closed", () => {
    floatWindow = null;
    isLoaded = false;
    pendingShow = false;
  });

  return floatWindow;
}

export function getFloatWindow(): BrowserWindow | null {
  return floatWindow;
}

export function showFloatWindow(): void {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  // 1. Show the window immediately to eliminate visual delay!
  floatWindow.showInactive();

  // 2. Reposition it only if display boundary changed, to avoid blocking display server queries
  try {
    const { x: screenX, y: screenY, width: screenWidth } = screen.getPrimaryDisplay().bounds;
    const x = screenX + Math.round((screenWidth - ORB_SIZE - ASR_TEXT_WIDTH - LLM_OUTPUT_WIDTH) / 2);
    const y = screenY + 8;
    const currentPos = floatWindow.getPosition();
    if (currentPos[0] !== x || currentPos[1] !== y) {
      floatWindow.setPosition(x, y);
    }
  } catch (err) {
    console.error("Error setting float window position:", err);
  }

  if (!isLoaded) {
    pendingShow = true;
  }

  sendToFloatWindow(IPC_CHANNELS.SHOW_WINDOW);
  log("Float window shown");
}

export function hideFloatWindow(): void {
  if (!floatWindow || floatWindow.isDestroyed()) return;
  sendToFloatWindow(IPC_CHANNELS.HIDE_WINDOW);
  
  if (hideTimeout) {
    clearTimeout(hideTimeout);
  }
  
  hideTimeout = setTimeout(() => {
    hideTimeout = null;
    if (floatWindow && !floatWindow.isDestroyed()) {
      floatWindow.hide();
      log("Float window hidden");
    }
  }, 300);
}

export function sendToFloatWindow(channel: string, ...args: unknown[]): void {
  try {
    if (floatWindow && !floatWindow.isDestroyed() && !floatWindow.webContents.isDestroyed()) {
      floatWindow.webContents.send(channel, ...args);
    }
  } catch (err) {
    // Suppress disposed frame or hidden webContents errors
    console.error(`Error sending to float window on channel ${channel}:`, err);
  }
}
