import { vi } from "vitest";
import os from "node:os";
import path from "node:path";

// 全局 mock electron：vitest 多 worker 并行 import 真实 electron 时，
// 若 node_modules/electron/dist 缺失会并发触发 install.js 解压 → 文件写冲突
// （CI ubuntu runner 实测 `locales/mr.pak: File exists` 导致 whisperServer suite 加载失败）。
// 单测不依赖真实 electron 二进制，统一 mock，同时让测试更快。
const userDataDir = path.join(os.tmpdir(), "daisy-test-userdata");
const appMock = {
  getPath: (name: string) => (name === "logs" ? path.join(os.tmpdir(), "daisy-test-logs") : userDataDir),
  getAppPath: () => userDataDir,
  isPackaged: false,
  getName: () => "Daisy",
  getVersion: () => "0.0.0-test",
};

const stub = () => {
  throw new Error("electron API not available in unit test env");
};

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: stub,
  ipcMain: stub,
  Menu: stub,
  Tray: stub,
  nativeImage: stub,
  screen: stub,
  shell: stub,
  systemPreferences: stub,
  clipboard: stub,
  powerMonitor: stub,
  globalShortcut: stub,
  dialog: stub,
  net: stub,
  session: stub,
  webContents: stub,
}));
