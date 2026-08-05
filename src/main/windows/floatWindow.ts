import path from "node:path";
import { BrowserWindow, screen } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { log } from "../utils/logger";
import { isWindows } from "../utils/windowsShell";
import { getSettingsWindow, createSettingsWindow } from "./settingsWindow";

const ORB_SIZE = 92;
// 玻璃胶囊三区布局：左 orb（点击录音开关）+ 中状态徽标/ASR 实时文本 + 右 LLM 滚动输出。
// 窗口四周预留 SHADOW_MARGIN 的透明内边距，让 CSS box-shadow（胶囊阴影）有渲染空间，
// 而不是被窗口边缘裁掉。所有尺寸只在这里定义，renderer 的 float.js 按相对布局自适应。
const ASR_TEXT_WIDTH = 200;
const LLM_OUTPUT_WIDTH = 264;
const CONTENT_PADDING = 16;
const SHADOW_MARGIN = 16;
const PANEL_HEIGHT = 148;

const WINDOW_WIDTH =
  SHADOW_MARGIN * 2 + CONTENT_PADDING * 2 + ORB_SIZE + 16 + ASR_TEXT_WIDTH + 14 + LLM_OUTPUT_WIDTH;
const WINDOW_HEIGHT = SHADOW_MARGIN * 2 + PANEL_HEIGHT;

let floatWindow: BrowserWindow | null = null;

let hideTimeout: NodeJS.Timeout | null = null;
let isLoaded = false;
let pendingShow = false;

export function createFloatWindow(): BrowserWindow {
  if (floatWindow && !floatWindow.isDestroyed()) {
    return floatWindow;
  }

  const { x: screenX, y: screenY, width: screenWidth } = screen.getPrimaryDisplay().bounds;
  const x = screenX + Math.round((screenWidth - WINDOW_WIDTH) / 2);
  // 原实现 y = screenY - 20 把窗口顶出屏幕上缘 20px：透明无边框窗口的这部分
  // 既不可见又拦截不到点击（orb 顶部触摸区失效）。改为贴屏幕上缘下压 8px。
  const y = screenY + 8;

  floatWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
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
    // macOS 悬浮球是纯状态指示（鼠标穿透，不挡操作）；Windows 无 dock 图标，
    // 悬浮球兼作交互入口（点击 orb 录音 / 点击文本区打开设置 / 拖动）。Windows
    // 上 focusable 必须为 true，否则透明窗口无法稳定接收鼠标点击（真机实测
    // "悬浮球无法点击"），导致录音开关/设置入口全部失效。
    focusable: !isWindows(),
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
    // forward:true —— 即使穿透也把 mousemove 转交 renderer，否则 macOS 上的
    // hover 检测永远收不到移动事件，悬浮球会被永久锁死在穿透态无法交互。
    floatWindow.setIgnoreMouseEvents(true, { forward: true });
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
    const x = screenX + Math.round((screenWidth - WINDOW_WIDTH) / 2);
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
