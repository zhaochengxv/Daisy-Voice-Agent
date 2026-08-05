import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
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

/**
 * 检测 NVIDIA 独立显卡与 CUDA 驱动可用性，决定是否向用户推荐一键启用 whisper GPU 加速。
 * 返回 "driver-ok"（有 N 卡且 nvidia-smi 可调用）/ "card-only"（有 N 卡但驱动不可用）
 * / "none"（无 N 卡）。
 */
export async function detectNvidiaGpu(): Promise<"driver-ok" | "card-only" | "none"> {
  try {
    const result = await runPowerShell(`
$card = Get-CimInstance win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|GeForce|Quadro|Tesla|RTX|GTX' } | Select-Object -First 1
if (-not $card) { 'none' }
else {
  try { $null = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null; 'driver-ok' } catch { 'card-only' }
}
`);
    if (result.includes("driver-ok")) return "driver-ok";
    if (result.includes("card-only")) return "card-only";
    return "none";
  } catch {
    return "none";
  }
}

/** 获取 Windows 真实桌面路径（兼容 OneDrive 已知文件夹重定向），失败回退 ~/Desktop */
export async function getWindowsDesktopPath(): Promise<string> {
  try {
    const result = await runPowerShell(
      `[Environment]::GetFolderPath('Desktop')`
    );
    if (result && result.trim()) return result.trim();
  } catch {
    // fall through
  }
  return path.join(os.homedir(), "Desktop");
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
  const isBrowserKeyword = ["browser", "默认浏览器", "浏览器", "default_browser", "default browser"].includes(name.trim().toLowerCase());

  let progId = "";
  if (isBrowserKeyword) {
    try {
      progId = await getDefaultBrowserProgId();
    } catch {
      /* keep empty */
    }
  }

  // 解析真实 exe 路径后再启动，fire-and-forget（Start-Process 立即返回）。
  // 原实现把显示名（如 "Microsoft Edge"）直接当 FilePath，Start-Process 必失败，
  // 且失败静默返回 "已打开" → 路由器视为 handled → LLM 反复重试（真机日志
  // 09:12:39-09:13:30 的 runPowerShell failed 循环）。这里解析失败则抛错，
  // 由调用方按 handled:false 处理，让 LLM 落回 chat 而不是空转重试。
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$name = $env:DAISY_ARG0
$isBrowser = $env:DAISY_ARG1 -eq '1'
$progId = $env:DAISY_ARG2
$exe = ''

function Get-AppPath($appName) {
    $ap = Get-ItemProperty "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$appName.exe" -ErrorAction SilentlyContinue
    if ($ap -and $ap.'(default)') { return $ap.'(default)' }
    $ap = Get-ItemProperty "Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$appName.exe" -ErrorAction SilentlyContinue
    if ($ap -and $ap.'(default)') { return $ap.'(default)' }
    return $null
}

function Get-LnkPath($appName) {
    $roots = @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $lnk = Get-ChildItem -Path $root -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
            Where-Object { $_.BaseName -ieq $appName } | Select-Object -First 1
        if ($lnk) {
            $sh = New-Object -ComObject WScript.Shell
            $target = $sh.CreateShortcut($lnk.FullName).TargetPath
            if ($target -and (Test-Path $target)) { return $target }
        }
    }
    return $null
}

