import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const execFileAsync = promisify(execFile);

/**
 * Python 运行时解析器（Python 库技能包的统一入口）。
 *
 * 真机日志根因：韩红基金会财务报表任务中，LLM 因环境缺 Python 反复探测环境、
 * 下载便携 Python，浪费 30+ 步。此处统一做「检测 + 引导」：
 *  - Windows：优先命中用户已有的便携版（C:\pytools\python\python.exe，日志证实），
 *    再回退 `py` / `python`；
 *  - macOS：优先 `python3`。
 * 缺解释器返回 null，调用方给出可执行的安装引导，避免 LLM 盲目探测。
 */

/** 便携 Python 常见位置（真机日志：用户下载到 C:\pytools\python） */
const WIN_PYTHON_CANDIDATES = [
  path.join("C:", "pytools", "python", "python.exe"),
  path.join("C:", "Python313", "python.exe"),
  path.join("C:", "Python312", "python.exe"),
  path.join("C:", "Python311", "python.exe"),
  path.join(process.env.USERPROFILE || "", "DaisyPython", "python.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
  "py",
  "python",
];
const MAC_PYTHON_CANDIDATES = ["python3", "python"];

export interface PythonEnv {
  /** 实际解释器命令（Windows 为绝对路径或 `py`/`python`） */
  exe: string;
  isWindows: boolean;
}

let cachedPython: PythonEnv | null = null;
let cacheChecked = false;

function isWin(): boolean {
  return process.platform === "win32";
}

/** 若目录下含 python.exe 则返回完整路径（Windows 局部目录探测） */
function pythonExeInDir(dir: string): string {
  return path.join(dir, "python.exe");
}

/**
 * 定位可用 Python 解释器。结果缓存（安装/重试场景可调用 resetPythonCache 刷新）。
 * 找不到返回 null，调用方负责给出安装引导。
 */
export async function findPython(): Promise<PythonEnv | null> {
  if (cacheChecked) return cachedPython;

  const win = isWin();
  for (const cand of win ? WIN_PYTHON_CANDIDATES : MAC_PYTHON_CANDIDATES) {
    if (win && cand.includes("Programs") && cand !== "py" && cand !== "python") {
      // LOCALAPPDATA/Programs/Python 目录下有 Python312/... 子目录，遍历子目录
      try {
        const subDirs = await fs.promises.readdir(cand);
        for (const sub of subDirs) {
          const exe = pythonExeInDir(path.join(cand, sub));
          if (await isPython3(exe)) {
            cachedPython = { exe, isWindows: true };
            cacheChecked = true;
            return cachedPython;
          }
        }
        continue;
      } catch {
        continue;
      }
    }
    if (await isPython3(cand)) {
      cachedPython = { exe: cand, isWindows: win };
      cacheChecked = true;
      return cachedPython;
    }
  }
  cacheChecked = true;
  cachedPython = null;
  return null;
}

/** 判断某命令/路径是否为可用的 Python 3 解释器 */
async function isPython3(exe: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(exe, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { timeout: 8000 });
    return /^3\.\d+/.test(String(stdout).trim());
  } catch {
    return false;
  }
}

/** 清空解释器缓存（Python 安装完成后调用） */
export function resetPythonCache(): void {
  cachedPython = null;
  cacheChecked = false;
}

/** 检测指定库是否已安装 */
export async function hasPythonLibrary(exe: string, module: string): Promise<boolean> {
  try {
    await execFileAsync(exe, ["-c", `import ${module}`], { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 执行 Python 代码。代码过长（>3000 字符）自动写入临时 .py 文件再执行，
 * 规避 Windows 命令行长度限制（8191 字符）。
 */
export async function runPythonCode(
  exe: string,
  code: string,
  argv: string[] = [],
  timeoutMs = 60000
): Promise<{ stdout: string; stderr: string }> {
  const maxBuffer = 32 * 1024 * 1024;
  if (code.length <= 3000) {
    const { stdout, stderr } = await execFileAsync(exe, ["-c", code, ...argv], { timeout: timeoutMs, maxBuffer });
    return { stdout: String(stdout), stderr: String(stderr) };
  }
  const scriptPath = path.join(os.tmpdir(), `daisy-py-${Date.now()}-${Math.floor(Math.random() * 1e6)}.py`);
  await fs.promises.writeFile(scriptPath, code, "utf-8");
  try {
    const { stdout, stderr } = await execFileAsync(exe, [scriptPath, ...argv], { timeout: timeoutMs, maxBuffer });
    return { stdout: String(stdout), stderr: String(stderr) };
  } finally {
    await fs.promises.unlink(scriptPath).catch(() => {});
  }
}

/** 统一缺 Python 时的引导文案 */
export function pythonMissingHint(libs?: string[]): string {
  const libPart = libs && libs.length ? libs.join(" ") : "pymupdf pdfplumber openpyxl pdf2docx";
  if (isWin()) {
    return `未检测到 Python 3。一键安装 Daisy Python 技能包（便携版 + ${libPart}）：
1. New-Item -ItemType Directory -Path C:\\pytools\\python -Force
2. curl.exe -L -o "$env:TEMP\\py.zip" https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip
3. Expand-Archive "$env:TEMP\\py.zip" C:\\pytools\\python -Force
4. (Get-Content C:\\pytools\\python\\python312._pth) -replace '^#import site','import site' | Set-Content C:\\pytools\\python\\python312._pth
5. curl.exe -L -o "$env:TEMP\\get-pip.py" https://bootstrap.pypa.io/get-pip.py
6. & C:\\pytools\\python\\python.exe "$env:TEMP\\get-pip.py"
7. & C:\\pytools\\python\\python.exe -m pip install --no-warn-script-location ${libPart}
完成后告知我即可重试。`;
  }
  return `未检测到 Python 3。请执行 brew install python${libs && libs.length ? ` && python3 -m pip install ${libs.join(" ")}` : ""} 后重试`;
}

/** 统一缺库时的引导文案 */
export function pythonLibMissingHint(exe: string, libs: string[]): string {
  return `检测到 Python 但缺少依赖库（${libs.join("、")}）。请执行：${exe} -m pip install ${libs.join(" ")}`;
}
