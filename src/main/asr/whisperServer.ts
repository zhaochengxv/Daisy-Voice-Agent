import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { log } from "../utils/logger";
import {
  getBundledBin,
  getWhisperModelPath,
  getWhisperExecutionEnv,
  getWhisperThreads,
} from "../config/env";

const WHISPER_SERVER = getBundledBin("whisper-server");
const PID_FILE = path.join(os.tmpdir(), "diri-whisper-server.pid");
const SERVER_READY_TIMEOUT = 15000;
const START_ATTEMPTS = 10;
const TRANSCODE_TIMEOUT = 45000;
const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 50000;

export interface TranscribeOptions {
  language?: string;
  prompt?: string;
}

/**
 * whisper-server 常驻单例：模型只加载一次，转写走本地 HTTP POST /inference，
 * 消除低配机器上"每次 spawn whisper-cli 重新加载模型"的巨大开销。
 *
 * 健壮性设计：
 * - warmup() 在初始化时后台预热，首次转写零冷启动。
 * - 模型缺失时不进入永久失败态（用户稍后下载模型可自动恢复）。
 * - 转写途中 server 崩溃（网络错误 / 5xx）自动 kill 并重置，下次请求重启自愈。
 * - 任何环节失败都返回 null，调用方回退到原有 whisper-cli 路径，行为不退化。
 */
class WhisperServer {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private starting: Promise<number | null> | null = null;
  private failed = false;

  /** 确保 server 就绪并返回端口；不可用返回 null。幂等，可安全并发调用。 */
  async ensure(): Promise<number | null> {
    if (this.port !== null) return this.port;
    if (this.failed) return null;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** 应用初始化时后台预热，不阻塞启动流程，不抛错。 */
  async warmup(): Promise<void> {
    try {
      const port = await this.ensure();
      log(`WhisperServer: warmup ${port === null ? "failed (fallback to whisper-cli)" : `ok on port ${port}`}`);
    } catch (error) {
      log(`WhisperServer: warmup error: ${error}`);
    }
  }

  async transcribe(wav: Buffer, opts: TranscribeOptions = {}): Promise<string | null> {
    const port = await this.ensure();
    if (port === null) return null;
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
      form.append("response_format", "text");
      form.append("language", opts.language || "auto");
      form.append("temperature", "0");
      if (opts.prompt) form.append("prompt", opts.prompt);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSCODE_TIMEOUT);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/inference`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (!res.ok) {
          log(`WhisperServer: inference HTTP ${res.status}`);
          if (res.status >= 500) this.markDead();
          return null;
        }
        return (await res.text()).trim();
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      log(`WhisperServer: transcribe error: ${error}`);
      this.markDead();
      return null;
    }
  }

  async dispose(): Promise<void> {
    const child = this.child;
    const pid = child?.pid;
    this.child = null;
    this.port = null;
    this.starting = null;
    this.failed = false;
    if (child) {
      child.kill();
      log("WhisperServer: disposed");
    }
    this.clearPidFile(pid);
  }

  /** server 曾成功启动但在转写途中异常：kill 并重置，下次请求自动重启自愈。 */
  private markDead(): void {
    if (this.port === null) return;
    log("WhisperServer: mark dead, will restart on next transcribe");
    this.child?.kill();
    this.child = null;
    this.port = null;
  }

  private async start(): Promise<number | null> {
    // 清理上次异常退出（崩溃）残留的孤儿进程，避免内存堆积
    this.killOrphan();

    // 二进制缺失是永态问题，直接快速失败；模型缺失则是可恢复的（设置页可下载）。
    if (!fs.existsSync(WHISPER_SERVER)) {
      log(`WhisperServer: binary not found: ${WHISPER_SERVER}`);
      this.failed = true;
      return null;
    }
    const modelPath = getWhisperModelPath();
    if (!fs.existsSync(modelPath)) {
      log(`WhisperServer: model not found: ${modelPath}, deferring (not marked failed)`);
      return null;
    }

    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      const port = PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
      if (await this.startOnPort(modelPath, port)) return port;
    }

    this.failed = true;
    return null;
  }

  private async startOnPort(modelPath: string, port: number): Promise<boolean> {
    const args = [
      "-m", modelPath,
      "-t", String(getWhisperThreads()),
      "-l", "auto",
      "--port", String(port),
      "-nt",
      "-sns",
      "--prompt", "Hey Daisy",
    ];

    let stderrBuf = "";
    const child = spawn(WHISPER_SERVER, args, {
      env: getWhisperExecutionEnv(WHISPER_SERVER),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (d: Buffer) => { stderrBuf += String(d); });
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        this.port = null;
        this.clearPidFile(child.pid);
      }
      log(`WhisperServer: process exited code=${code}`);
    });

    let done = false;
    const settle = (ready: boolean) => {
      if (done) return;
      done = true;
      if (ready) {
        this.child = child;
        this.port = port;
        this.writePidFile(child.pid);
        log(`WhisperServer: listening on 127.0.0.1:${port} (model ${path.basename(modelPath)})`);
      } else {
        child.kill();
        log(`WhisperServer: start failed on port ${port}: ${stderrBuf.trim().slice(0, 300)}`);
      }
    };
    child.on("error", () => settle(false));
    return this.waitReady(port, SERVER_READY_TIMEOUT).then((ready) => {
      settle(ready);
      return ready;
    });
  }

  private waitReady(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      let settled = false;
      const scheduleRetry = () => {
        if (settled) return;
        if (Date.now() >= deadline) {
          settled = true;
          resolve(false);
        } else {
          setTimeout(probe, 300);
        }
      };
      const probe = () => {
        if (settled) return;
        const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
          res.resume();
          settled = true;
          resolve(true);
        });
        req.on("timeout", () => {
          req.destroy();
          scheduleRetry();
        });
        req.on("error", () => scheduleRetry());
      };
      probe();
    });
  }

  /** 上次异常退出残留的 server 进程会在 PID 文件中留下痕迹，启动前先清理。 */
  private killOrphan(): void {
    let pid = 0;
    try {
      pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      fs.rmSync(PID_FILE, { force: true });
      return;
    }
    try {
      process.kill(pid, 0); // 探测存活（ESRCH 表示已退出）
      process.kill(pid);
      log(`WhisperServer: killed orphan process pid=${pid}`);
    } catch {
      /* 进程已退出或无权访问 */
    }
    fs.rmSync(PID_FILE, { force: true });
  }

  private writePidFile(pid: number | undefined): void {
    if (!pid) return;
    try {
      fs.writeFileSync(PID_FILE, String(pid));
    } catch {
      /* 临时目录不可写时忽略，孤儿清理为尽力而为 */
    }
  }

  private clearPidFile(pid: number | undefined): void {
    if (!pid) return;
    try {
      if (fs.readFileSync(PID_FILE, "utf8").trim() === String(pid)) {
        fs.rmSync(PID_FILE, { force: true });
      }
    } catch {
      /* ignore */
    }
  }
}

export const whisperServer = new WhisperServer();
