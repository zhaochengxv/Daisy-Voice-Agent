import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBundledBin } from "../config/env";
import { log, logError } from "./logger";

const execFileAsync = promisify(execFile);

export interface AudioSwitchResult {
  device: string | null;
  available: string[];
}

/**
 * 音频输出切换的单一实现。
 *
 * 通过 SwitchAudioSource 列出输出设备，按「精确 → 忽略空格 → 模糊包含 →
 * 声卡/音频接口关键词 → 子串打分」五级策略匹配目标设备，
 * 匹配成功后执行切换并返回结果。macos.ts 与 router.ts 均通过此函数实现，
 * 禁止再各自实现一套切换逻辑。
 */
export async function switchAudioOutput(target: string): Promise<AudioSwitchResult> {
  try {
    const SW = getBundledBin("SwitchAudioSource");
    const { stdout } = await execFileAsync(SW, ["-a", "-t", "output"]);
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    // The active device has (*) appended; strip it for matching
    const devices = lines.map((l) => l.replace(/\s*\(.*\)\s*$/, "").trim());
    log(`switchAudioOutput: available devices: ${devices.join(", ")}`);

    // Normalize helper: strip spaces for comparison ("SSL2" ↔ "SSL 2")
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    const targetLower = target.toLowerCase();
    const targetNorm = normalize(target);

    // 1. Exact match (case-insensitive)
    let best = devices.find((d) => d.toLowerCase() === targetLower);

    // 2. Normalized match (ignoring spaces)
    if (!best) {
      best = devices.find((d) => normalize(d) === targetNorm);
    }

    // 3. Fuzzy includes match
    if (!best) {
      best = devices.find((d) => d.toLowerCase().includes(targetLower) || targetLower.includes(d.toLowerCase()));
    }

    // 4. Normalized includes match
    if (!best) {
      best = devices.find((d) => normalize(d).includes(targetNorm) || targetNorm.includes(normalize(d)));
    }

    // 5. "声卡"/"音频接口" → try to find a pro audio interface device
    if (!best && /声卡|音频接口|audio\s*interface/i.test(target)) {
      best = devices.find((d) => /SSL|audio|interface|usb|thunderbolt|firewire|rme|focusrite|apollo|motu|ua[ -]|volt/i.test(d));
    }

    // 6. Last resort: substring scoring
    if (!best) {
      const scored = devices
        .map((d) => ({ name: d, score: d.toLowerCase().includes(targetLower) ? d.length : 999 }))
        .sort((a, b) => a.score - b.score);
      if (scored[0] && scored[0].score < 999) best = scored[0].name;
    }

    if (!best) {
      log(`switchAudioOutput: no device matching "${target}"`);
      return { device: null, available: devices };
    }

    await execFileAsync(SW, ["-t", "output", "-s", best]);
    log(`switchAudioOutput: switched to "${best}"`);
    return { device: best, available: devices };
  } catch (err) {
    logError("switchAudioOutput failed", err);
    return { device: null, available: [] };
  }
}
