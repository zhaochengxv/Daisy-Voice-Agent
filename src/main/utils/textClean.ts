/**
 * 统一的 TTS 文本清洗函数。
 *
 * 合并 index.ts stripMarkdownForTTS 与 deepseek.ts cleanTextForTTS 两处行为，
 * 全项目唯一实现。所有进入 TTS 的文本必须经过此函数清洗。
 * - 去除 Markdown 符号、emoji、特殊字符
 * - `~` 统一替换为「到」（如 3~5 天 → 3 到 5 天）
 */
export function cleanTextForTTS(text: string): string {
  return text
    .replace(/<display>[\s\S]*?<\/display>/gi, "")
    .replace(/<\/?display>/gi, "")
    .replace(/<\/?speech>/gi, "")
    .replace(/\{"display"\s*:\s*"?/g, "")
    .replace(/"speech"\s*:\s*"?/g, "")
    .replace(/"\s*\}/g, "")
    .replace(/\\n/g, " ")
    .replace(/\\["\\/]/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*#_|]/g, "") // 保留 ~，由下方统一替换为「到」
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{2702}\u{2705}\u{2708}-\u{270F}\u{2764}\u{2763}\u{00A9}\u{00AE}\u{2122}\u{200D}\u{FE0F}]/gu, "")
    .replace(/℃/g, "度")
    .replace(/°C/g, "度")
    .replace(/°/g, "度")
    .replace(/~/g, "到")
    .replace(/\s{2,}/g, " ")
    .trim();
}
