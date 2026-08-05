import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { logError } from "./logger";

const execFileAsync = promisify(execFile);

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

/**
 * Windows PowerShell 统一执行入口。
 *
 * 安全模型：
 * - execFile + 数组参数 + 无 shell（不经 cmd.exe 解释），脚本本身无 shell 二次解释面。
 * - 用户输入一律通过环境变量 DAISY_ARG0..DAISY_ARGn 传入，脚本内以 $env:DAISY_ARGx 引用，
 *   杜绝在脚本字符串中拼接用户输入（PowerShell 无等价于 shell 单引号的注入面）。
 * - 固定超时防止第三方脚本挂起。
 */
export interface PowerShellOptions {
  timeoutMs?: number;
  args?: string[];
}

/**
 * 定位 powershell.exe：优先绝对路径（SystemRoot 拼接，避免 PATH 异常导致
 * spawn ENOENT，例如某些精简 PATH 或非标准部署）；找不到再回退裸名让系统解析。
 */
function resolvePowerShellPath(): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(root, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
  ];
  for (const candidate of candidates) {
    if (!candidate.includes("\\") || fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "powershell.exe";
}

export async function runPowerShell(script: string, options: PowerShellOptions = {}): Promise<string> {
  const { timeoutMs = 15000, args = [] } = options;
  const env: NodeJS.ProcessEnv = { ...process.env };
  args.forEach((value, i) => {
    env[`DAISY_ARG${i}`] = value;
  });
  try {
    // -STA：剪贴板 Get/Set-Clipboard 需要单线程 Apartment（powershell.exe 默认 MTA）
    const { stdout } = await execFileAsync(resolvePowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      script,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env, windowsHide: true });
    return stdout.trim();
  } catch (error) {
    logError("runPowerShell failed", error);
    throw error;
  }
}