try {
    if ($isBrowser -and $progId) {
        $regCmd = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\$progId\\shell\\open\\command" -ErrorAction SilentlyContinue).'(default)'
        if ($regCmd) {
            $m = [regex]::Match($regCmd, '"([^"]+\\.exe)"')
            if (-not $m.Success) { $m = [regex]::Match($regCmd, '([A-Za-z]:\\\\[^"]*\\.exe)') }
            if ($m.Success) { $exe = $m.Groups[1].Value }
        }
        if (-not $exe) {
            foreach ($cand in @('chrome','msedge','firefox','opera','brave')) {
                $exe = Get-AppPath $cand
                if ($exe) { break }
            }
        }
    } else {
        if ($name -match '\\.exe$' -or $name -match '\\\\') {
            if (Test-Path $name) { $exe = $name }
        } else {
            $exe = Get-AppPath $name
        }
        if (-not $exe) { $exe = Get-LnkPath $name }
    }

    if ($exe) {
        Start-Process -FilePath $exe
        Write-Output ("OK:" + $exe)
    } elseif ($name -match '^[A-Za-z0-9._-]+$') {
        # PATH 上的裸命令（notepad/mspaint 等）
        Start-Process -FilePath $name
        if ($?) { Write-Output ("OK:" + $name) }
    } else {
        Write-Output 'FAIL:EXE_NOT_FOUND'
    }
} catch {
    Write-Output 'FAIL:START_FAILED'
}
exit 0`;

  const result = await runPowerShell(script, { args: [name, isBrowserKeyword ? "1" : "0", progId] });
  if (result.startsWith("OK:")) {
    log(`windows.openApplication: launched ${name} -> ${result.slice(3)}`);
    return isBrowserKeyword ? "已打开默认浏览器" : `已打开 ${name}`;
  }
  log(`windows.openApplication: failed to resolve/start "${name}" (progId=${progId}, result=${result})`);
  throw new Error(`无法打开 ${name}`);
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

/**
 * 输入任意文本（含中文/Unicode）。
 *
 * SendKeys 只能输入 ASCII（走键盘扫描码），中文会被静默丢弃。
 * 方案：备份剪贴板 → 写入目标文本 → Ctrl+V 粘贴 → 还原剪贴板。
 */
export async function typeText(text: string): Promise<string> {
  try {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$orig = Get-Clipboard -Raw -ErrorAction SilentlyContinue
Set-Clipboard -Value $env:DAISY_ARG0 -ErrorAction SilentlyContinue
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 300
if ($orig -ne $null -and $orig -ne "") {
    Set-Clipboard -Value $orig -ErrorAction SilentlyContinue
}
Write-Output "OK"`;
    await runPowerShell(script, { args: [text] });
    return "已输入文字";
  } catch {
    return "输入文字失败，请确认当前焦点在可输入区域";
  }
}

/** 主键 → 虚拟键码(VK)。字母/数字用大写 ASCII（与 VK 一致），功能键走映射表。无法映射返回 null。 */
export function keyToVk(mainKey: string): number | null {
  const lower = mainKey.toLowerCase();
  const vkMap: Record<string, number> = {
    enter: 0x0D, return: 0x0D,
    escape: 0x1B, esc: 0x1B,
    tab: 0x09,
    backspace: 0x08,
    delete: 0x2E,
    up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    home: 0x24, end: 0x23,
    pageup: 0x21, pagedown: 0x22,
    space: 0x20,
    insert: 0x2D,
  };
  if (vkMap[lower] !== undefined) return vkMap[lower];
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase().charCodeAt(0);
  return null;
}

/**
 * 拆分快捷键（如 "ctrl+win+d"）为修饰键 + 主键，纯函数便于单测。
 * 返回 null 表示无法解析。
 */
export function parseHotkey(keys: string): { win: boolean; ctrl: boolean; alt: boolean; shift: boolean; mainKey: string } | null {
  const normalized = keys.toLowerCase().replace(/\s+/g, "");
  const parts = normalized.split("+").filter(Boolean);
  if (parts.length === 0) return null;
  const mainKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const hk = { win: false, ctrl: false, alt: false, shift: false, mainKey };
  for (const m of modifiers) {
    if (m === "win" || m === "command" || m === "cmd" || m === "meta") hk.win = true;
    else if (m === "ctrl" || m === "control") hk.ctrl = true;
    else if (m === "alt" || m === "option") hk.alt = true;
    else if (m === "shift") hk.shift = true;
    else return null; // 未知修饰词 → 无法解析
  }
  return hk;
}

/**
 * 将快捷键描述（如 "ctrl+shift+a"）映射为 SendKeys 序列（如 "^+a"）。
 * 注意：SendKeys 无法表达 Win 键，win/cmd 会退化为 Alt（仅 fallback 路径使用）。
 */
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

/**
 * 发送快捷键。
 *
 * SendKeys 无法表达 Win 键（% 是 Alt），且对任意键组合不可靠；
 * 优先用 user32 keybd_event（VK 码）发送，支持 Win/Ctrl/Alt/Shift 任意组合；
 * 主键无法映射 VK（如特殊符号）时退回 SendKeys（此时不能含 win 修饰，win 会退化为 Alt）。
 */
