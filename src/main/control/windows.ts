import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../utils/logger";
import { runPowerShell } from "../utils/windowsShell";

const execFileAsync = promisify(execFile);

/** 统一降级提示：macOS 专属应用在 Windows 无等价 API */
function unavailableOnWindows(feature: string): string {
  return `「${feature}」功能当前仅支持 macOS。`;
}

/** WScript.Shell SendKeys 特殊字符转义：+^%~(){}[] 需包在 {} 中 */
export function escapeSendKeys(text: string): string {
  return text.replace(/([+^%~(){}\[\]])/g, "{$1}").replace(/\{(\})\}/g, "{$1}");
}

const WIN_KEY_MAP: Record<string, string> = {
  return: "{ENTER}",
  enter: "{ENTER}",
  escape: "{ESC}",
  esc: "{ESC}",
  tab: "{TAB}",
  space: " ",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
};

export async function getDefaultBrowserProgId(): Promise<string> {
  try {
    const progId = await runPowerShell(
      `(Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId`
    );
    return progId || "";
  } catch {
    return "";
  }
}

export function progIdToBrowserName(progId: string): string {  const map: Record<string, string> = {
    ChromeHTML: "Google Chrome",
    MSEdgeHTM: "Microsoft Edge",
    FirefoxURL: "Firefox",
    OperaStable: "Opera",
    BraveHTML: "Brave",
    "360chrome": "360 浏览器",
  };
  const lower = progId.toLowerCase();
  for (const [key, name] of Object.entries(map)) {
    if (lower.includes(key.toLowerCase())) return name;
  }
  return "Microsoft Edge";
}

export async function openApplication(name: string): Promise<string> {
  try {
    const isBrowserKeyword = ["browser", "默认浏览器", "浏览器", "default_browser", "default browser"].includes(name.trim().toLowerCase());

    if (isBrowserKeyword) {
      const progId = await getDefaultBrowserProgId();
      const browserName = progId ? progIdToBrowserName(progId) : "Microsoft Edge";
      const result = await runPowerShell(`Start-Process $env:DAISY_ARG0`, { args: [browserName] });
      log(`windows.openApplication: opened default browser (${browserName}): ${result}`);
      return `已打开默认浏览器（${browserName}）`;
    }

    // Start-Process 按应用名启动（会搜索 PATH / 开始菜单注册），失败回退 AppsFolder
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Start-Process -FilePath $env:DAISY_ARG0
if (-not $?) {
    Start-Process "shell:AppsFolder\\$env:DAISY_ARG0"
}`;
    await runPowerShell(script, { args: [name] });
    return `已打开 ${name}`;
  } catch (error) {
    return `无法打开 ${name}，请检查应用名称是否正确`;
  }
}

export async function quitApplication(name: string): Promise<string> {
  try {
    const isBrowserKeyword = ["browser", "默认浏览器", "浏览器", "default_browser", "default browser"].includes(name.trim().toLowerCase());

    let processName: string;
    if (isBrowserKeyword) {
      const progId = await getDefaultBrowserProgId();
      const browserName = progId ? progIdToBrowserName(progId) : "Microsoft Edge";
      processName = browserName.toLowerCase().replace(/[^a-z0-9]/g, "");
      processName = processName.replace(/^(googlechrome|microsoftedge)$/, (m) =>
        m === "googlechrome" ? "chrome" : "msedge"
      );
    } else {
      // 去 .exe 后缀并取最后一个路径段作为进程名
      processName = name.replace(/\.exe$/i, "").trim();
    }

    if (!processName) return `无法关闭 ${name}`;

    const script = `
$name = $env:DAISY_ARG0
$procs = Get-Process -Name $name -ErrorAction SilentlyContinue
if (-not $procs) { Write-Output "NOT_RUNNING"; exit }
$procs | ForEach-Object { $_.CloseMainWindow() | Out-Null }
Start-Sleep -Milliseconds 500
$left = Get-Process -Name $name -ErrorAction SilentlyContinue
if ($left) { $left | Stop-Process -Force -ErrorAction SilentlyContinue }
Write-Output "CLOSED"`;
    const output = await runPowerShell(script, { args: [processName] });
    if (output === "NOT_RUNNING") return `已关闭 ${name}`;
    return `已关闭 ${name}`;
  } catch {
    return `无法关闭 ${name}`;
  }
}

export async function quitAllApplications(excludeNames: string[] = []): Promise<string> {
  const excludes = Array.from(new Set(["explorer", "daisy", "svchost", "searchapp", "startmenuexperiencehost", "shellexperiencehost", ...excludeNames.map((n) => n.toLowerCase())]));
  const excludeList = excludes.map((n) => `'${n.replace(/'/g, "''")}'`).join(",");
  const script = `
Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and
    $_.ProcessName.ToLower() -notin @(${excludeList})
} | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Output "DONE"`;
  await runPowerShell(script);
  return "已成功关闭所有其他应用程序";
}

