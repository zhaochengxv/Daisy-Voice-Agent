import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB 单文件上限，超出后轮转为 .1
const MAX_BACKUPS = 2;

let logDir = "";

function getLogDir(): string {
  if (logDir) return logDir;
  try {
    logDir = app?.getPath?.("logs") || path.join(os.tmpdir(), "diri-logs");
  } catch {
    logDir = path.join(os.tmpdir(), "diri-logs");
  }
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

function rotateIfNeeded(file: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  if (stat.size < MAX_LOG_SIZE) return;
  // 删除最旧的备份，依次滚动
  try {
    fs.rmSync(`${file}.${MAX_BACKUPS}`, { force: true });
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      } catch {
        // 忽略缺失的中间备份
      }
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // ignore
  }
}

export function log(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    process.stdout.write(line);
  } catch {
    // stdout may not be available in packaged app
  }
  try {
    const file = path.join(getLogDir(), "diri-main.log");
    rotateIfNeeded(file);
    fs.appendFileSync(file, line);
  } catch {
    // ignore
  }
}

export function logError(message: string, error?: unknown): void {
  let detail = "";
  if (error instanceof Error) {
    detail = `${error.message}\n${error.stack || ""}`;
  } else if (error !== undefined) {
    detail = String(error);
  }
  log(`ERROR: ${message} ${detail}`.trim());
}
