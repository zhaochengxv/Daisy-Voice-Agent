import path from "node:path";
import { Tray, Menu, nativeImage, app } from "electron";
import { getSettingsWindow, createSettingsWindow } from "./settingsWindow";
import { getFloatWindow, showFloatWindow } from "./floatWindow";
import { log } from "../utils/logger";

let tray: Tray | null = null;

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
    // Windows Tray 原生支持 .ico；直接传 ico 由系统选择尺寸，避免 resize 导致透明
    const icon = nativeImage.createFromPath(path.join(__dirname, "../../assets/icon.ico"));
    tray = new Tray(icon);
    tray.setToolTip("Daisy 语音助手");

    const menu = Menu.buildFromTemplate([
      { label: "打开设置", click: () => showSettings() },
      { label: "显示悬浮球", click: () => showOrb() },
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
