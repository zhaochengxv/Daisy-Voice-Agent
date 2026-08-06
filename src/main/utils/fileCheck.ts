import fs from "node:fs";
import path from "node:path";

/**
 * 统一输出文件落盘校验：任何声称「已生成产物」的工具（文档转换、视频截取/转换/提取等）
 * 都必须经此校验，杜绝「假成功」——LLM 拿到空路径后反复找文件的无效循环。
 */
export function ensureOutputWritten(dst: string, actionLabel = "文档转换"): string | null {
  try {
    const st = fs.statSync(dst);
    if (st.isFile() && st.size > 0) return null;
  } catch {
    // 文件不存在 → 走下方统一失败文案
  }
  return `${actionLabel}失败：未检测到输出文件「${path.basename(dst)}」，产物未成功写入磁盘`;
}