export async function typeText(text: string): Promise<string> {
  try {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($env:DAISY_ARG0)`;
    await runPowerShell(script, { args: [escapeSendKeys(text)] });
    return "已输入文字";
  } catch {
    return "输入文字失败，请确认当前焦点在可输入区域";
  }
}

/** 将快捷键描述（如 "ctrl+shift+a"）映射为 SendKeys 序列（如 "^+a"），纯函数便于单测 */
export function buildSendKeys(keys: string): string {
  const normalized = keys.toLowerCase().replace(/\s+/g, "");
  const parts = normalized.split("+");
  const mainKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  const prefix = modifiers
    .map((m) => (m === "control" || m === "ctrl" ? "^" : m === "option" || m === "alt" ? "%" : m === "shift" ? "+" : m === "win" || m === "command" || m === "cmd" ? "%" : ""))
    .join("");

  let keyPart: string;
  if (mainKey.length === 1) {
    keyPart = mainKey;
  } else if (WIN_KEY_MAP[mainKey]) {
    keyPart = WIN_KEY_MAP[mainKey];
  } else {
    keyPart = mainKey;
  }

  return prefix + keyPart;
}

export async function pressKeys(keys: string): Promise<string> {
  try {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($env:DAISY_ARG0)`;
    await runPowerShell(script, { args: [buildSendKeys(keys)] });
    return `已发送快捷键 ${keys}`;
  } catch {
    return "发送快捷键失败";
  }
}