export async function pressKeys(keys: string): Promise<string> {
  try {
    const hk = parseHotkey(keys);
    if (!hk) {
      return `无法解析快捷键「${keys}」`;
    }
    const vk = keyToVk(hk.mainKey);

    if (vk !== null) {
      // keybd_event 方案：支持 Win 键
      const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinHotkey {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$vk = [int]$env:DAISY_VK
function Press-Mod([int]$code, [string]$on) {
    if ($on -eq '1') { [WinHotkey]::keybd_event([byte]$code, 0, 0, [UIntPtr]::Zero) }
}
function Release-Mod([int]$code, [string]$on) {
    if ($on -eq '1') { [WinHotkey]::keybd_event([byte]$code, 0, 2, [UIntPtr]::Zero) }
}
Press-Mod 0x5B $env:DAISY_WIN
Press-Mod 0x11 $env:DAISY_CTRL
Press-Mod 0x12 $env:DAISY_ALT
Press-Mod 0x10 $env:DAISY_SHIFT
[WinHotkey]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
[WinHotkey]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
Release-Mod 0x5B $env:DAISY_WIN
Release-Mod 0x11 $env:DAISY_CTRL
Release-Mod 0x12 $env:DAISY_ALT
Release-Mod 0x10 $env:DAISY_SHIFT
Write-Output "OK"`;
      await runPowerShell(script, {
        args: [String(vk), hk.win ? "1" : "0", hk.ctrl ? "1" : "0", hk.alt ? "1" : "0", hk.shift ? "1" : "0"],
      });
      return `已发送快捷键 ${keys}`;
    }

    // 退回 SendKeys：不能含 win（% 是 Alt 语义错误），仅 ctrl/alt/shift
    const sendkeysScript = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($env:DAISY_ARG0)`;
    await runPowerShell(sendkeysScript, { args: [buildSendKeys(keys)] });
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
    // explorer.exe 打开 URL 成功后也常返回退出码 1（真机日志反复出现
    // "Silent tool execution failed" 的根因），execFile 因此永远抛错。
    // 改用 PowerShell Start-Process（ShellExecute 语义）交给系统默认浏览器，
    // 脚本以退出码 0 结束，URL 经 DAISY_ARG0 传入，无 shell 拼接注入面。
    const script = `
$ErrorActionPreference = 'Stop'
$url = $env:DAISY_ARG0
try {
    Start-Process -FilePath $url
} catch {
    Write-Error "Failed to open URL: $_"
    exit 1
}
exit 0`;
    await runPowerShell(script, { args: [finalUrl] });
    return `已用默认浏览器打开 ${finalUrl}`;
  } catch (error) {
    return `打开网址失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Windows 读取 .docx 纯文本：docx 是 ZIP+XML，PowerShell 纯解析无需 Word */
export async function readFileDocx(filePath: string): Promise<string> {
  try {
    const script = `
try {
    $path = $env:DAISY_ARG0
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($path)
    $entry = $zip.GetEntry('word/document.xml')
    if (-not $entry) { $zip.Dispose(); Write-Output "NOT_DOCX"; exit }
    $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
    $xml = $reader.ReadToEnd()
    $reader.Dispose()
    $zip.Dispose()
    $sb = New-Object System.Text.StringBuilder
    $xmlDoc = New-Object System.Xml.XmlDocument
    $xmlDoc.LoadXml($xml)
    $ns = New-Object System.Xml.XmlNamespaceManager($xmlDoc.NameTable)
    $ns.AddNamespace('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')
    $paras = $xmlDoc.SelectNodes('//w:p', $ns)
    foreach ($p in $paras) {
        $texts = $p.SelectNodes('.//w:t', $ns)
        $line = ''
        foreach ($t in $texts) { $line += $t.InnerText }
        [void]$sb.AppendLine($line)
    }
    $out = $sb.ToString()
    if ($out.Length -gt 100000) { $out = $out.Substring(0, 100000) + "\\n...(内容过长，已截断)" }
    Write-Output $out
} catch {
    Write-Output ("FAILED:" + $_.Exception.Message)
}`;
    const result = await runPowerShell(script, { args: [filePath], timeoutMs: 30000 });
    if (result.startsWith("NOT_DOCX")) return "读取文件失败: 不是有效的 .docx 文件";
    if (result.startsWith("FAILED:")) return `读取文件失败: ${result.slice(7)}`;
    return result || "（空文档）";
  } catch (error) {
    return `读取文件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── Outlook/Word COM：检测到 Office 用 COM，未安装返回引导提示 ──

const OFFICE_NOT_FOUND = "未检测到 Outlook/Word，请安装 Microsoft 365 后重试。";

function isNoOfficeError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /RPC|0x800706ba|0x80080005|未找到|failed to create|New-Object|could not/i.test(msg);
}

export async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  try {
    const script = `
try {
  $outlook = New-Object -ComObject Outlook.Application
} catch { Write-Output "NO_OUTLOOK"; exit }
$mail = $outlook.CreateItem(0)
$mail.To = $env:DAISY_ARG0
$mail.Subject = $env:DAISY_ARG1
$mail.Body = $env:DAISY_ARG2
$mail.Send()
Write-Output "OK"`;
    const result = await runPowerShell(script, { args: [to, subject, body], timeoutMs: 60000 });
    if (result.includes("NO_OUTLOOK")) return OFFICE_NOT_FOUND;
    if (result.trim() === "OK") {
      return `已成功发送邮件给「${to}」，主题：「${subject}」。`;
    }
    return `发送邮件失败: ${result}`;
  } catch (error) {
    return isNoOfficeError(error) ? OFFICE_NOT_FOUND : `发送邮件出错: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function readEmails(kind: "unread" | "recent" | "search", query: string, limit: number): Promise<string> {
  const filterClause = kind === "unread"
    ? `$sender = if ($m.SenderName) { $m.SenderName } else { "(未知)" }
    $subject = if ($m.Subject) { $m.Subject } else { "(无主题)" }
    if ($m.UnRead) { $results += ("FROM:" + $sender + "|SUBJECT:" + $subject) }`
    : kind === "search"
      ? `$sender = if ($m.SenderName) { $m.SenderName } else { "(未知)" }
    $subject = if ($m.Subject) { $m.Subject } else { "" }
    $body = if ($m.Body) { $m.Body } else { "" }
    $q = $env:DAISY_ARG2.ToLower()
    if (($subject -and $subject.ToLower().Contains($q)) -or ($sender -and $sender.ToLower().Contains($q)) -or ($body -and $body.ToLower().Contains($q))) { $results += ("FROM:" + $sender + "|SUBJECT:" + $subject) }`
      : `$sender = if ($m.SenderName) { $m.SenderName } else { "(未知)" }
    $subject = if ($m.Subject) { $m.Subject } else { "(无主题)" }
    $results += ("FROM:" + $sender + "|SUBJECT:" + $subject)`;
  try {
    const script = `
try {
  $outlook = New-Object -ComObject Outlook.Application
  $ns = $outlook.GetNamespace("MAPI")
  $inbox = $ns.GetDefaultFolder(6)
  $items = $inbox.Items
  $items.Sort("[ReceivedTime]", $true)
  $results = @()
  $checked = 0
  $limit = [int]$env:DAISY_ARG1
  for ($i = 1; $i -le $items.Count; $i++) {
    if ($results.Count -ge $limit) { break }
    if ($checked -ge 200) { break }
    $checked++
    try {
      $m = $items.Item($i)
      ${filterClause}
    } catch { }
  }
  if ($results.Count -eq 0) { Write-Output "NONE" }
  else { $results | ForEach-Object { Write-Output $_ } }
} catch { Write-Output "NO_OUTLOOK" }`;
    const result = await runPowerShell(script, { args: ["", String(limit), query], timeoutMs: 60000 });
    if (result.includes("NO_OUTLOOK")) return OFFICE_NOT_FOUND;
    if (result.trim() === "NONE" || !result.trim()) return "NONE";
    return result.trim().split("\n").map((line) => {
      const m = /^FROM:(.*)\|SUBJECT:(.*)$/.exec(line);
      return m ? `  发件人: ${m[1]}\n  主题: ${m[2]}` : line;
    }).join("\n\n");
  } catch (error) {
    return isNoOfficeError(error) ? OFFICE_NOT_FOUND : `读取邮件出错: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function readUnreadEmails(limit: number = 5): Promise<string> {
  const result = await readEmails("unread", "", limit);
  if (result === OFFICE_NOT_FOUND) return result;
  if (result === "NONE") return "没有未读邮件。";
  return result;
}

export async function getRecentEmails(limit: number = 5): Promise<string> {
  const result = await readEmails("recent", "", limit);
  if (result === OFFICE_NOT_FOUND) return result;
  if (result === "NONE") return "收件箱为空。";
  return result;
}

export async function searchEmails(query: string, limit: number = 5): Promise<string> {
  const result = await readEmails("search", query, limit);
  if (result === OFFICE_NOT_FOUND) return result;
  if (result === "NONE") return `没有找到主题、发件人或正文包含「${query}」的邮件`;
  return result;
}

const NOTES_DIR_NAME = "Daisy备忘录";

function notesDir(): string {
  return path.join(os.homedir(), "Documents", NOTES_DIR_NAME);
}

/** 安全化文件名：去掉路径分隔符与非法字符 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").trim().slice(0, 80) || "未命名";
}

/** Windows 创建备忘录：写入 ~/Documents/Daisy备忘录/<标题>.md（无内置 Notes 等价物） */
export async function createNote(title: string, body: string): Promise<string> {
  try {
    const fs = require("node:fs");
    const dir = notesDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${safeFileName(title)}.md`);
    const content = `# ${title}\n\n${body || ""}\n`;
    fs.writeFileSync(filePath, content, "utf8");
    return `已创建备忘录「${title}」，保存至 ${filePath}`;
  } catch (error) {
    return `创建备忘录失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Windows 搜索备忘录：递归扫描备忘录目录按关键词匹配 */
export async function searchNotes(query: string): Promise<string> {
  try {
    const fs = require("node:fs");
    const dir = notesDir();
    if (!fs.existsSync(dir)) return "暂无备忘录（目录尚未创建）";
    const lower = query.toLowerCase();
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full.toLowerCase().endsWith(".md")) {
          const text = fs.readFileSync(full, "utf8");
          if (text.toLowerCase().includes(lower)) {
            const firstLine = text.split("\n").find((l: string) => l.trim()) || "";
            hits.push(`「${entry.name.replace(/\.md$/, "")}」: ${firstLine.trim().slice(0, 60)}`);
          }
        }
      }
    };
    walk(dir);
    if (hits.length === 0) return `没有找到包含「${query}」的备忘录`;
    return hits.slice(0, 10).join("\n");
  } catch (error) {
    return `搜索备忘录失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Windows 创建提醒：解析到期时间后派生后台 powershell，到点蜂鸣提醒 */
export async function createReminder(title: string, dueDate?: string, _notes?: string): Promise<string> {
  let diffSec: number;
  if (dueDate) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})/.exec(dueDate.trim());
    if (!m) return `提醒时间格式无效：${dueDate}，请使用 YYYY-MM-DD HH:MM 格式`;
    const [_, y, mo, d, h, mi] = m.map(Number);
    const target = new Date(y, mo - 1, d, h, mi, 0);
    const diffMs = target.getTime() - Date.now();
    if (diffMs <= 0) return `提醒时间 ${dueDate} 已过期，请指定未来的时间`;
    diffSec = Math.round(diffMs / 1000);
  } else {
    diffSec = 5;
  }

  const safeTitle = title.replace(/['\r\n]+/g, "");
  const inner = `Start-Sleep -Seconds ${diffSec}; for (\$i = 0; \$i -lt 3; \$i++) { [console]::beep(1100, 600); Start-Sleep -Milliseconds 350 }; [console]::beep(1500, 900)`;
  try {
    const script = `Start-Process powershell.exe -ArgumentList '-NoProfile','-WindowStyle','Hidden','-Command','${inner.replace(/'/g, "''")}'`;
    await runPowerShell(script);
    const when = dueDate ? `（${dueDate} 提醒）` : "（5 秒后提醒）";
    return `已设置提醒「${safeTitle}」${when}`;
  } catch {
    return unavailableOnWindows("创建提醒（Reminders）");
  }
}

/** Windows 创建日历事件：Outlook COM 日历文件夹新建 AppointmentItem */
export async function createCalendarEvent(
  title: string, startDate: string, endDate?: string, location?: string, notes?: string
): Promise<string> {
  try {
    const start = new Date(startDate);
    if (isNaN(start.getTime())) return `日历事件开始时间格式无效：${startDate}`;
    const end = endDate && endDate.trim() ? new Date(endDate) : new Date(start.getTime() + 60 * 60 * 1000);
    if (isNaN(end.getTime())) return `日历事件结束时间格式无效：${endDate}`;

    const script = `
try {
  $outlook = New-Object -ComObject Outlook.Application
  $ns = $outlook.GetNamespace("MAPI")
  $cal = $ns.GetDefaultFolder(9)
  $appt = $cal.Items.Add(1)
  $appt.Subject = $env:DAISY_ARG0
  $appt.Start = [datetime]$env:DAISY_ARG1
  $appt.End = [datetime]$env:DAISY_ARG2
  $appt.Location = $env:DAISY_ARG3
  $appt.Body = $env:DAISY_ARG4
  $appt.Save()
  Write-Output "OK"
} catch { Write-Output "NO_OUTLOOK" }`;
    const result = await runPowerShell(script, {
      args: [title, start.toISOString(), end.toISOString(), location || "", notes || ""],
      timeoutMs: 60000,
    });
    if (result.includes("NO_OUTLOOK")) return OFFICE_NOT_FOUND;
    const endStr = `${end.getMonth() + 1}月${end.getDate()}日 ${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
    return `已在日历创建事件「${title}」（${endStr} 结束）`;
  } catch (error) {
    return isNoOfficeError(error) ? OFFICE_NOT_FOUND : `创建日历事件失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Windows 查看日历事件：Outlook COM 日历文件夹，[datetime] 强类型比较（绕开 Restrict 日期格式区域差异） */
export async function getCalendarEvents(days: number = 7): Promise<string> {
  try {
    const now = new Date();
    const end = new Date(now.getTime() + Math.max(1, days) * 24 * 60 * 60 * 1000);
    const iso = (d: Date) => d.toISOString();
    const script = `
try {
  $outlook = New-Object -ComObject Outlook.Application
  $ns = $outlook.GetNamespace("MAPI")
  $cal = $ns.GetDefaultFolder(9)
  $items = $cal.Items
  $items.IncludeRecurrences = $true
  $items.Sort("[Start]", $true)
  $from = [datetime]::Parse($env:DAISY_ARG0)
  $to = [datetime]::Parse($env:DAISY_ARG1)
  $results = @()
  foreach ($evt in $items) {
    if ($results.Count -ge 20) { break }
    try {
      if ($evt.Start -ge $from -and $evt.Start -le $to) {
        $results += ("EVT:" + $evt.Subject + "|" + $evt.Start.ToString("MM-dd HH:mm") + "|" + $evt.Location)
      }
    } catch { }
  }
  if ($results.Count -eq 0) { Write-Output "NONE" }
  else { $results | ForEach-Object { Write-Output $_ } }
} catch { Write-Output "NO_OUTLOOK" }`;
    const result = await runPowerShell(script, { args: [iso(now), iso(end)], timeoutMs: 60000 });
    if (result.includes("NO_OUTLOOK")) return OFFICE_NOT_FOUND;
    if (result.trim() === "NONE" || !result.trim()) return `未来 ${days} 天内没有日历事件`;
    return result.trim().split("\n").map((line) => {
      const m = /^EVT:(.*)\|(.*)\|(.*)$/.exec(line);
      return m ? `${m[2]}  ${m[1]}${m[3] ? `（${m[3]}）` : ""}` : line;
    }).join("\n");
  } catch (error) {
    return isNoOfficeError(error) ? OFFICE_NOT_FOUND : `查看日历失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Windows 切换音频输出设备：Core Audio API 枚举渲染端点并设默认（无需第三方工具） */
export async function switchAudioOutput(deviceName: string): Promise<string> {
  try {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    int GetDevice(string id, out IMMDevice device);
    int RegisterEndpointNotificationCallback(IntPtr callback);
    int UnregisterEndpointNotificationCallback(IntPtr callback);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr param, out IntPtr iface);
    int OpenPropertyStore(int access, out IPropertyStore props);
    int GetId(out IntPtr id);
    int GetState(out int state);
}

[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    int Commit();
}

[StructLayout(LayoutKind.Sequential)]
struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Explicit)]
struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pwszVal;
}

[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
class CPolicyConfigClient { }

[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
    int GetMixFormat(IntPtr pszDeviceName, IntPtr ppFormat);
    int GetDeviceFormat(IntPtr pszDeviceName, bool bDefault, IntPtr ppFormat);
    int ResetDeviceFormat(IntPtr pszDeviceName);
    int SetDeviceFormat(IntPtr pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod(IntPtr pszDeviceName, bool bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
    int SetProcessingPeriod(IntPtr pszDeviceName, IntPtr pmftPeriod);
    int GetShareMode(IntPtr pszDeviceName, IntPtr pMode);
    int SetShareMode(IntPtr pszDeviceName, IntPtr mode);
    int GetPropertyValue(IntPtr pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
    int SetPropertyValue(IntPtr pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int role);
    int SetEndpointVisibility(IntPtr pszDeviceName, bool bVisible);
}

public static class AudioHelper {
    [DllImport("ole32.dll")] public static extern int CoTaskMemFree(IntPtr pv);
    public static string GetDeviceName(IMMDevice device) {
        IPropertyStore props;
        device.OpenPropertyStore(0, out props);
        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");
        key.pid = 14;
        PROPVARIANT val = new PROPVARIANT();
        props.GetValue(ref key, out val);
        string name = Marshal.PtrToStringUni(val.pwszVal) ?? "";
        CoTaskMemFree(val.pwszVal);
        return name;
    }
    public static string GetDeviceId(IMMDevice device) {
        IntPtr id;
        device.GetId(out id);
        string s = Marshal.PtrToStringUni(id) ?? "";
        CoTaskMemFree(id);
        return s;
    }
}
"@
$target = $env:DAISY_ARG0
$enumerator = New-Object MMDeviceEnumeratorComObject
$devices = $null
[void]$enumerator.EnumAudioEndpoints(0, 1, [ref]$devices)
$count = 0
[void]$devices.GetCount([ref]$count)
$found = $false
$deviceList = @()
for ($i = 0; $i -lt $count; $i++) {
    $dev = $null
    [void]$devices.Item($i, [ref]$dev)
    $id = [AudioHelper]::GetDeviceId($dev)
    $name = [AudioHelper]::GetDeviceName($dev)
    if ($name) { $deviceList += $name }
    if ($target -and $name -and $name.ToLower().Contains($target.ToLower())) {
        $policy = New-Object CPolicyConfigClient
        [void]$policy.SetDefaultEndpoint($id, 0)
        [void]$policy.SetDefaultEndpoint($id, 1)
        [void]$policy.SetDefaultEndpoint($id, 2)
        $found = $true
        Write-Output ("SWITCHED:" + $name)
        break
    }
}
if (-not $found) {
    if ($target) { Write-Output ("NOT_FOUND:" + ($deviceList -join '|')) }
    else { Write-Output ("LIST:" + ($deviceList -join '|')) }
}`;
    const result = await runPowerShell(script, { args: [deviceName || ""], timeoutMs: 60000 });
    if (result.startsWith("SWITCHED:")) {
      return `已将音频输出切换到「${result.slice(9)}」`;
    }
    if (result.startsWith("LIST:")) {
      return `当前可用的音频输出设备：\n${result.slice(5).split("|").join("\n")}`;
    }
    const devices = result.startsWith("NOT_FOUND:") ? result.slice(10).split("|") : [];
    return `未找到名为「${deviceName}」的音频设备。${devices.length ? `当前可用的输出设备：${devices.join("、")}` : ""}`;
  } catch (error) {
    return `切换音频输出失败: ${error instanceof Error ? error.message : String(error)}`;
  }
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

/** Windows 左右分屏：激活应用窗口后发 Win+Left / Win+Right（原生 Snap 布局） */
export async function splitScreen(left: string, right: string): Promise<string> {
  try {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SnapKey {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
function Invoke-Snap($appName, $keyCode) {
    $shell = New-Object -ComObject WScript.Shell
    $activated = $shell.AppActivate($appName)
    if (-not $activated) { return $false }
    Start-Sleep -Milliseconds 350
    [SnapKey]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
    [SnapKey]::keybd_event([byte]$keyCode, 0, 0, [UIntPtr]::Zero)
    [SnapKey]::keybd_event([byte]$keyCode, 0, 2, [UIntPtr]::Zero)
    [SnapKey]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 350
    return $true
}
$leftOk = Invoke-Snap $env:DAISY_ARG0 0x25
$rightOk = Invoke-Snap $env:DAISY_ARG1 0x27
if (-not $leftOk -and -not $rightOk) { Write-Output "NOT_FOUND" }
elseif ($leftOk -and $rightOk) { Write-Output "BOTH" }
elseif ($leftOk) { Write-Output "LEFT_ONLY" }
else { Write-Output "RIGHT_ONLY" }`;
    const result = await runPowerShell(script, { args: [left, right] });
    if (result === "NOT_FOUND") {
      return `未找到运行中的应用窗口：「${left}」「${right}」，请先打开两个应用`;
    }
    const parts: string[] = [];
    if (result.includes("LEFT")) parts.push(`「${left}」已分到左半屏`);
    if (result.includes("RIGHT")) parts.push(`「${right}」已分到右半屏`);
    return `分屏完成：${parts.join("，")}`;
  } catch {
    return unavailableOnWindows("左右分屏");
  }
}

/** Windows 勿扰模式：关闭/开启所有 Toast 通知（等效专注助手静音通知） */
export async function setDoNotDisturb(enable: boolean): Promise<string> {
  try {
    const script = `
$path = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings'
New-Item -Path $path -Force | Out-Null
New-ItemProperty -Path $path -Name 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -PropertyType DWord -Value $env:DAISY_ARG0 -Force | Out-Null
Write-Output "OK"`;
    await runPowerShell(script, { args: [enable ? "0" : "1"] });
    return enable ? "已开启勿扰模式（所有应用通知已静音）" : "已关闭勿扰模式（通知恢复）";
  } catch {
    return unavailableOnWindows("勿扰/专注模式");
  }
}

/** Windows 文档互转：Word COM 打开源文件后 SaveAs 目标格式；txt/md 纯文本直转不经 Word */
export async function convertDocument(source: string, target: string): Promise<string> {
  try {
    const fs = require("node:fs");
    const expand = (p: string): string => p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
    const src = expand(source);
    const dst = expand(target);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;

    const srcExt = path.extname(src).toLowerCase();
    const dstExt = path.extname(dst).toLowerCase();
    const isText = (e: string) => e === ".txt" || e === ".md";
    const targetExt = dstExt || ".txt";

    // 纯文本互转（txt/md 双向）：不依赖 Word，直接读写
    if (isText(srcExt) && isText(targetExt)) {
      fs.writeFileSync(dst, fs.readFileSync(src, "utf8"), "utf8");
      return `已转换文档，保存至「${path.basename(dst)}」`;
    }

    const fmtMap: Record<string, number> = {
      ".txt": 2, ".html": 8, ".htm": 8, ".rtf": 6,
      ".pdf": 17, ".doc": 0, ".docx": 16, ".odt": 23,
    };
    const fmt = fmtMap[targetExt] ?? 16;
    const openAsText = isText(srcExt);

    const script = `
try { $word = New-Object -ComObject Word.Application } catch { Write-Output "NO_WORD"; exit }
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $word.Documents.Open($env:DAISY_ARG0, $false, $false, $false, "", "", $false, "", "", ${openAsText ? 7 : 0}, 0, $false)
$doc.SaveAs2($env:DAISY_ARG1, ${fmt})
$doc.Close(0)
$word.Quit()
Write-Output "OK"`;
    const result = await runPowerShell(script, { args: [src, dst], timeoutMs: 90000 });
    if (result.includes("NO_WORD")) return OFFICE_NOT_FOUND;
    if (result.trim() === "OK") return `已转换文档，保存至「${path.basename(dst)}」`;
    return `文档转换失败: ${result}`;
  } catch (error) {
    return isNoOfficeError(error) ? OFFICE_NOT_FOUND : `文档转换失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Windows 编辑 .docx：Word COM 实现 remove_colored_text（按颜色删除）；run_code 依赖 python 工具链，降级 */
export async function editDocument(
  source: string, target: string, operation: string,
  color?: string, _pageStart?: number, _pageEnd?: number, _code?: string
): Promise<string> {
  try {
    const fs = require("node:fs");
    const expand = (p: string): string => p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
    const src = expand(source);
    const dst = expand(target);
    if (!fs.existsSync(src)) return `找不到源文件「${source}」`;
    if (path.extname(src).toLowerCase() !== ".docx") return `edit_document 仅支持 .docx 文件`;

    if (operation === "remove_colored_text") {
      const hex = (color || "FF0000").replace(/[^0-9A-Fa-f]/g, "").toUpperCase().padStart(6, "0");
      const script = `
try { $word = New-Object -ComObject Word.Application } catch { Write-Output "NO_WORD"; exit }
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $word.Documents.Open($env:DAISY_ARG0, $false, $false)
$hex = $env:DAISY_ARG2
$r = [Convert]::ToInt32($hex.Substring(0,2),16)
$g = [Convert]::ToInt32($hex.Substring(2,2),16)
$b = [Convert]::ToInt32($hex.Substring(4,2),16)
$wdColor = $b*65536 + $g*256 + $r
$sel = $word.Selection
[void]$sel.HomeKey(6)
[void]$sel.Find.ClearFormatting()
$sel.Find.Font.Color = $wdColor
$sel.Find.Text = ""
$sel.Find.Wrap = 1
$count = 0
while ($sel.Find.Execute()) {
  [void]$sel.Delete()
  $count++
}
$doc.SaveAs2($env:DAISY_ARG1, 16)
$doc.Close(0)
$word.Quit()
Write-Output ("DELETED:" + $count)`;
      const result = await runPowerShell(script, { args: [src, dst, hex], timeoutMs: 90000 });
      if (result.includes("NO_WORD")) return OFFICE_NOT_FOUND;
      const m = /DELETED:(\d+)/.exec(result);
      const count = m ? Number(m[1]) : 0;
      return `已删除 ${count} 处 ${hex} 色文本，保存至「${path.basename(dst)}」`;
    }

    if (operation === "run_code") {
      return "run_code 操作当前仅支持 macOS（依赖 python-docx 工具链）。";
    }
    return `不支持的操作类型：${operation}`;
  } catch (error) {
    return isNoOfficeError(error) ? OFFICE_NOT_FOUND : `文档编辑失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Windows Shell 命令执行：经 runPowerShell 无 shell 直传。
 * 用户命令经 DAISY_ARG0 环境变量注入（杜绝拼接注入），脚本内用 Invoke-Expression
 * 真正执行命令本体（此前直接 `$env:DAISY_ARG0` 只回显文本不执行，导致 LLM 收不到任何输出），
 * `2>&1` 合并 stderr 防止命令报错时静默失败，`Set-Location $HOME` 对齐 macOS 的 cwd 语义。
 */
export async function runShellCommand(command: string): Promise<{ stdout: string; stderr: string }> {
  try {
    const stdout = await runPowerShell(`Set-Location $HOME
Invoke-Expression $env:DAISY_ARG0 2>&1`, { args: [command], timeoutMs: 30000 });
    return { stdout, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: message };
  }
}
