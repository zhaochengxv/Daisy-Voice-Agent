"use strict";
/**
 * PowerShell 脚本语法验证工具（开发用，不参与 CI）。
 *
 * 用法：node scripts/check-ps.js
 * 需要 PowerShell 7 可用：设置环境变量 PWSH 指向 pwsh，或在 PATH 中，或位于 /tmp/pwsh/pwsh。
 *
 * 提取 src/main/control/windows.ts 中所有 runPowerShell 脚本，用
 * [System.Management.Automation.Language.Parser]::ParseInput 做语法检查。
 * 真机 Windows 的运行时行为（剪贴板、user32、COM）仍需冒烟清单验证。
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function findPwsh() {
  if (process.env.PWSH) return process.env.PWSH;
  try {
    execFileSync("which", ["pwsh"], { stdio: "ignore" });
    return "pwsh";
  } catch {
    const fallback = "/tmp/pwsh/pwsh";
    if (fs.existsSync(fallback)) return fallback;
  }
  return null;
}

/** 提取 TS 源文件中所有反引号模板字符串（处理 \` 转义） */
function extractTemplates(src) {
  const scripts = [];
  const re = /`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const raw = m[1];
    let out = "";
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "\\" && i + 1 < raw.length) {
        out += raw[i + 1];
        i++;
      } else {
        out += raw[i];
      }
    }
    scripts.push(out);
  }
  return scripts;
}

function syntaxCheck(script, pwsh) {
  const encoded = Buffer.from(script).toString("base64");
  const cmd = `$e = [System.Management.Automation.Language.Parser]::ParseInput([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')), [ref]$null, [ref]$err); if ($err.Count -gt 0) { $err | ForEach-Object { $_.Message + ' @line ' + $_.Extent.StartLineNumber } } else { 'OK' }`;
  const out = execFileSync(pwsh, ["-NoProfile", "-Command", cmd], {
    env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: "1" },
    timeout: 30000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.trim();
}

function main() {
  const pwsh = findPwsh();
  if (!pwsh) {
    console.log("未找到 pwsh。设置 PWSH 环境变量、加入 PATH，或安装到 /tmp/pwsh/pwsh。");
    process.exit(0);
  }
  const file = process.argv[2] || "src/main/control/windows.ts";
  const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const scripts = extractTemplates(src);
  let failed = 0;
  for (const script of scripts) {
    const result = syntaxCheck(script, pwsh);
    if (result !== "OK") {
      failed++;
      console.log(`\n--- ${file} 脚本语法错误 ---`);
      console.log(result);
    }
  }
  if (failed === 0) {
    console.log(`[check-ps] ${file}: ${scripts.length} 个 PowerShell 脚本全部语法正确`);
  } else {
    console.log(`[check-ps] ${file}: ${failed}/${scripts.length} 个脚本存在语法错误`);
    process.exit(1);
  }
}

main();
