import path from "node:path";
import { BrowserWindow, screen } from "electron";
import { IPC_CHANNELS } from "../ipc/channels";
import { log } from "../utils/logger";
import { isWindows } from "../utils/windowsShell";
import { getSettingsWindow, createSettingsWindow } from "./settingsWindow";

export type FloatWindowMode = "standard" | "mini" | "hidden";

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

// 迷你模式：只保留 orb 的圆形小悬浮球（含阴影内边距）
const MINI_SIZE = SHADOW_MARGIN * 2 + ORB_SIZE + 12;

let floatWindow: BrowserWindow | null = null;

let hideTimeout: NodeJS.Timeout | null = null;
let isLoaded = false;
let pendingShow = false;

// 悬浮球三形态：standard（完整胶囊）/ mini（仅 orb）/ hidden（隐藏，托盘/语音唤起）
let floatMode: FloatWindowMode = "standard";
let lastVisibleMode: FloatWindowMode = "standard";

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
    // movable 保持 false：Windows 透明无边框窗口若同时开启系统级拖动
    // （movable:true）与 renderer 手动 setPosition 拖动，两条通道会互相冲突，
    // DWM 在拖动期间按 DPI 逐帧重算窗口，导致窗口越拖越大直到霸屏（真机复现）。
    // 只保留 renderer 上报相对位移 + setPosition 的唯一手动拖动通道。
    floatWindow.setIgnoreMouseEvents(false);
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

export function getFloatWindowMode(): FloatWindowMode {
  return floatMode;
}

/** 切换悬浮球形态：standard（完整胶囊）/ mini（仅 orb）/ hidden（隐藏） */
export function setFloatWindowMode(mode: FloatWindowMode): void {
  const fw = floatWindow;
  if (!fw || fw.isDestroyed()) return;

  if (mode === "hidden") {
    lastVisibleMode = floatMode;
    floatMode = "hidden";
    if (hideTimeout) { clearTimeout(hideTimeout); hideTimeout = null; }
    fw.hide();
    log("Float window hidden (mode=hidden)");
    return;
  }

  floatMode = mode;
  applyModeBounds(fw, mode);
  fw.showInactive();
  sendToFloatWindow(IPC_CHANNELS.FLOAT_MODE_CHANGED, mode);
  log(`Float window mode: ${mode}`);
}

/** 按形态应用窗口尺寸与位置：standard 顶部居中，mini 吸附右上角 */
function applyModeBounds(fw: BrowserWindow, mode: FloatWindowMode): void {
  try {
    const { workArea } = screen.getPrimaryDisplay();
    if (mode === "mini") {
      const w = MINI_SIZE;
      const h = MINI_SIZE;
      fw.setBounds({
        width: w,
        height: h,
        x: workArea.x + workArea.width - w - 8,
        y: workArea.y + 8,
      });
    } else {
      const w = WINDOW_WIDTH;
      const h = WINDOW_HEIGHT;
      fw.setBounds({
        width: w,
        height: h,
        x: workArea.x + Math.round((workArea.width - w) / 2),
        y: workArea.y + 8,
      });
    }
  } catch (err) {
    console.error("Error applying float window mode bounds:", err);
  }
}

export function showFloatWindow(): void {
  if (!floatWindow || floatWindow.isDestroyed()) return;

  // hidden 状态下被唤起（托盘/语音/唤醒词）：恢复为隐藏前的可见形态
  if (floatMode === "hidden") {
    setFloatWindowMode(lastVisibleMode || "standard");
    return;
  }

  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  // 1. Show the window immediately to eliminate visual delay!
  floatWindow.showInactive();

  // 2. 仅 standard 形态做顶部居中；mini 形态保持用户/自动收纳的位置，
  //    避免每次显示都被拉回顶部打断收纳效果。
  if (floatMode === "standard") {
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

// ── Windows 手动拖动 ──
// renderer 上报相对位移 → 这里移动窗口。节流保证一帧内多次 mousemove 只落一次
// setPosition，减少 IPC 与窗口系统负载；clamp 保证窗口始终留有可抓取的边缘，
// 避免被拖出屏幕后无法找回。
let dragPending = false;

export function handleFloatDrag(dx: number, dy: number): void {
  const fw = floatWindow;
  if (!fw || fw.isDestroyed()) return;
  if (dragPending) return;
  dragPending = true;
  setImmediate(() => {
    dragPending = false;
  });

  const [x, y] = fw.getPosition();
  let nx = x + Math.round(dx);
  let ny = y + Math.round(dy);
  try {
    const { workArea } = screen.getDisplayNearestPoint({ x: nx, y: ny });
    const w = floatMode === "mini" ? MINI_SIZE : WINDOW_WIDTH;
    const h = floatMode === "mini" ? MINI_SIZE : WINDOW_HEIGHT;
    const grip = 48; // 至少保留 48px 可抓取边缘在屏幕内
    nx = Math.min(Math.max(nx, workArea.x - w + grip), workArea.x + workArea.width - grip);
    ny = Math.min(Math.max(ny, workArea.y - h + grip), workArea.y + workArea.height - grip);
  } catch {
    // ignore clamp errors
  }
  fw.setPosition(nx, ny);
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
