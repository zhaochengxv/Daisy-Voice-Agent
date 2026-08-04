import { execFile } from "node:child_process";

/**
 * 统一的 AppleScript 执行入口。
 *
 * 采用 execFile("osascript") + stdin 传脚本的方式，避免走 shell，
 * 防止脚本内容中的特殊字符被二次解释（无命令注入面）。
 * 全项目唯一实现，禁止再各自实现 runAppleScript。
 */
export function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("osascript", [], (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(_stdout.trim());
      }
    });
    child.stdin?.write(script);
    child.stdin?.end();
  });
}
