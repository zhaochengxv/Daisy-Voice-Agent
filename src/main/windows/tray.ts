import path from "node:path";
import fs from "node:fs";
import { Tray, Menu, nativeImage, app } from "electron";
import { getSettingsWindow, createSettingsWindow } from "./settingsWindow";
import { getFloatWindow, showFloatWindow, setFloatWindowMode } from "./floatWindow";
import { log } from "../utils/logger";

let tray: Tray | null = null;

/**
 * 解析应用内资源绝对路径。
 *
 * 历史 bug：用 `__dirname + "../../assets/..."` 定位资源，编译后 __dirname 是
 * dist/main/windows，其 ../../assets 指向 dist/assets——但资源实际在 asar 根
 * assets/（打包后）或项目根 assets/（dev），导致 createFromPath 找不到文件、
 * 返回空图，托盘图标/窗口图标不可见。
 *
 * 统一用 app.getAppPath() 定位：dev 下 = 项目根，packaged 下 = app.asar 根。
 * asar 内的图片经 electron 的 fs 层可被 nativeImage 直接读取。
 */
export function resolveAssetPath(...names: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar")
    : app.getAppPath();
  return path.join(base, ...names);
}

/** 从磁盘加载图标，失败时回退到内嵌 16x16 PNG，保证托盘图标永不缺失 */
export function loadTrayIcon(): Electron.NativeImage {
  const candidates = [
    resolveAssetPath("assets", "tray.ico"),
    resolveAssetPath("assets", "icon.ico"),
    resolveAssetPath("assets", "icon.png"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        // 托盘要求小尺寸，多倍图取 16/20/24/32 中合适的一档
        const trayImg = img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
        if (!trayImg.isEmpty()) return trayImg;
      }
    } catch {
      // try next
    }
  }
  // 兜底：内嵌 16x16 蓝色圆点 PNG，任何磁盘资源缺失时托盘图标依然可见
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mNk+M9Qz0BAMsY0MTIAAaQAXlPwqMkAAAAASUVORK5CYII="
  );
}

/** 显示设置窗（已存在则聚焦，否则重建） */
function showSettings(): void {
  const win = getSettingsWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  createSettingsWindow();
}

function showOrb(): void {
  const fw = getFloatWindow();
  if (fw && !fw.isDestroyed()) showFloatWindow();
}

/**
 * 系统托盘：Windows 无 dock 图标的唯一常驻入口。
 * 提供「打开设置」「显示悬浮球」「退出 Daisy」菜单，双击托盘显示设置窗。
 */
export function createTray(): Tray | null {
  if (tray) return tray;
  try {
    // Windows Tray 原生支持 .ico；用可回退的资源加载，确保图标必可见
    const icon = loadTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip("Daisy 语音助手");

    // Windows 上托盘图标默认可能被折叠进溢出区，首次创建时置顶 + 通知用户入口位置
    try {
      tray.displayBalloon({ iconType: "info", title: "Daisy 语音助手", content: "Daisy 已最小化到系统托盘，右键图标可设置或退出。" });
    } catch {
      // 某些精简系统不支持 balloon，忽略
    }

    const menu = Menu.buildFromTemplate([
      { label: "打开设置", click: () => showSettings() },
      { label: "显示悬浮球", click: () => showOrb() },
      { label: "迷你悬浮球", click: () => setFloatWindowMode("mini") },
      { label: "隐藏悬浮球", click: () => setFloatWindowMode("hidden") },
      { type: "separator" },
      { label: "退出 Daisy", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    tray.on("double-click", () => showSettings());
    log("Tray created");
    return tray;
  } catch (error) {
    log(`Tray creation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
