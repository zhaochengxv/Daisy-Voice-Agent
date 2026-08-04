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
    let icon = nativeImage.createFromPath(path.join(__dirname, "../../assets/icon.ico"));
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty();
    } else if (icon.getSize().width > 32) {
      // Windows 托盘建议 16x16；ico 可能加载最大尺寸，缩放到 16x16
      icon = icon.resize({ width: 16, height: 16 });
    }

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