export async function getFrontmostApplication(): Promise<string> {
  try {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinFore {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
$h = [WinFore]::GetForegroundWindow()
$procId = 0
[WinFore]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
$p = Get-Process -Id $procId -ErrorAction SilentlyContinue
if ($p) { $p.ProcessName } else { "Desktop" }`;
    const name = await runPowerShell(script);
    return `当前最前面的应用是：${name}`;
  } catch {
    return "获取当前应用失败";
  }
}

export async function readSelectedText(): Promise<string> {
  try {
    const script = `
$orig = Get-Clipboard -Raw -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('^c')
Start-Sleep -Milliseconds 200
$sel = Get-Clipboard -Raw -ErrorAction SilentlyContinue
if ($orig -ne $null -and $orig -ne $sel) {
    Set-Clipboard -Value $orig -ErrorAction SilentlyContinue
}
if ($sel -and $sel -ne $orig) { $sel } else { "NO_SELECTION" }`;
    const result = await runPowerShell(script);
    if (result === "NO_SELECTION" || !result) {
      return "没有读取到选中的文字，请确认当前有选中的内容";
    }
    return `选中的文字是：${result}`;
  } catch {
    return "读取选中文本失败，请确认当前有选中的内容";
  }
}

export async function getClipboardText(): Promise<string> {
  try {
    const text = await runPowerShell(`Get-Clipboard -Raw -ErrorAction SilentlyContinue`);
    return text || "剪贴板为空，或不包含文本内容。";
  } catch {
    return "获取剪贴板失败";
  }
}

export async function setTimer(seconds: number): Promise<string> {
  const safeSeconds = Math.max(1, Math.floor(seconds));
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  const desc = mins > 0 ? `${mins}分${secs > 0 ? secs + "秒" : ""}` : `${secs}秒`;

  // 派生独立后台 powershell 进程：sleep 后蜂鸣提示，随主进程退出而终止
  const inner = `Start-Sleep -Seconds ${safeSeconds}; [console]::beep(1000, 800); Start-Sleep -Milliseconds 300; [console]::beep(1000, 800)`;
  const script = `Start-Process powershell.exe -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','${inner.replace(/'/g, "''")}'`;
  await runPowerShell(script);
  return `已设置计时器：${desc}，时间到了会播放提示音`;
}

export async function setAlarm(time: string, label?: string): Promise<string> {
  const parts = time.trim().split(/[\s/]/);
  const datePart = parts[0].split("-");
  const timePart = parts[1] ? parts[1].split(":") : ["7", "0"];
  const y = parseInt(datePart[0]);
  const m = parseInt(datePart[1]);
  const d = parseInt(datePart[2]);
  const h = parseInt(timePart[0]);
  const min = parseInt(timePart[1] || "0");

  if (isNaN(y) || isNaN(m) || isNaN(d) || isNaN(h) || isNaN(min)) {
    return `闹钟时间格式无效：${time}，请使用 YYYY-MM-DD HH:MM 格式`;
  }

  const now = new Date();
  const alarmDate = new Date(y, m - 1, d, h, min, 0);
  const diffMs = alarmDate.getTime() - now.getTime();
  if (diffMs <= 0) {
    return `闹钟时间 ${time} 已过期，请指定一个未来的时间`;
  }

  const diffSec = Math.round(diffMs / 1000);
  const diffMins = Math.round(diffSec / 60);
  let timeDesc: string;
  if (diffMins < 60) {
    timeDesc = `${diffMins}分钟后`;
  } else if (diffMins < 1440) {
    timeDesc = `${Math.round((diffMins / 60) * 10) / 10}小时后`;
  } else {
    timeDesc = `${Math.round((diffMins / 1440) * 10) / 10}天后`;
  }

  const alarmLabel = label && label.trim() ? label.trim() : "闹钟";
  const alarmTimeStr = `${m}月${d}日 ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;

  const inner = `Start-Sleep -Seconds ${diffSec}; for (\$i = 0; \$i -lt 5; \$i++) { [console]::beep(1200, 700); Start-Sleep -Milliseconds 400 }`;
  const script = `Start-Process powershell.exe -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','${inner.replace(/'/g, "''")}'`;
  await runPowerShell(script);
  return `已设置闹钟「${alarmLabel}」，时间：${alarmTimeStr}（${timeDesc}响起）`;
}

export async function searchMaps(query: string): Promise<string> {
  try {
    await execFileAsync("explorer.exe", [`bingmaps:?where=${encodeURIComponent(query)}`]);
    return `已在地图中搜索「${query}」`;
  } catch {
    try {
      await execFileAsync("explorer.exe", [`https://www.bing.com/maps?q=${encodeURIComponent(query)}`]);
      return `已在地图中搜索「${query}」`;
    } catch {
      return "地图搜索失败";
    }
  }
}

export async function openUrl(url: string): Promise<string> {
  try {
    let finalUrl = url.trim();
    if (!/^https?:\/\//.test(finalUrl)) {
      finalUrl = "https://" + finalUrl;
    }
    // explorer.exe 数组参数 + 无 shell：URL 交给系统默认浏览器
    await execFileAsync("explorer.exe", [finalUrl]);
    return `已用默认浏览器打开 ${finalUrl}`;
  } catch {
    return `打开网址失败`;
  }
}

export async function readFileDocx(filePath: string): Promise<string> {
  return unavailableOnWindows("读取 .docx 文档为纯文本");
}

// ── macOS 专属应用的 Windows 降级 ──

export async function sendEmail(_to: string, _subject: string, _body: string): Promise<string> {
  return unavailableOnWindows("发送邮件（Mail）");
}

export async function readUnreadEmails(_limit: number = 5): Promise<string> {
  return unavailableOnWindows("读取未读邮件（Mail）");
}

export async function getRecentEmails(_limit: number = 5): Promise<string> {
  return unavailableOnWindows("读取最新邮件（Mail）");
}

export async function searchEmails(_query: string, _limit: number = 5): Promise<string> {
  return unavailableOnWindows("搜索邮件（Mail）");
}

export async function createNote(_title: string, _body: string): Promise<string> {
  return unavailableOnWindows("创建备忘录（Notes）");
}

export async function searchNotes(_query: string): Promise<string> {
  return unavailableOnWindows("搜索备忘录（Notes）");
}

export async function createReminder(_title: string, _dueDate?: string, _notes?: string): Promise<string> {
  return unavailableOnWindows("创建提醒事项（Reminders）");
}

export async function createCalendarEvent(_title: string, _startDate: string, _endDate?: string, _location?: string, _notes?: string): Promise<string> {
  return unavailableOnWindows("创建日历事件（Calendar）");
}

export async function getCalendarEvents(_days: number): Promise<string> {
  return unavailableOnWindows("查看日历事件（Calendar）");
}

export async function switchAudioOutput(_deviceName: string): Promise<string> {
  return unavailableOnWindows("切换音频输出");
}

/** Windows 音量控制：调高/调低/静音（使用 PowerShell 与 user32.dll） */
export async function setVolume(direction: "up" | "down" | "mute"): Promise<string> {
  try {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinVol {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$key = 0
if ($env:DAISY_ARG0 -eq 'up') { $key = 0xAF }
elseif ($env:DAISY_ARG0 -eq 'down') { $key = 0xAE }
else { $key = 0xAD }
[WinVol]::keybd_event([byte]$key, 0, 0, [UIntPtr]::Zero)
[WinVol]::keybd_event([byte]$key, 0, 2, [UIntPtr]::Zero)
Write-Output "OK"`;
    await runPowerShell(script, { args: [direction] });
    const label = direction === "up" ? "调高" : direction === "down" ? "调低" : "静音";
    return `已将系统音量${label}`;
  } catch {
    return unavailableOnWindows("音量控制");
  }
}

/** Windows 媒体播放控制：播放/暂停、下一首、上一首（虚拟媒体键） */
export async function controlPlayback(action: "playpause" | "next" | "prev"): Promise<string> {
  try {
    const keyMap: Record<string, number> = {
      playpause: 0xB3,
      next: 0xB0,
      prev: 0xB1,
    };
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinMedia {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$key = [int]$env:DAISY_ARG0
[WinMedia]::keybd_event([byte]$key, 0, 0, [UIntPtr]::Zero)
[WinMedia]::keybd_event([byte]$key, 0, 2, [UIntPtr]::Zero)
Write-Output "OK"`;
    await runPowerShell(script, { args: [String(keyMap[action])] });
    const label = action === "playpause" ? "播放/暂停" : action === "next" ? "下一首" : "上一首";
    return `已执行${label}`;
  } catch {
    return unavailableOnWindows("媒体播放控制");
  }
}

/** Windows 锁定屏幕 */
export async function lockScreen(): Promise<string> {
  try {
    await runPowerShell(`rundll32.exe user32.dll,LockWorkStation`);
    return "已锁定屏幕";
  } catch {
    return unavailableOnWindows("锁屏");
  }
}

/** Windows 最小化指定应用所有窗口 */
export async function minimizeApp(appName: string): Promise<string> {
  try {
    const script = `
$name = $env:DAISY_ARG0
Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.MainWindowHandle }
    catch { 0 }
} | Where-Object { $_ -ne 0 } | ForEach-Object {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinMin {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
    [WinMin]::ShowWindow([IntPtr]$_, 6) | Out-Null
}
Write-Output "OK"`;
    await runPowerShell(script, { args: [appName.replace(/\.exe$/i, "")] });
    return `已最小化 ${appName} 的窗口`;
  } catch {
    return unavailableOnWindows("最小化窗口");
  }
}

/** Windows 最小化除指定应用外的所有窗口 */
export async function minimizeAllWindowsExcept(exceptName: string): Promise<string> {
  try {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinMinAll {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$keep = $env:DAISY_ARG0.ToLower()
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
    if ($_.ProcessName.ToLower() -ne $keep -and $_.ProcessName.ToLower() -ne 'daisy' -and $_.ProcessName.ToLower() -ne 'explorer') {
        [WinMinAll]::ShowWindow($_.MainWindowHandle, 6) | Out-Null
    }
}
Write-Output "OK"`;
    await runPowerShell(script, { args: [exceptName.replace(/\.exe$/i, "")] });
    return `已最小化除 ${exceptName} 之外的所有窗口`;
  } catch {
    return unavailableOnWindows("最小化窗口");
  }
}

/** Windows 分屏：无原生等价物，降级提示 */
export async function splitScreen(_left: string, _right: string): Promise<string> {
  return unavailableOnWindows("左右分屏");
}

/** Windows 勿扰/专注模式：无原生等价物，降级提示 */
export async function setDoNotDisturb(_enable: boolean): Promise<string> {
  return unavailableOnWindows("勿扰/专注模式");
}
