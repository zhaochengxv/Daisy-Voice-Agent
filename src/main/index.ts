import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, ipcMain, Menu, BrowserWindow, systemPreferences, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { config, isAsrConfigured, isLlmConfigured, getWhisperModelPath, getBundledBin, WHISPER_MODELS, getWritableEnvPath, expectedWhisperModelBytes } from "./config/env";
import { IPC_CHANNELS } from "./ipc/channels";
import { createFloatWindow, getFloatWindow, sendToFloatWindow, showFloatWindow, hideFloatWindow, handleFloatDrag, setFloatWindowMode, getFloatWindowMode } from "./windows/floatWindow";
import { createSettingsWindow, getSettingsWindow } from "./windows/settingsWindow";
import { createTray, destroyTray } from "./windows/tray";
import { initAudioRecorder, startRecording, stopRecording, getIsRecording, setWakeWordCaptureEnabled, getAudioDevices, getAudioInputDevice, setAudioInputDevice } from "./audio/recorder";
import { AsrSession } from "./asr";
import { WhisperAsrSession } from "./asr/whisper";
import { whisperServer } from "./asr/whisperServer";
import {
  downloadWhisperGpuComponent,
  extractWhisperGpuComponent,
  removeWhisperGpuComponent,
  gpuComponentDownloaded,
  findLocalGpuZip,
  SlowNetworkError,
} from "./asr/whisperGpu";
import { detectNvidiaGpu } from "./control/windows";
import { DeepSeekClient, DualChannel } from "./llm/deepseek";
import { ConversationManager, prefetchDesktopPath, setPendingSnapshotProvider } from "./llm/conversation";
import { TaskMemory } from "./llm/taskMemory";
import { EdgeTTSPlayer, startTTSCleanup } from "./tts/edgeTTS";
import { TtsPipeline } from "./tts/pipeline";
import { StreamTts } from "./tts/streamTts";
import { GlobalShortcut } from "./shortcut/globalShortcut";
import { WakeWordMonitor, VAD } from "./wakeword/monitor";
import { tryLocalCommand, initCommandRouter } from "./command/router";
import { log, logError } from "./utils/logger";
import { cleanTextForTTS } from "./utils/textClean";
import { runAppleScript } from "./utils/appleScript";
import { isWindows } from "./utils/windowsShell";
import { VolumeGuard } from "./control/volumeGuard";
import { ConversationHistory } from "./history";

{
  // 仅在 macOS 补充 Homebrew 路径；Windows PATH 以 ; 分隔，跳过避免破坏环境变量
  if (!isWindows()) {
    const pathParts = (process.env.PATH || "").split(":").filter(Boolean);
    for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (!pathParts.includes(p)) pathParts.unshift(p);
    }
    process.env.PATH = pathParts.join(":");
  }
}

const execFileAsync = promisify(execFile);

const AUTO_HIDE_TIMEOUT_MS = 15000; // 答案播完停留 15s 供阅读，再自动隐藏
const CONVERSATION_EXPIRE_MS = 5 * 60 * 1000; // 5 minutes

function playSound(name: string): void {
  if (isWindows()) {
    // Windows 用 PowerShell 播放系统提示音
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[console]::beep(880, 180)"], { windowsHide: true }, () => {
      // ignore — 系统提示音播放失败不影响主流程
    });
    return;
  }
  execFile("afplay", [`/System/Library/Sounds/${name}.aiff`], () => {
    // ignore — 系统提示音播放失败不影响主流程
  });
}

let asrSession: AsrSession | WhisperAsrSession | null = null;
let llmClient: DeepSeekClient | null = null;
let globalShortcut: GlobalShortcut | null = null;
let shortcutPermissionTimer: NodeJS.Timeout | null = null;
let conversationManager: ConversationManager | null = null;
let autoHideTimer: NodeJS.Timeout | null = null;
let safetyNetTimer: NodeJS.Timeout | null = null;
let isOrbVisible = false;
let isSpeaking = false;
let isMuted = false; // orb 点击静音后的待命态：TTS 已停但回答保留，点击 orb 可重听
let lastAnswerSpeech = ""; // 最近一次最终回答的纯文本（muted 后重听用）
let playingTtsSessionId: number | null = null;  // session ID when TTS playback started
let toolAckPending = false;
let wakeWordMonitor: WakeWordMonitor | null = null;
let currentSessionId = 0;  // increments on each new session, used to detect stale async callbacks
let currentState: string = "idle"; // 最近一次 updateState 的状态，供 wake 回调判断「任务途中插入需求」
let isScreenLocked = false;

const volumeGuard = new VolumeGuard();
const ttsPipeline = new TtsPipeline();
const taskMemory = new TaskMemory();

// 崩溃兜底：未捕获异常/拒绝一律落盘，避免静默崩溃无法诊断
process.on("uncaughtException", (error) => {
  logError("UNCAUGHT EXCEPTION", error);
});
process.on("unhandledRejection", (reason) => {
  logError("UNHANDLED REJECTION", reason);
});

// 单实例锁：二次启动时唤起已有实例的设置窗，杜绝「双击无反应」
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      createSettingsWindow();
    }
  });
}

app.whenReady().then(() => {
  log("App ready");
  // Show dock icon on macOS
  if (process.platform === "darwin") {
    app.dock?.show();
  }
  // Sync auto-launch setting on startup
  if (config.autoLaunch) {
    app.setLoginItemSettings({ openAtLogin: true });
  }
  startTTSCleanup();
  // Windows 异步预取真实桌面路径（OneDrive 重定向），供 LLM 环境信息使用
  prefetchDesktopPath().catch(() => {});
  initialize();
});

app.on("window-all-closed", () => {
  // Keep app running in background on macOS
});

app.on("activate", () => {
  if (!getFloatWindow() || getFloatWindow()!.isDestroyed()) {
    createFloatWindow();
  }
  createSettingsWindow();
});

app.on("before-quit", () => {
  globalShortcut?.destroy();
  asrSession?.stop();
  wakeWordMonitor?.stop();
  whisperServer.dispose();
  destroyTray();
  // Clean up TTS temp files
  const ttsDir = path.join(require("os").tmpdir(), "diri-tts");
  try {
    if (fs.existsSync(ttsDir)) {
      for (const f of fs.readdirSync(ttsDir)) {
        if (f.startsWith("diri-tts-") && f.endsWith(".mp3")) {
          fs.unlinkSync(path.join(ttsDir, f));
        }
      }
    }
  } catch { /* ignore */ }
  if (safetyNetTimer) {
    clearTimeout(safetyNetTimer);
    safetyNetTimer = null;
  }
});

function initialize(): void {
  log("Initializing...");
  log(`ASR configured: ${isAsrConfigured()}, LLM configured: ${isLlmConfigured()}, shortcutUseWhisper: ${config.whisper.shortcutUseWhisper}`);

  // Windows 无 dock 图标，托盘是唯一常驻入口；macOS 有 dock 不强制
  if (isWindows()) {
    createTray();
  }

  // 首次启动（未配置 ASR 与 LLM）直接显示设置窗引导配置；
  // 否则隐藏预创建，用户触发时零延迟
  const firstRun = !isAsrConfigured() && !isLlmConfigured();
  createSettingsWindow(firstRun);
  createFloatWindow();

  setupIpc();
  setupAudio();
  setupShortcut();
  setupWakeWord();
  setupPowerMonitor();
  initCommandRouter();
  conversationHistoryStore.load();
  // 加载「上次未完成任务」快照：中断后新会话据此恢复任务，用户说「继续」时不再失忆
  taskMemory.load();
  setPendingSnapshotProvider(() => taskMemory.getPending());
  // 启用了 whisper 转写（快捷键本地 ASR）或唤醒词时，后台预热 whisper-server，
  // 让首次转写零冷启动（模型加载提前到应用启动阶段完成）。
  if (config.whisper.shortcutUseWhisper || wakeWordMonitor) {
    whisperServer.warmup();
  }
  log("Initialization complete");
}

function setupPowerMonitor(): void {
  const { powerMonitor } = require("electron");

  powerMonitor.on("lock-screen", () => {
    if (isScreenLocked) return;
    isScreenLocked = true;
    log("PowerMonitor: Screen locked. Stopping all voice activity for privacy (TTS, recording, wake word).");
    // 全面终止：停止 TTS 播放、停止录音/ASR、中止 LLM、暂停唤醒词监听，
    // 杜绝锁屏后环境音误识别唤醒或继续播报隐私内容
    abortAllTasks();
    log("PowerMonitor: All voice activity stopped on lock.");
  });

  powerMonitor.on("unlock-screen", () => {
    isScreenLocked = false;
    log("PowerMonitor: Screen unlocked. Resuming wake word monitor.");
    if (wakeWordMonitor && config.wakeWord.enabled) {
      try {
        wakeWordMonitor.resume();
        log("PowerMonitor: Wake word monitor successfully resumed.");
      } catch (err) {
        logError("PowerMonitor: Failed to resume wake word monitor", err);
      }
    }
  });
}

function setupWakeWord(): void {
  if (!config.wakeWord.enabled) {
    log("Wake word detection disabled");
    setWakeWordCaptureEnabled(false);
    return;
  }
  const whisperBin = getBundledBin("whisper-cli");
  let whisperAvailable = fs.existsSync(whisperBin);
  if (!whisperAvailable) {
    try {
      if (isWindows()) {
        require("child_process").execSync("where whisper-cli", { stdio: "ignore" });
      } else {
        require("child_process").execSync("which whisper-cli", { stdio: "ignore" });
      }
      whisperAvailable = true;
    } catch {}
  }
  if (!whisperAvailable) {
    log("Wake word disabled: whisper-cli not found (not bundled and not on PATH)");
    setWakeWordCaptureEnabled(false);
    return;
  }
  log(`Wake word detection enabled, keyword: ${config.wakeWord.keyword}`);
  wakeWordMonitor = new WakeWordMonitor(config.wakeWord.keyword);

  wakeWordMonitor.on("wake", (command?: string) => {
    // If already in voice listening mode, ignore (don't re-trigger)
    if (voiceWakeMode) {
      log("Already in voice listening mode, ignoring wake word");
      return;
    }

    // 锁屏期间（含在途音频迟到结果）一律忽略，保障隐私安全
    if (isScreenLocked) {
      log("Screen locked, ignoring wake word");
      return;
    }

    log(`Wake word detected! command="${command || ""}"`);

    // 任务进行中（thinking/processing，含长工具任务）喊醒：
    // 不再破坏式 abortAllTasks 销毁上下文，而是直接接管为新一轮指令——
    // handleUserInput 内部 currentSessionId++ 会使旧一轮 LLM 回调自然失效，
    // 工具任务上下文由 ConversationManager 延续，实现「任务途中插入临时需求」。
    // 仅当唤醒附带命令时才走接管；仅喊唤醒词（无命令）则照旧中断并聆听新指令。
    const isMidTask = isSessionActive && (currentState === "thinking" || currentState === "processing");
    if (isMidTask && command?.trim()) {
      log(`Wake word during active task: switching to new command "${command.trim()}" instead of aborting`);
      wasWokenByVoice = true;
      stopAutoHideTimer();
      showOrb();
      playSound("Purr");
      handleUserInput(command.trim());
      return;
    }
    if (isMidTask) {
      log("Wake word during active task without command: aborting to listen for new instruction");
    }

    // Abort all current tasks (LLM, TTS, ASR, timers)
    abortAllTasks();

    wasWokenByVoice = true;

    stopAutoHideTimer();
    showOrb();
    playSound("Purr");

    if (command) {
      // 唤醒时附带命令（如“嘿黛西，打开音乐”）：直接执行，无需用户重复
      log(`Wake word command: executing "${command}" directly`);
      handleUserInput(command);
      return;
    }

    // Start voice listening mode
    startVoiceListening();
  });

  wakeWordMonitor.start();
  setWakeWordCaptureEnabled(true);
}

function setupAudio(): void {
  initAudioRecorder(
    (buffer) => {
      asrSession?.feedPcm(buffer);
      wakeWordMonitor?.feedPcm(buffer);
    },
    (message) => {
      logError("Audio error", message);
      updateState("error", message);
    },
  );
}

function setupShortcut(): void {
  log("Setting up global shortcut");
  const startListener = () => {
    if (globalShortcut) return;
    globalShortcut = new GlobalShortcut();

    globalShortcut.on("captured", (keyName: string) => {
      const win = getSettingsWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.SHORTCUT_CAPTURED, { keyName });
      }
    });

    globalShortcut.on("pressed", () => {
      log("Shortcut pressed");
      wakeAndStartListening();
    });

    globalShortcut.on("released", () => {
      log("Shortcut released");
      endListening();
    });
  };

  if (process.platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(true)) {
    log("GlobalShortcut: waiting for macOS Accessibility permission");
    shortcutPermissionTimer = setInterval(() => {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) return;
      if (shortcutPermissionTimer) clearInterval(shortcutPermissionTimer);
      shortcutPermissionTimer = null;
      log("GlobalShortcut: Accessibility permission granted");
      startListener();
    }, 1000);
    return;
  }

  startListener();
}

function ensureConversation(): ConversationManager {
  if (!conversationManager || conversationManager.isExpired(CONVERSATION_EXPIRE_MS)) {
    log("Creating new conversation");
    conversationManager = new ConversationManager();
  }
  return conversationManager;
}
function clearEarlyCommandTimer(): void {
  if (earlyCommandTimer) {
    clearTimeout(earlyCommandTimer);
    earlyCommandTimer = null;
  }
}

async function tryHandleLocalCommandEarly(text: string): Promise<boolean> {
  if (!text.trim() || asrResultConsumed || !isSessionActive) return false;
  const gen = currentSessionId;
  const result = await tryLocalCommand(text);
  // 代际守卫：期间新会话/新请求已递增 sessionId，丢弃过时结果
  if (gen !== currentSessionId) {
    log("tryHandleLocalCommandEarly stale (new session started), discarding result");
    return false;
  }
  if (result.handled) {
    log(`Local command handled early: ${result.action || ""}`);
    asrResultConsumed = true;
    isSessionActive = false;
    if (safetyNetTimer) {
      clearTimeout(safetyNetTimer);
      safetyNetTimer = null;
    }
    clearEarlyCommandTimer();
    sendToFloatWindow(IPC_CHANNELS.ASR_FINAL, text);
    playSound("Tink");
    updateState("idle");
    startAutoHideTimer();
    return true;
  }
  return false;
}

let isSessionActive = false;
let voiceWakeMode = false; // true when woken by voice (auto-send on silence)
let voiceEnding = false; // true while endVoiceListening 等待 ASR final：允许 final 迟到时仍进入 handleUserInput
let wasWokenByVoice = false; // tracks if session was initiated by voice wake-up
let voiceSilenceTimer: NodeJS.Timeout | null = null;
let voiceStartSilenceTimer: NodeJS.Timeout | null = null;
let earlyCommandTimer: NodeJS.Timeout | null = null;
let asrResultConsumed = false;
let voiceUseWhisper = false; // 连续对话模式当前 ASR 是否本地 whisper（决定安全网时长）
// 语音路径「停嘴后自动发送」的静音阈值。火山 partial 持续重置此计时器，
// 因此它只影响「用户说完话后多久发送」，不影响句中停顿。v1.5.18 由 3s 降到 2s：
// 真机日志显示唤醒→静音→发送全程感知延迟主要由这 3s 构成（发送后 ASR final 仅需
// ~100ms），2s 仍远大于中文句中停顿，既提速又不会切句子。
const VOICE_SILENCE_MS = 2000;
// 唤醒/持续对话 loop back 后等待用户开口的时间。真机实测：TTS 回复播完用户
// 需要反应时间，旧 3s 常被静音超时切断（用户感知「对话老中断」），放宽到 8s。
const VOICE_START_SILENCE_MS = 8000;

// 语音连续对话空转录兜底：唤醒后用户已开口（有 partial）但最终 ASR 返回空
// （唤醒词吞掉命令 / 麦克风瞬时静音 / 管线重建期讲话），重听一轮避免「任务未
// 完成就退出」；仍为空才回落 idle。仅在 wasWokenByVoice（已开口）时触发。
const MAX_EMPTY_TRANSCRIPT_RETRIES = 1;
let emptyTranscriptRetries = 0;

function stopSpeaking(): void {
  ttsPipeline.stop();
  isSpeaking = false;
  playingTtsSessionId = null;

  sendToFloatWindow(IPC_CHANNELS.TTS_END);
}

function muteCurrentAnswerSpeech(): void {
  // 已处于 muted 待命态：点击 orb = 重听最后回答，而不是被 isSpeaking 守卫拒绝（旧死锁）
  if (!isSpeaking && isMuted) {
    replayLastAnswer();
    return;
  }
  if (!isSpeaking || toolAckPending) {
    log("TTS mute request ignored — no final answer is currently being spoken");
    return;
  }

  log("TTS muted by orb click; retaining current answer state");

  ttsPipeline.stop();
  isSpeaking = false;
  isMuted = true;
  playingTtsSessionId = null;

  sendToFloatWindow(IPC_CHANNELS.TTS_END);

  // 语音连续对话模式：静音后回环到监听，保持免提连续性（与 done 的 isStopped 分支一致）；
  // 快捷键模式：进入 muted 待命态，悬浮球变换视觉（已静音色板），
  // 再次点击 orb 可重听，长按快捷键/唤醒词可继续新会话，不再死锁。
  if (wasWokenByVoice) {
    log("Continuous voice dialogue: loop back to listening after mute");
    startVoiceListening();
    return;
  }
  updateState("muted");
  startAutoHideTimer();
}

/** 重听被静音的最后回答：重新合成并朗读 lastAnswerSpeech */
function replayLastAnswer(): void {
  const text = lastAnswerSpeech;
  if (!text.trim()) {
    log("TTS replay ignored — no retained answer");
    isMuted = false;
    updateState("idle");
    startAutoHideTimer();
    return;
  }
  const chunks = splitForPipeline(text);
  if (chunks.length === 0) {
    log("TTS replay ignored — answer has no speakable content");
    isMuted = false;
    updateState("idle");
    startAutoHideTimer();
    return;
  }

  log(`TTS replay last answer (${text.length} chars, ${chunks.length} chunks)`);
  isMuted = false;
  const sessionId = currentSessionId;
  isSessionActive = true;
  wakeWordMonitor?.pause();
  updateState("speaking");
  synthesizeRemaining(chunks, sessionId);
}

function abortAllTasks(): void {
  // Increment session ID — all async callbacks from old session become stale
  currentSessionId++;

  // 1. Abort LLM
  if (llmClient) {
    llmClient.abort();
    llmClient = null;
  }

  // 2. Stop TTS playback + synthesis
  stopSpeaking();

  // 3. Stop ASR — remove listeners FIRST to prevent stale final events
  if (asrSession) {
    asrSession.removeAllListeners();
    asrSession.stop();
    asrSession = null;
  }

  // 4. Clear all timers
  clearEarlyCommandTimer();
  if (safetyNetTimer) {
    clearTimeout(safetyNetTimer);
    safetyNetTimer = null;
  }
  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
  if (voiceStartSilenceTimer) {
    clearTimeout(voiceStartSilenceTimer);
    voiceStartSilenceTimer = null;
  }
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }

  // 5. Reset state
  isSessionActive = false;
  voiceWakeMode = false;
  voiceEnding = false;
  wasWokenByVoice = false;
  toolAckPending = false;
  asrResultConsumed = false;
  isMuted = false;

  // 6. Stop recording
  if (getIsRecording()) {
    stopRecording();
  }

  // 7. Pause wake word monitor
  wakeWordMonitor?.pause();

  // 8. Restore volume (unmute if muted)
  unmuteSystemOnly();

  log(`abortAllTasks: session ${currentSessionId} (all tasks cleared)`);
}

function wakeAndStartListening(): void {
  const useWhisper = config.whisper.shortcutUseWhisper;
  if (!isLlmConfigured()) {
    log("Cannot start session: missing LLM API key");
    updateState("error", "请先配置大模型 API Key");
    createSettingsWindow();
    return;
  }
  if (!useWhisper && !isAsrConfigured()) {
    log("Cannot start session: missing ASR config");
    updateState("error", "请先配置 ASR 或启用本地 Whisper");
    createSettingsWindow();
    return;
  }

  // Abort all ongoing tasks (LLM, TTS, ASR, timers) and start fresh
  abortAllTasks();

  muteSystemAndPauseMedia();
  const sessionId = currentSessionId;
  log(`wakeAndStartListening: new session ${sessionId}, useWhisper=${useWhisper}`);
  isSessionActive = true;
  sendToFloatWindow(IPC_CHANNELS.TTS_END);

  // Ensure recorder is not stuck from a previous failed session
  if (getIsRecording()) {
    log("Recorder was stuck, force-stopping");
    stopRecording();
  }

  // Clean up any stale ASR session
  if (asrSession) {
    log("Stopping stale ASR session");
    asrSession.removeAllListeners();
    asrSession.stop();
    asrSession = null;
  }

  stopAutoHideTimer();
  showOrb();
  playSound("Purr");

  // Hold-to-talk should end on shortcut release, not on a brief pause between words.
  asrSession = useWhisper ? new WhisperAsrSession(false) : new AsrSession();
  asrSession.on("partial", (text) => {
    sendToFloatWindow(IPC_CHANNELS.ASR_PARTIAL, text);
  });
  asrSession.on("final", (text) => {
    clearEarlyCommandTimer();
    if (asrResultConsumed) {
      log(`ASR final arrived but already handled early: "${text}"`);
      return;
    }
    log(`ASR final: ${text}`);
    if (safetyNetTimer) {
      clearTimeout(safetyNetTimer);
      safetyNetTimer = null;
    }
    isSessionActive = false;
    stopRecording();
    sendToFloatWindow(IPC_CHANNELS.ASR_FINAL, text);
    handleUserInput(text);
  });
  asrSession.on("error", (message) => {
    clearEarlyCommandTimer();
    // final 已送达并进入 LLM/处理流程后（isSessionActive 已复位），火山仍可能补发
    // 会话结束类错误（如 45000081），此时上报会覆盖 processing/thinking 状态。
    if (!isSessionActive) {
      log(`ASR error ignored (session already finished): ${message}`);
      return;
    }
    logError("ASR error", message);
    if (safetyNetTimer) {
      clearTimeout(safetyNetTimer);
      safetyNetTimer = null;
    }
    isSessionActive = false;
    stopRecording();
    // 403 几乎总是火山 AppID / Access Token / ResourceId 鉴权不匹配，给出
    // 可操作的排查方向，避免用户误判为"没声音/没触发"。
    if (message.includes("403")) {
      const hint = "火山 ASR 鉴权失败(403)：请检查 daisy.env 中 VOLCENGINE_APP_ID、VOLCENGINE_ACCESS_TOKEN 与 VOLCENGINE_RESOURCE_ID 是否与火山控制台开通的服务一致";
      log(hint);
      updateState("error", hint);
    } else {
      updateState("error", message);
    }
    startAutoHideTimer();
  });

  updateState("listening");
  asrSession.start();
  startRecording();
}

function endListening(): void {
  if (!isSessionActive) {
    log("No active session, ignoring release");
    return;
  }
  voiceWakeMode = false;
  log("Stopping recording and ASR");
  playSound("Frog");
  stopRecording();

  // Check if we got any speech at all
  const hasPartial = asrSession?.getLastText()?.trim();
  if (hasPartial) {
    updateState("processing");
  } else {
    // No speech detected — go straight to idle, skip processing state
    updateState("idle");
  }

  asrSession?.stop();

  // Fast path: if the ASR server is slow to emit the final package, use the
  // latest partial transcript to execute local commands immediately.
  clearEarlyCommandTimer();
  earlyCommandTimer = setTimeout(async () => {
    if (!isSessionActive || !asrSession || asrResultConsumed) return;
    const partialText = asrSession.getLastText();
    if (partialText) {
      log(`Early local command check from partial: "${partialText}"`);
      const handled = await tryHandleLocalCommandEarly(partialText);
      if (handled) {
        asrSession?.removeAllListeners();
        asrSession = null;
      }
    }
  }, 500);

  // Safety net: 云端 ASR fast path 800ms、slow path 10s，用 12s；
  // 本地 whisper-cli 首次推理（弱 CPU + 142MB base 模型）可达数十秒，放宽到 50s，避免转写被中途杀掉。
  // 先清旧再排新：endListening 可能被并发调用（松键多 keyup 事件），旧 timer 若不清理
  // 会成为孤儿定时器，12s 后在下一个活跃会话中误触发强制重置（真机 09:07:03 实锤）。
  const useWhisper = config.whisper.shortcutUseWhisper;
  if (safetyNetTimer) {
    clearTimeout(safetyNetTimer);
    safetyNetTimer = null;
  }
  safetyNetTimer = setTimeout(() => {
    if (isSessionActive) {
      log(`ASR final timeout (${useWhisper ? 50 : 12}s), forcing session reset`);
      isSessionActive = false;
      asrSession = null;
      // 孤儿定时器场景：本会话 recorder 可能仍处于 RECORDING（用户在孤儿 timer
      // 误触发前一直按住按键），必须同步停录音，否则麦克风常驻无消费方（真机 09:07 实锤）。
      if (getIsRecording()) {
        stopRecording();
      }
      updateState("idle");
      startAutoHideTimer();
    }
    safetyNetTimer = null;
  }, useWhisper ? 50000 : 12000);
}

function startVoiceListening(): void {
  log("Starting voice listening mode (auto-send on silence)");
  muteSystemAndPauseMedia();
  voiceWakeMode = true;
  voiceEnding = false;
  isSessionActive = true;
  isMuted = false; // 新一轮语音会话：清掉上一轮的静音待命态
  asrResultConsumed = false;
  clearEarlyCommandTimer();

  // CRITICAL: pause wake word monitor so it doesn't re-trigger
  wakeWordMonitor?.pause();

  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
  if (voiceStartSilenceTimer) {
    clearTimeout(voiceStartSilenceTimer);
    voiceStartSilenceTimer = null;
  }
  if (getIsRecording()) {
    stopRecording();
  }
  if (asrSession) {
    asrSession.stop();
    asrSession = null;
  }

  // 唤醒后连续对话默认走火山 WebSocket ASR（约 0.7s 出结果，远快于本地 whisper-cli
  // 常见 3s+），与快捷键路径保持一致；未配置火山或用户显式 SHORTCUT_USE_WHISPER=true
  // 时回退本地 whisper（离线/隐私优先）。
  voiceUseWhisper = config.whisper.shortcutUseWhisper || !isAsrConfigured();
  log(`startVoiceListening: asr=${voiceUseWhisper ? "local-whisper" : "volcano-websocket"}`);
  asrSession = voiceUseWhisper ? new WhisperAsrSession() : new AsrSession();
  asrSession.on("partial", (text) => {
    if (!voiceWakeMode) return;
    log(`Voice ASR partial: ${text}`);
    sendToFloatWindow(IPC_CHANNELS.ASR_PARTIAL, text);
    
    // Clear initial silence timer since user started speaking
    if (voiceStartSilenceTimer) {
      clearTimeout(voiceStartSilenceTimer);
      voiceStartSilenceTimer = null;
    }

    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
    }
    if (!(asrSession instanceof WhisperAsrSession)) {
      voiceSilenceTimer = setTimeout(() => {
        log("Voice silence timeout, auto-sending");
        endVoiceListening();
      }, VOICE_SILENCE_MS);
    }
  });
  asrSession.on("final", (text) => {
    clearEarlyCommandTimer();
    // endVoiceListening 已置 voiceWakeMode=false 但仍在等火山 final（stop() 触发）：
    // 此场景必须放行，否则「唤醒/静音自动发送」的命令会全部被吞（12s 安全网重置）。
    if (!voiceWakeMode && !voiceEnding) return;
    if (asrResultConsumed) {
      log(`Voice ASR final arrived but already handled early: "${text}"`);
      return;
    }
    log(`Voice ASR final: ${text}`);
    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
      voiceSilenceTimer = null;
    }
    if (safetyNetTimer) {
      clearTimeout(safetyNetTimer);
      safetyNetTimer = null;
    }
    sendToFloatWindow(IPC_CHANNELS.ASR_FINAL, text);
    voiceWakeMode = false;
    voiceEnding = false;
    handleUserInput(text);
  });
  asrSession.on("error", (message) => {
    clearEarlyCommandTimer();
    // endVoiceListening 后火山可能补发「final 后的会话结束」类错误（如 45000081），
    // 不应覆盖已进入处理/思考的状态；仅当仍在期待结果时上报。
    if (!voiceWakeMode && !voiceEnding) return;
    logError("Voice ASR error", message);
    if (voiceSilenceTimer) {
      clearTimeout(voiceSilenceTimer);
      voiceSilenceTimer = null;
    }
    if (voiceStartSilenceTimer) {
      clearTimeout(voiceStartSilenceTimer);
      voiceStartSilenceTimer = null;
    }
    isSessionActive = false;
    voiceWakeMode = false;
    voiceEnding = false;
    wasWokenByVoice = false;
    stopRecording();
    asrSession = null;
    updateState("error", message);
    startAutoHideTimer();
  });

  updateState("listening");
  asrSession.start();
  startRecording();

  // 唤醒/持续对话后等待首句。放宽到 8s（此前 3s 会让 TTS 播完的用户来不及开口就被切断）。
  voiceStartSilenceTimer = setTimeout(() => {
    log("Voice start silence timeout (no speech detected), going to idle");
    playSound("Frog");
    endVoiceListening();
  }, VOICE_START_SILENCE_MS);
}

function endVoiceListening(): void {
  if (!voiceWakeMode) return;
  log("Ending voice listening, sending to ASR");
  voiceWakeMode = false;
  voiceEnding = true; // 保留 final 放行位：stop() 后火山 final 迟到也能进入 handleUserInput
  if (voiceSilenceTimer) {
    clearTimeout(voiceSilenceTimer);
    voiceSilenceTimer = null;
  }
  if (voiceStartSilenceTimer) {
    clearTimeout(voiceStartSilenceTimer);
    voiceStartSilenceTimer = null;
  }
  stopRecording();

  const hasPartial = asrSession?.getLastText()?.trim();
  if (hasPartial) {
    playSound("Frog");
    updateState("processing");
  } else {
    updateState("idle");
    isSessionActive = false;
    wasWokenByVoice = false;
    startAutoHideTimer();
  }

  asrSession?.stop();

  // Fast path for voice mode: try partial text for local commands.
  clearEarlyCommandTimer();
  earlyCommandTimer = setTimeout(async () => {
    if (!isSessionActive || !asrSession || asrResultConsumed) return;
    const partialText = asrSession.getLastText();
    if (partialText) {
      log(`Early local command check from voice partial: "${partialText}"`);
      const handled = await tryHandleLocalCommandEarly(partialText);
      if (handled) {
        voiceEnding = false;
        asrSession?.removeAllListeners();
        asrSession = null;
      }
    }
  }, 500);

  // 火山 WebSocket 约 0.7s 出结果（12s 安全网）；本地 whisper-cli 弱 CPU 首次推理可达数十秒（50s）
  const voiceSafetyNetMs = voiceUseWhisper ? 50000 : 12000;
  if (safetyNetTimer) {
    clearTimeout(safetyNetTimer);
    safetyNetTimer = null;
  }
  safetyNetTimer = setTimeout(() => {
    if (isSessionActive) {
      log(`Voice ASR final timeout (${voiceSafetyNetMs}ms), forcing session reset`);
      isSessionActive = false;
      asrSession = null;
      voiceEnding = false;
      updateState("idle");
      startAutoHideTimer();
    }
    safetyNetTimer = null;
  }, voiceSafetyNetMs);
}

function handleUserInput(text: string): void {
  asrSession = null;
  isSessionActive = false;
  const gen = currentSessionId;
  if (!text.trim()) {
    // 语音连续对话中用户已开口但 ASR 返回空（唤醒词吞命令/管线重建期讲话）：
    // 重听一轮，避免直接 idle「不理人」；重试预算用尽或非语音路径才回落 idle。
    if (wasWokenByVoice && emptyTranscriptRetries < MAX_EMPTY_TRANSCRIPT_RETRIES) {
      emptyTranscriptRetries++;
      log(`Empty transcript (retry ${emptyTranscriptRetries}/${MAX_EMPTY_TRANSCRIPT_RETRIES}), looping back to listen`);
      playSound("Frog");
      startVoiceListening();
      return;
    }
    log("Empty transcript, going idle");
    emptyTranscriptRetries = 0;
    updateState("idle");
    startAutoHideTimer();
    return;
  }
  emptyTranscriptRetries = 0; // 有效输入重置重听预算

  conversationHistoryStore.add("user", text);

  // Try local command router first (zero-latency for simple commands)
  tryLocalCommand(text).then((result) => {
    // 代际守卫：期间已有新会话/新请求递增 sessionId，本条输入已过时，丢弃避免打断新请求
    if (gen !== currentSessionId) {
      log("handleUserInput stale (new session started), discarding local command result");
      return;
    }
    if (result.handled) {
      log(`Local command handled: ${result.action || ""}`);
      playSound("Tink");
      updateState("idle");
      startAutoHideTimer();
      return;
    }
    // Not a local command — proceed to LLM
    let processedText = text;
    if (/剪贴板|剪切板|复制的内容|我复制的/i.test(text)) {
      try {
        const { clipboard } = require("electron");
        const clipText = clipboard.readText().trim();
        if (clipText) {
          processedText = `${text}\n\n【我刚刚复制的内容如下，请根据此内容回答我：】\n${clipText}`;
          log(`Clipboard: injected ${clipText.length} characters into prompt`);
        }
      } catch (err) {
        logError("Clipboard injection failed", err);
      }
    }
    handleLLMRequest(processedText);
  }).catch((error) => {
    logError("Local command error", error);
    // 代际守卫：异常回调期间可能已有新会话启动，丢弃过时输入避免错误重启 LLM
    if (gen !== currentSessionId) {
      log("handleUserInput stale on error (new session started), discarding");
      return;
    }
    handleLLMRequest(text);
  });
}

function handleLLMRequest(text: string): void {
  // 新一轮请求：递增 session 使旧轮次所有异步回调（含 streamTts 在途合成）失效，
  // 避免旧轮内容混入本轮播放
  currentSessionId++;
  const sessionId = currentSessionId;
  const conversation = ensureConversation();
  conversation.addUserMessage(text);

  // 中止上一轮 LLM，防止其继续 emit 事件
  if (llmClient) {
    llmClient.abort();
    llmClient = null;
  }

  updateState("thinking");
  toolAckPending = false;
  ttsPipeline.stop();
  ttsPipeline.clearStopped();

  const streamTts = new StreamTts(sessionId, () => sessionId === currentSessionId);
  let hasSpokenToolAck = false;

  llmClient = new DeepSeekClient(conversation.getMessages());

  llmClient.on("stream", (chunk) => {
    if (sessionId !== currentSessionId) return;
    // 悬浮球 LLM 输出区实时滚动（渲染端负责剥离双通道标签/JSON 外壳）
    sendToFloatWindow(IPC_CHANNELS.LLM_STREAM, chunk);
    streamTts.feed(chunk, ttsPipeline);
  });

  llmClient.on("tool_ack", (ackText: string) => {
    if (sessionId !== currentSessionId) return;
    if (hasSpokenToolAck) {
      log(`Tool ack ignored (already spoken once in this session): ${ackText}`);
      return;
    }
    log(`Tool ack: ${ackText}`);
    toolAckPending = true;
    hasSpokenToolAck = true;
    if (ackText.trim()) {
      const ackClean = cleanTextForTTS(ackText);
      const streamed = streamTts.currentEnqueuedClean;
      const fullySpoken =
        streamed.length > 0 && streamed.startsWith(ackClean);
      if (fullySpoken) {
        // 确认语已通过流式 TTS 实时完整朗读，避免重复播报；
        // 用 finish() 仅清空累计，保留在途句子的入队资格
        log("Tool ack already fully spoken via streaming, skipping re-speak");
        streamTts.finish();
      } else if (streamed.length > 0 && ackClean.startsWith(streamed)) {
        // 流式只读完了确认语前缀，补播剩余部分；重置丢弃在途旧句子防止混入
        const remainder = ackClean.slice(streamed.length);
        log(`Tool ack partially streamed — speaking remainder: ${remainder.length} chars`);
        streamTts.reset();
        stopSpeaking();
        isSpeaking = false;
        updateState("speaking");
        synthesizeRemaining([remainder], sessionId);
      } else {
        // 确认语未经过流式朗读，抢占当前播放/排队中的语音，改用 ack 文案
        log("Tool ack not streamed — preempting to speak ack");
        streamTts.reset();
        stopSpeaking();
        isSpeaking = false;
        updateState("speaking");
        synthesizeRemaining([ackText], sessionId);
      }
    } else {
      streamTts.reset();
    }
  });
 
  llmClient.on("silent_done", () => {
    if (sessionId !== currentSessionId) return;
    log("LLM silent_done: all actions executed silently.");
    isSessionActive = false;
    toolAckPending = false;
    wasWokenByVoice = false; // 静默执行完成，重置语音轮询模式，防止残留触发误回听
    playSound("Tink");
    // Stop any active TTS confirmation/acknowledgment speech first, ensuring isSpeaking is false
    stopSpeaking();
    // 保留多轮上下文：原实现 reset() 会清空全部历史，导致每轮静默命令
    // （开应用/音量/写文件等）之后下一轮对话完全失忆。改回写客户端累计的会话。
    if (llmClient) {
      conversation.setMessages(llmClient.getConversation());
    }
    updateState("idle");
    startAutoHideTimer();
  });

  llmClient.on("done", ({ display: displayText, speech }: DualChannel) => {
    if (sessionId !== currentSessionId) return;
    log(`LLM done, display length: ${displayText.length}`);
    sendToFloatWindow(IPC_CHANNELS.LLM_DONE);
    lastAnswerSpeech = speech || displayText;
    if (llmClient) {
      conversation.setMessages(llmClient.getConversation());
    } else {
      conversation.addAssistantMessage(displayText);
    }
    conversationHistoryStore.add("daisy", displayText);
    toolAckPending = false;
    // 正常完成：清除「上次未完成任务」快照，避免旧任务被误当作未完成
    taskMemory.clear();

    if (!displayText.trim()) {
      ttsPipeline.stop();
      isSessionActive = false;
      updateState("idle");
      startAutoHideTimer();
      return;
    }

    updateState("speaking", undefined, { isFinal: true, text: displayText });

    // 用户已静音（pipeline 被显式 stop），不再播报剩余文本，仅保留展示
    if (ttsPipeline.isStopped) {
      log("TTS muted — skipping remaining speech synthesis");
      ttsPipeline.endSynthesis();
      isSpeaking = false;
      isMuted = true;
      playingTtsSessionId = null;
      if (wasWokenByVoice) {
        if (voiceWakeMode) {
          // orb 点击静音已回环 startVoiceListening，此处避免二次重建 ASR 会话
          // （否则旧会话 stop() 与新会话 start() 竞态，且用户刚开口的 partial 会丢）
          log("Continuous voice dialogue: already listening after mute, skip re-init");
        } else {
          log("Continuous voice dialogue: loop back to listening");
          startVoiceListening();
        }
      } else {
        isSessionActive = false;
        // 保持 muted 待命态：回答已展示，点击 orb 可重听
        updateState("muted");
        startAutoHideTimer();
      }
      return;
    }

    // 流式阶段已按句实时朗读，此处只合成剩余结尾句，避免重复播报
    const tail = streamTts.remainingClean();
    streamTts.finish();
    log(`TTS streaming done, remaining tail: ${tail.length} chars`);

    if (!tail.trim()) {
      // 内容已全部流式播放，仅结束合成状态；播放完毕由流水线触发 allDone
      ttsPipeline.endSynthesis();
      return;
    }

    const chunks = splitForPipeline(tail);
    log(`TTS pipeline: ${chunks.length} chunks, sizes: ${chunks.map(c => c.length).join(", ")}`);

    if (chunks.length === 0) {
      ttsPipeline.endSynthesis();
      return;
    }

    // 等待流式在途句子全部入队后再合成结尾块，维持逐句播放顺序，
    // 防止短结尾块因合成更快而插队到未入队的流式长句之前。
    streamTts.waitForDrain().then(() => {
      if (sessionId !== currentSessionId) return;
      synthesizeRemaining(chunks, sessionId);
    });
  });

  llmClient.on("error", (message) => {
    if (sessionId !== currentSessionId) return;
    logError("LLM error", message);
    sendToFloatWindow(IPC_CHANNELS.LLM_ERROR, message);
    stopSpeaking();
    isSessionActive = false;
    wasWokenByVoice = false; // 对话中断，重置语音轮询模式，避免下次 allDone 误回听
    // 中断时持久化任务上下文：100 步安全阀/异常中止后，新会话据此恢复「没做完的事」
    if (llmClient) {
      const conv = llmClient.getConversation();
      const lastUser = [...conv].reverse().find((m) => m.role === "user")?.content || "";
      taskMemory.save(conv, lastUser);
    }
    updateState("error", message);
    startAutoHideTimer();
  });

  llmClient.sendMessage(text).catch((error) => {
    if (sessionId !== currentSessionId) return;
    logError("LLM sendMessage failed", error);
    isSessionActive = false;
    wasWokenByVoice = false;
    updateState("error", error instanceof Error ? error.message : String(error));
    startAutoHideTimer();
  });
}

function splitForPipeline(text: string): string[] {
  const clean = cleanTextForTTS(text);
  if (!clean) return [];

  // Split into sentences
  const sentences: string[] = [];
  let current = "";
  for (const char of clean) {
    current += char;
    if (/[。！？；\n]/.test(char)) {
      const trimmed = current.trim();
      if (trimmed) sentences.push(trimmed);
      current = "";
    }
  }
  if (current.trim()) sentences.push(current.trim());

  if (sentences.length === 0) return [];

  const chunks: string[] = [];

  // First chunk: first 2 sentences (or 1 if only 1 sentence total)
  if (sentences.length <= 2) {
    // Short response — just one chunk
    chunks.push(sentences.join(""));
    return chunks;
  }

  chunks.push(sentences[0] + sentences[1]);

  // Remaining text
  const remaining = sentences.slice(2).join("");
  if (!remaining) return chunks;

  // Split remaining into ~200 char chunks at sentence boundaries
  const CHUNK_SIZE = 200;
  let pos = 0;
  while (pos < remaining.length) {
    let end = pos + CHUNK_SIZE;
    if (end >= remaining.length) {
      chunks.push(remaining.slice(pos));
      break;
    }
    // Find nearest sentence-ending punctuation after target position
    let cutPos = end;
    for (let i = end; i < Math.min(end + 50, remaining.length); i++) {
      if (/[。！？；，\n]/.test(remaining[i])) {
        cutPos = i + 1;
        break;
      }
    }
    // If no punctuation found, just cut at target position
    chunks.push(remaining.slice(pos, cutPos));
    pos = cutPos;
  }

  // If last two chunks combined < 400 chars, merge them
  if (chunks.length >= 3) {
    const lastTwo = chunks[chunks.length - 2] + chunks[chunks.length - 1];
    if (lastTwo.length < 400) {
      chunks.splice(chunks.length - 2, 2, lastTwo);
    }
  }

  return chunks;
}

/**
 * 逐块合成并交给事件驱动流水线播放。
 * 每完成一块立即 enqueue，流水线在空闲时马上播放，形成边合成边播。
 */
async function synthesizeRemaining(chunks: string[], sessionId: number): Promise<void> {
  ttsPipeline.beginSynthesis();
  ttsPipeline.clearStopped();

  try {
    for (const chunk of chunks) {
      // Check if session was aborted during synthesis
      if (sessionId !== currentSessionId) {
        log("TTS synthesis aborted (session changed)");
        break;
      }
      if (!chunk.trim()) continue;
      const player = new EdgeTTSPlayer();
      ttsPipeline.beginSynthesisJob();
      let filePath: string | null = null;
      try {
        filePath = await player.synthesize(chunk);
      } finally {
        ttsPipeline.endSynthesisJob();
      }
      // Check again after synthesis
      if (sessionId !== currentSessionId) {
        if (filePath) fs.promises.unlink(filePath).catch(() => {});
        log("TTS synthesis result discarded (session changed)");
        break;
      }
      if (filePath) {
        ttsPipeline.enqueue(filePath);
        log(`TTS synthesized and queued: ${filePath} (${chunk.length} chars)`);
      }
    }
  } finally {
    // 会话失效时 pipeline 已由新会话/中止路径 stop()，这里不得再 stop，
    // 否则会误杀新会话已入队的音频
    if (sessionId === currentSessionId) {
      ttsPipeline.endSynthesis();
    }
  }
}

// ── TTS 流水线事件绑定 ──

ttsPipeline.on("play", (filePath: string) => {
  log(`TTS play: ${filePath}`);
  unmuteSystemOnly();
  playingTtsSessionId = currentSessionId;
  isSpeaking = true;
  updateState("speaking");
  sendToFloatWindow(IPC_CHANNELS.TTS_PLAY, filePath);
});

ttsPipeline.on("allDone", () => {
  log("TTS pipeline: all done");
  isSpeaking = false;
  playingTtsSessionId = null;

  // If ack just finished and LLM is still processing, don't hide — wait for done
  if (toolAckPending) {
    log("Ack finished, waiting for LLM final answer");
    updateState("thinking");
    return;
  }
  if (wasWokenByVoice) {
    log("Continuous voice dialogue: loop back to listening");
    startVoiceListening();
  } else {
    isSessionActive = false;
    updateState("idle");
    startAutoHideTimer();
  }
});

function showOrb(): void {
  createFloatWindow();
  showFloatWindow();
  isOrbVisible = true;
}

function hideOrb(): void {
  hideFloatWindow();
  isOrbVisible = false;
  unmuteSystemOnly();
  restoreMediaOnly();
}

function startAutoHideTimer(): void {
  stopAutoHideTimer();
  // Don't start hide timer if TTS is still playing — will be called again when TTS ends
  if (isSpeaking) {
    log("Auto-hide deferred — TTS still playing");
    return;
  }
  autoHideTimer = setTimeout(() => {
    // Double-check: TTS might have started during the timer
    if (isSpeaking) {
      log("Auto-hide deferred again — TTS started during wait");
      return;
    }
    // mini / hidden 是常驻形态：完整胶囊阅读完才 auto-hide，迷你球与已隐藏态不消失
    const floatModeNow = getFloatWindowMode();
    if (floatModeNow === "mini" || floatModeNow === "hidden") {
      log(`Auto-hide skipped — float window in ${floatModeNow} mode (persistent)`);
    } else {
      log("Auto-hiding orb after inactivity");
      hideOrb();
    }
    // 进入闲置立即恢复播放(不等悬浮球消失)
    unmuteSystemOnly();
    restoreMediaOnly();
    // 唤醒词监听已由 syncWakeWordMonitor(idle) 在 updateState 统一恢复，无需在此单独处理
  }, AUTO_HIDE_TIMEOUT_MS);
}

function stopAutoHideTimer(): void {
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}

function muteSystemAndPauseMedia(): Promise<void> {
  return volumeGuard.muteSystemAndPauseMedia();
}

function unmuteSystemOnly(): Promise<void> {
  return volumeGuard.unmuteSystemOnly();
}

function restoreMediaOnly(): Promise<void> {
  return volumeGuard.restoreMediaOnly();
}

function updateState(state: string, message?: string, metadata?: Record<string, any>): void {
  currentState = state;
  const payload = { state, ...(message ? { message } : {}), ...(metadata || {}) };
  log(`State update: ${state} ${message || ""} ${metadata ? JSON.stringify(metadata) : ""}`.trim());
  sendToFloatWindow(IPC_CHANNELS.STATE_UPDATE, JSON.stringify(payload));
  handleFloatAutoMode(state);
  syncWakeWordMonitor(state);
}

// 唤醒词监控生命周期与状态机联动：
// - listening/speaking：麦克风正被会话占用或正放音，暂停唤醒，避免自触发/误触发；
// - processing/thinking（长任务）：保持唤醒活跃，用户可中途插入新需求或随时打断；
// - idle/error：立即恢复，消除「回答完 15 秒内再喊嘿 Daisy 无响应」的死区
//   （原实现仅在 auto-hide 15s 定时器触发后才 resume，长任务期间与回答后短期都无法再唤醒）。
function syncWakeWordMonitor(state: string): void {
  if (!wakeWordMonitor || !config.wakeWord.enabled || isScreenLocked) return;
  if (state === "listening" || state === "speaking") {
    wakeWordMonitor.pause();
    return;
  }
  wakeWordMonitor.resume();
}

// ── 悬浮球智能自动收纳 ──
// 长任务（LLM 工具循环 / 深度思考）期间自动把完整胶囊收缩为迷你球并吸附右上角，
// 避免悬浮窗遮挡正在进行的全自动工作流（用户明令要求）。任务结束（开始播报 /
// 回到 idle）后自动恢复 standard 形态。用户手动切换的形态不受自动逻辑覆盖。
let autoCollapseTimer: NodeJS.Timeout | null = null;
let autoCollapsed = false;

function handleFloatAutoMode(state: string): void {
  if (!config.float.autoCollapse) return;

  const busy = state === "processing" || state === "thinking";
  if (busy) {
    if (!autoCollapseTimer) {
      autoCollapseTimer = setTimeout(() => {
        autoCollapseTimer = null;
        if (!autoCollapsed && getFloatWindowMode() === "standard") {
          autoCollapsed = true;
          log("[floatWindow] Long task detected, auto-collapsing to mini mode.");
          setFloatWindowMode("mini");
        }
      }, 5000);
    }
  } else if (state === "speaking" || state === "idle" || state === "error") {
    if (autoCollapseTimer) { clearTimeout(autoCollapseTimer); autoCollapseTimer = null; }
    if (autoCollapsed) {
      autoCollapsed = false;
      if (config.float.defaultMode !== "mini" && getFloatWindowMode() === "mini") {
        log("[floatWindow] Task done, restoring standard mode.");
        setFloatWindowMode("standard");
      }
    }
  }
}

/** 悬浮球自绘右键菜单动作分发 */
function handleFloatMenuAction(action: string): void {
  switch (action) {
    case "settings": {
      const win = getSettingsWindow();
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } else {
        createSettingsWindow();
      }
      break;
    }
    case "mini":
      setFloatWindowMode("mini");
      break;
    case "standard":
      setFloatWindowMode("standard");
      break;
    case "hide":
      setFloatWindowMode("hidden");
      break;
    case "quit":
      app.quit();
      break;
    default:
      break;
  }
}

function sendToSettingsWindow(channel: string, ...args: unknown[]): void {
  const win = getSettingsWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

// ==================== 对话历史 ====================

const conversationHistoryStore = new ConversationHistory();

function downloadWhisperModel(modelName: string): void {
  const modelInfo = WHISPER_MODELS[modelName];
  if (!modelInfo) {
    sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 0, status: "未知模型" });
    return;
  }

  const modelDir = path.join(os.homedir(), "Models", "whisper");
  const modelPath = path.join(modelDir, modelName);

  if (!fs.existsSync(modelDir)) {
    fs.mkdirSync(modelDir, { recursive: true });
  }

  if (fs.existsSync(modelPath)) {
    const actualBytes = fs.statSync(modelPath).size;
    const expectedBytes = expectedWhisperModelBytes(modelName);
    if (expectedBytes > 0 && actualBytes < expectedBytes * 0.9) {
      // 上次下载中断留下的残缺模型会让 whisper-cli 永久失败，删除后重新下载
      log(`Whisper model exists but truncated (${actualBytes} < ${expectedBytes} bytes), re-downloading`);
      fs.rmSync(modelPath, { force: true });
    } else {
      sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 100, status: "已存在" });
      return;
    }
  }

  sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 0, status: "开始下载..." });
  log(`Downloading whisper model: ${modelName}`);

  // 官方 huggingface.co 在国内常不可达/超时；失败自动切 hf-mirror.com 镜像，
  // 支持断点续传（保留已下载字节）+ 多级重定向 + 30s 连接超时
  let useMirror = false;

  const fail = (err: Error): void => {
    try { if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath); } catch { /* ignore */ }
    sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, {
      percent: 0,
      status: `下载失败: ${err.message}。请用浏览器打开 ${modelInfo.url} 下载后放入 ${modelPath}`,
    });
    logError("Whisper model download failed", err);
  };

  const attempt = (url: string, offset: number, isMirror: boolean): void => {
    if (!isMirror && !useMirror) {
      // 首次尝试官方源；仅在真正失败时才切镜像（镜像判定放在错误回调）
    }
    const file = fs.createWriteStream(modelPath, { flags: offset > 0 ? "a" : "w" });
    let received = offset;
    let done = false;

    const headers: Record<string, string> = {};
    if (offset > 0) headers["Range"] = `bytes=${offset}-`;

    const req = https.get(url, { headers }, (response) => {
      if (
        (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) &&
        response.headers.location
      ) {
        response.resume();
        file.close();
        if (done) return;
        attempt(response.headers.location, offset, isMirror);
        return;
      }
      // 服务器忽略 Range（返回 200）时从头重下
      if (offset > 0 && response.statusCode === 200) {
        response.resume();
        file.close();
        if (done) return;
        fs.rmSync(modelPath, { force: true });
        attempt(url, 0, isMirror);
        return;
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        response.resume();
        file.close();
        if (done) return;
        done = true;
        if (!isMirror) {
          useMirror = true;
          sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 0, status: "官方源失败，切换镜像..." });
          attempt(modelInfo.mirror, 0, true);
        } else {
          fail(new Error(`HTTP ${response.statusCode}`));
        }
        return;
      }

      const totalBytes = parseInt(response.headers["content-length"] || "0", 10) + offset;
      response.pipe(file);
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (totalBytes > 0) {
          const percent = Math.min(99, Math.round((received / totalBytes) * 100));
          sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, {
            percent,
            status: `下载中 ${percent}%${isMirror ? "（镜像源）" : ""}`,
          });
        }
      });
    });

    req.on("error", (err) => {
      file.close();
      if (done) return;
      done = true;
      if (!isMirror) {
        useMirror = true;
        sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 0, status: "官方源失败，切换镜像..." });
        attempt(modelInfo.mirror, 0, true);
      } else {
        fail(err);
      }
    });
    req.setTimeout(30000, () => {
      req.destroy(new Error("连接超时"));
    });

    file.on("error", (err) => {
      if (done) return;
      done = true;
      if (!isMirror) {
        useMirror = true;
        attempt(modelInfo.mirror, 0, true);
      } else {
        fail(err);
      }
    });
    file.on("finish", () => {
      file.close();
      const actualBytes = fs.statSync(modelPath).size;
      const expectedBytes = expectedWhisperModelBytes(modelName);
      if (expectedBytes > 0 && actualBytes < expectedBytes * 0.9) {
        // 下载完成但体积不达标（网络中断/服务端截断），视为失败，删除后让用户重试
        log(`Whisper model download incomplete (${actualBytes} < ${expectedBytes} bytes), discarding`);
        fail(new Error(`模型不完整（${actualBytes} 字节 < ${expectedBytes} 字节）`));
        return;
      }
      config.whisper.model = modelName;
      sendToSettingsWindow(IPC_CHANNELS.WHISPER_DOWNLOAD_PROGRESS, { percent: 100, status: "下载完成" });
      log(`Whisper model downloaded: ${modelPath} (${actualBytes} bytes)`);
      // 模型到位后重启 whisper-server（若已挂载旧模型则换新），首次转写零冷启动
      whisperServer.restart();
    });
  };

  attempt(modelInfo.url, 0, false);
}

function setupIpc(): void {
  ipcMain.on(IPC_CHANNELS.SET_IGNORE_MOUSE, (event, ignore: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(ignore, { forward: true });
    }
  });

  // Windows 悬浮球手动拖动：renderer 上报相对位移，主进程移动无边框窗口。
  // 统一走 handleFloatDrag（节流 + 屏幕内 clamp，防止拖出屏幕丢失）。
  ipcMain.on(IPC_CHANNELS.FLOAT_DRAG, (_event, dx: number, dy: number) => {
    handleFloatDrag(dx, dy);
  });

  // 悬浮球形态切换（renderer 双击/右键菜单触发）
  ipcMain.on(IPC_CHANNELS.FLOAT_SET_MODE, (_event, mode: string) => {
    if (mode === "standard" || mode === "mini" || mode === "hidden") {
      setFloatWindowMode(mode);
    }
  });

  // 悬浮球右键菜单动作
  ipcMain.on(IPC_CHANNELS.FLOAT_MENU_ACTION, (_event, action: string) => {
    handleFloatMenuAction(action);
  });

  // 悬浮球外观：获取当前皮肤/头像配置
  ipcMain.handle(IPC_CHANNELS.FLOAT_APPEARANCE_GET, () => {
    return {
      skin: config.float.skin,
      avatarPath: config.float.avatarPath,
    };
  });

  // 悬浮球外观：更新皮肤/头像配置并实时推送给悬浮球窗口（无需重启）
  ipcMain.handle(IPC_CHANNELS.FLOAT_APPEARANCE_SET, async (_event, appearance: { skin?: string; avatarPath?: string }) => {
    try {
      const validSkins = ["energy", "aurora", "amber", "emerald"];
      if (appearance.skin !== undefined && validSkins.includes(appearance.skin)) {
        config.float.skin = appearance.skin;
      }
      if (appearance.avatarPath !== undefined) {
        // 空串表示清除自定义头像；非空需是存在的本地图片
        if (appearance.avatarPath && !fs.existsSync(appearance.avatarPath)) {
          return { success: false, error: "头像文件不存在：" + appearance.avatarPath };
        }
        config.float.avatarPath = appearance.avatarPath;
      }
      // 持久化到 daisy.env
      const envPath = getWritableEnvPath();
      const existing: Record<string, string> = {};
      if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) existing[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
      if (appearance.skin !== undefined) existing.FLOAT_SKIN = config.float.skin;
      if (appearance.avatarPath !== undefined) existing.FLOAT_AVATAR_PATH = config.float.avatarPath;
      fs.writeFileSync(envPath, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", "utf-8");

      // 实时推送给悬浮球：皮肤即时切换、头像即时叠加/移除
      sendToFloatWindow(IPC_CHANNELS.FLOAT_APPEARANCE_CHANGED, {
        skin: config.float.skin,
        avatarPath: config.float.avatarPath,
      });
      return { success: true, skin: config.float.skin, avatarPath: config.float.avatarPath };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError("FLOAT_APPEARANCE_SET failed", error);
      return { success: false, error: msg };
    }
  });

  // 悬浮球自定义头像：原生文件选择器（图片格式过滤）
  ipcMain.handle(IPC_CHANNELS.FLOAT_AVATAR_CHOOSE, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        title: "选择悬浮球头像图片",
        properties: ["openFile"],
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
        ],
      };
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true, path: "" };
      }
      return { success: true, canceled: false, path: result.filePaths[0] };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError("FLOAT_AVATAR_CHOOSE failed", error);
      return { success: false, canceled: false, path: "", error: msg };
    }
  });

  ipcMain.on(IPC_CHANNELS.TTS_MUTE_CURRENT, () => {
    muteCurrentAnswerSpeech();
  });

  ipcMain.on(IPC_CHANNELS.TTS_REPLAY, () => {
    replayLastAnswer();
  });

  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_event, message: string) => {
    log(`Renderer: ${message}`);
  });

  ipcMain.on(IPC_CHANNELS.START_RECORDING, () => {
    wakeAndStartListening();
  });

  ipcMain.on(IPC_CHANNELS.STOP_RECORDING, () => {
    endListening();
  });

  ipcMain.on(IPC_CHANNELS.SEND_TEXT, (_event, text: string) => {
    // 文本输入路径不需要启动录音：直接中止旧会话并展示悬浮球。
    // 原实现调用 wakeAndStartListening() 启动录音后又被 handleUserInput 置空
    // asrSession，导致录音常驻无消费方，阻塞下一次录音。
    abortAllTasks();
    stopAutoHideTimer();
    showOrb();
    sendToFloatWindow(IPC_CHANNELS.ASR_FINAL, text);
    handleUserInput(text);
  });

  ipcMain.on(IPC_CHANNELS.OPEN_SETTINGS, () => {
    createSettingsWindow();
  });

  ipcMain.on(IPC_CHANNELS.CLOSE_SETTINGS, () => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) {
      win.close();
    }
  });

  ipcMain.on(IPC_CHANNELS.QUIT_APP, () => {
    app.quit();
  });

  ipcMain.on(IPC_CHANNELS.RENDERER_ERROR, (_event, message: string) => {
    logError("Renderer error", message);
  });

  ipcMain.on(IPC_CHANNELS.TTS_PLAY_ENDED, (_event, filePath?: string) => {
    log("TTS playback ended (renderer notification)");

    // If TTS was from an aborted session, ignore this event
    if (playingTtsSessionId !== null && playingTtsSessionId !== currentSessionId) {
      log(`TTS_PLAY_ENDED ignored — stale session ${playingTtsSessionId} (current: ${currentSessionId})`);
      playingTtsSessionId = null;
      ttsPipeline.stop();
      return;
    }
    playingTtsSessionId = null;

    // If no longer speaking (aborted), ignore
    if (!isSpeaking) {
      log("TTS_PLAY_ENDED ignored — not speaking");
      ttsPipeline.stop();
      return;
    }

    // 事件驱动流水线：删除已播文件，若还有排队帧则立即播放，否则等待合成完成
    ttsPipeline.onPlayEnded(filePath);
  });

  ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => {
    return {
      VOLCENGINE_APP_ID: config.asr.appId,
      VOLCENGINE_ACCESS_TOKEN: config.asr.accessToken,
      VOLCENGINE_RESOURCE_ID: config.asr.resourceId,
      DEEPSEEK_API_KEY: config.llm.apiKey,
      DEEPSEEK_BASE_URL: config.llm.baseUrl,
      DEEPSEEK_MODEL: config.llm.model,
      EDGE_TTS_VOICE: config.tts.voice,
      EDGE_TTS_RATE: config.tts.rate,
      GLOBAL_SHORTCUT: config.shortcut.globalShortcut,
      WAKE_WORD_ENABLED: String(config.wakeWord.enabled),
      WAKE_WORD: config.wakeWord.keyword,
      FIRECRAWL_API_KEY: config.firecrawl.apiKey,
      WHISPER_MODEL: config.whisper.model,
      SHORTCUT_USE_WHISPER: String(config.whisper.shortcutUseWhisper),
      AUTO_LAUNCH: String(config.autoLaunch),
      AUDIO_INPUT_DEVICE: getAudioInputDevice(),
      VISUAL_API_KEY: config.vision.apiKey,
      VISUAL_BASE_URL: config.vision.baseUrl,
      VISUAL_MODEL: config.vision.model,
      VISUAL_BACKUP_API_KEY: config.vision.backupApiKey,
      VISUAL_BACKUP_BASE_URL: config.vision.backupBaseUrl,
      VISUAL_BACKUP_MODEL: config.vision.backupModel,
      FLOAT_SKIN: config.float.skin,
      FLOAT_AVATAR_PATH: config.float.avatarPath,
    };
  });

  ipcMain.handle(IPC_CHANNELS.GET_AUDIO_DEVICES, () => {
    return getAudioDevices();
  });

  ipcMain.handle(IPC_CHANNELS.SET_AUDIO_INPUT_DEVICE, (_event, deviceId: string) => {
    setAudioInputDevice(deviceId || "");
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_CONFIG, async (_event, cfg: Record<string, string>) => {
    try {
      const envPath = getWritableEnvPath();

      const managedKeys = new Set([
        "VOLCENGINE_APP_ID", "VOLCENGINE_ACCESS_TOKEN", "VOLCENGINE_RESOURCE_ID",
        "VOLCENGINE_ASR_WS_URL",
        "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL",
        "EDGE_TTS_VOICE", "EDGE_TTS_RATE",
        "GLOBAL_SHORTCUT",
        "WAKE_WORD_ENABLED", "WAKE_WORD",
        "FIRECRAWL_API_KEY",
        "WHISPER_MODEL", "SHORTCUT_USE_WHISPER",
        "AUTO_LAUNCH",
        "AUDIO_INPUT_DEVICE",
        "VISUAL_API_KEY", "VISUAL_BASE_URL", "VISUAL_MODEL",
        "VISUAL_BACKUP_API_KEY", "VISUAL_BACKUP_BASE_URL", "VISUAL_BACKUP_MODEL",
        "FLOAT_SKIN", "FLOAT_AVATAR_PATH",
      ]);

      const existing: Record<string, string> = {};
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).trim();
            const v = trimmed.slice(eqIdx + 1).trim();
            existing[k] = v;
          }
        }
      }

      for (const [key, value] of Object.entries(cfg)) {
        if (managedKeys.has(key)) {
          existing[key] = value || "";
        }
      }

      const lines = Object.entries(existing).map(([k, v]) => `${k}=${v}`);
      fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");

      if (cfg.VOLCENGINE_APP_ID !== undefined) config.asr.appId = cfg.VOLCENGINE_APP_ID;
      if (cfg.VOLCENGINE_ACCESS_TOKEN !== undefined) config.asr.accessToken = cfg.VOLCENGINE_ACCESS_TOKEN;
      if (cfg.VOLCENGINE_RESOURCE_ID !== undefined) config.asr.resourceId = cfg.VOLCENGINE_RESOURCE_ID;
      if (cfg.VOLCENGINE_ASR_WS_URL !== undefined && cfg.VOLCENGINE_ASR_WS_URL.trim()) config.asr.wsUrl = cfg.VOLCENGINE_ASR_WS_URL;
      if (cfg.DEEPSEEK_API_KEY !== undefined) config.llm.apiKey = cfg.DEEPSEEK_API_KEY;
      if (cfg.DEEPSEEK_BASE_URL !== undefined) config.llm.baseUrl = cfg.DEEPSEEK_BASE_URL;
      if (cfg.DEEPSEEK_MODEL !== undefined) config.llm.model = cfg.DEEPSEEK_MODEL;
      if (cfg.EDGE_TTS_VOICE !== undefined) config.tts.voice = cfg.EDGE_TTS_VOICE;
      if (cfg.EDGE_TTS_RATE !== undefined) config.tts.rate = cfg.EDGE_TTS_RATE;
      if (cfg.FIRECRAWL_API_KEY !== undefined) config.firecrawl.apiKey = cfg.FIRECRAWL_API_KEY;
      if (cfg.WHISPER_MODEL !== undefined) config.whisper.model = cfg.WHISPER_MODEL;
      if (cfg.WAKE_WORD !== undefined) config.wakeWord.keyword = cfg.WAKE_WORD;

      const prevWakeEnabled = config.wakeWord.enabled;
      if (cfg.WAKE_WORD_ENABLED !== undefined) {
        config.wakeWord.enabled = cfg.WAKE_WORD_ENABLED === "true";
      }
      if (cfg.SHORTCUT_USE_WHISPER !== undefined) {
        config.whisper.shortcutUseWhisper = cfg.SHORTCUT_USE_WHISPER === "true";
      }
      if (cfg.AUTO_LAUNCH !== undefined) {
        config.autoLaunch = cfg.AUTO_LAUNCH === "true";
        app.setLoginItemSettings({ openAtLogin: config.autoLaunch });
      }
      if (cfg.AUDIO_INPUT_DEVICE !== undefined) {
        setAudioInputDevice(cfg.AUDIO_INPUT_DEVICE);
      }
      if (cfg.VISUAL_API_KEY !== undefined) config.vision.apiKey = cfg.VISUAL_API_KEY;
      if (cfg.VISUAL_BASE_URL !== undefined && cfg.VISUAL_BASE_URL.trim()) config.vision.baseUrl = cfg.VISUAL_BASE_URL;
      if (cfg.VISUAL_MODEL !== undefined && cfg.VISUAL_MODEL.trim()) config.vision.model = cfg.VISUAL_MODEL;
      if (cfg.VISUAL_BACKUP_API_KEY !== undefined) config.vision.backupApiKey = cfg.VISUAL_BACKUP_API_KEY;
      if (cfg.VISUAL_BACKUP_BASE_URL !== undefined && cfg.VISUAL_BACKUP_BASE_URL.trim()) {
        config.vision.backupBaseUrl = cfg.VISUAL_BACKUP_BASE_URL;
      }
      if (cfg.VISUAL_BACKUP_MODEL !== undefined && cfg.VISUAL_BACKUP_MODEL.trim()) {
        config.vision.backupModel = cfg.VISUAL_BACKUP_MODEL;
      }
      if (cfg.GLOBAL_SHORTCUT !== undefined && cfg.GLOBAL_SHORTCUT.trim()) {
        config.shortcut.globalShortcut = cfg.GLOBAL_SHORTCUT;
        globalShortcut?.updateShortcut(cfg.GLOBAL_SHORTCUT);
      }

      if (config.wakeWord.enabled !== prevWakeEnabled) {
        if (config.wakeWord.enabled) {
          setupWakeWord();
        } else {
          // 释放麦克风捕获并停止旧监听器
          setWakeWordCaptureEnabled(false);
          wakeWordMonitor?.stop();
        }
      }

      return true;
    } catch (error) {
      logError("Save config failed", error);
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.WHISPER_STATUS, async (_event, modelName?: string) => {
    const modelPath = getWhisperModelPath(modelName);
    const whisperCli = getBundledBin("whisper-cli");
    let cliInstalled = whisperCli !== "whisper-cli" && fs.existsSync(whisperCli);
    if (!cliInstalled) {
      try {
        if (isWindows()) {
          await execFileAsync("where", ["whisper-cli"], { windowsHide: true });
        } else {
          await execFileAsync("which", ["whisper-cli"]);
        }
        cliInstalled = true;
      } catch { /* not installed */ }
    }
    return {
      cliInstalled,
      modelExists: fs.existsSync(modelPath),
      modelPath,
      modelName: modelName || config.whisper.model,
    };
  });

  ipcMain.on(IPC_CHANNELS.WHISPER_DOWNLOAD, (_event, modelName: string) => {
    downloadWhisperModel(modelName);
  });

  // ── Whisper GPU 组件（可选 CUDA 一键部署）──
  // 高配 N 卡机器一键下载官方 cublas 版并部署到 userData/whisper-gpu/bin，
  // whisperNeedsNoGpu() 检测到 ggml-cuda.dll 后自动放行 GPU。默认 CPU 包不受影响。
  let gpuDownloadInFlight = false;

  // 手动下载看门狗：网络过慢转入手动引导后，每 5s 扫描一次常见目录。
  // 用户用浏览器/下载器（断点续传）下完 zip 后自动继续解压部署，全程无需再点按钮。
  let manualZipTimer: NodeJS.Timeout | null = null;
  const startManualZipWatcher = (): void => {
    if (manualZipTimer) return;
    manualZipTimer = setInterval(async () => {
      const local = findLocalGpuZip();
      if (!local) return;
      if (manualZipTimer) { clearInterval(manualZipTimer); manualZipTimer = null; }
      gpuDownloadInFlight = true;
      try {
        sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, { phase: "extract", percent: 100, received: 0, total: 0, speed: 0, source: "" });
        await whisperServer.dispose();
        await extractWhisperGpuComponent(local);
        fs.promises.unlink(local).catch(() => {});
        log("whisperGpu: manually downloaded component deployed, restart to activate");
        sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, { phase: "manual-done", percent: 100, received: 0, total: 0, speed: 0, source: "" });
      } catch (error) {
        logError("whisperGpu manual deploy failed", error);
        sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, { phase: "manual-done", percent: 0, received: 0, total: 0, speed: 0, source: "" });
      } finally {
        gpuDownloadInFlight = false;
      }
    }, 5000);
    manualZipTimer.unref?.();
  };

  ipcMain.handle(IPC_CHANNELS.WHISPER_GPU_STATUS, async () => {
    const nvidia = isWindows() ? await detectNvidiaGpu() : "none";
    return {
      platform: process.platform,
      nvidia,
      deployed: gpuComponentDownloaded(),
      downloading: gpuDownloadInFlight,
    };
  });

  ipcMain.handle(IPC_CHANNELS.WHISPER_GPU_DOWNLOAD, async () => {
    if (gpuDownloadInFlight) return { success: false, error: "下载进行中" };
    gpuDownloadInFlight = true;
    try {
      // 第一时间通知前端进入下载态，避免"点了没反应"的感知
      sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, { phase: "download", percent: 0, received: 0, total: 0, speed: 0, source: "" });
      // 部署前先释放 whisper-server 对 bin 目录 DLL 的占用（Windows 文件锁）
      await whisperServer.dispose();
      const zipPath = await downloadWhisperGpuComponent((progress) => {
        const pct = progress.total > 0 ? Math.min(99.9, Math.floor((progress.received / progress.total) * 1000) / 10) : 0;
        sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, {
          phase: "download",
          percent: pct,
          received: progress.received,
          total: progress.total,
          speed: progress.speed,
          source: progress.source,
        });
      });
      sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, { phase: "extract", percent: 100, received: 0, total: 0, speed: 0, source: "" });
      await extractWhisperGpuComponent(zipPath);
      fs.promises.unlink(zipPath).catch(() => {});
      log("whisperGpu: GPU component deployed, restart to activate");
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError("whisperGpu deploy failed", error);
      // 解压/部署失败：清理损坏的 zip（tmpdir 下载残留），避免下次「找到本地文件跳过下载→解压失败」死循环
      try {
        const stale = path.join(os.tmpdir(), `daisy-${"whisper-cublas-12.4.0-bin-x64.zip"}`);
        if (fs.existsSync(stale)) { fs.unlinkSync(stale); log(`whisperGpu: cleaned stale partial zip ${stale}`); }
      } catch { /* ignore */ }
      if (error instanceof SlowNetworkError) {
        // 网络过慢：引导用户用浏览器/下载器手动下载 zip（支持断点续传+多线程），
        // 同时后台轮询常见目录，检测到文件后自动继续解压部署，全程无需重启操作。
        sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, {
          phase: "manual",
          percent: 0,
          received: 0,
          total: error.expectedSize,
          speed: 0,
          source: error.url,
          manualUrl: error.url,
          manualFileName: error.fileName,
        });
        startManualZipWatcher();
        return { success: false, error: msg, manual: true, manualUrl: error.url, manualFileName: error.fileName };
      }
      sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, { phase: "download", percent: 0, received: 0, total: 0, speed: 0, source: "" });
      return { success: false, error: msg };
    } finally {
      gpuDownloadInFlight = false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.WHISPER_GPU_REMOVE, async () => {
    try {
      await whisperServer.dispose();
      removeWhisperGpuComponent();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.on(IPC_CHANNELS.SHORTCUT_CAPTURE, () => {
    if (globalShortcut) {
      globalShortcut.startCapture();
    }
  });

  ipcMain.on(IPC_CHANNELS.SHORTCUT_CAPTURE_CANCEL, () => {
    if (globalShortcut) {
      globalShortcut.stopCapture();
    }
    const win = getSettingsWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.SHORTCUT_CAPTURED, { keyName: "", cancelled: true });
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTOLAUNCH_GET, () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle(IPC_CHANNELS.AUTOLAUNCH_SET, (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    config.autoLaunch = enabled;
    log(`Auto launch set to: ${enabled}`);
  });

  ipcMain.handle(IPC_CHANNELS.HISTORY_GET, () => {
    return conversationHistoryStore.get();
  });

  ipcMain.handle(IPC_CHANNELS.HISTORY_CLEAR, () => {
    conversationHistoryStore.clear();
  });

  // ==================== 应用更新 ====================
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  ipcMain.handle(IPC_CHANNELS.APP_VERSION, () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try {
      log("Checking for updates...");
      const result = await autoUpdater.checkForUpdates();
      if (!result || !result.updateInfo) {
        return { updateAvailable: false, currentVersion: app.getVersion() };
      }
      const latest = result.updateInfo.version;
      const current = app.getVersion();
      const updateAvailable = latest !== current;
      log(`Update check: current=${current}, latest=${latest}, available=${updateAvailable}`);
      return { updateAvailable, currentVersion: current, latestVersion: latest, releaseNotes: result.updateInfo.releaseNotes || "" };
    } catch (error: any) {
      logError("Update check failed", error);
      const msg = error?.message || String(error);
      // 未发布 latest.yml 或网络不可达时的友好提示，避免暴露原始技术报错
      const friendly = /latest\.yml|404|publish|GitHub|getLatestVersion/i.test(msg)
        ? "当前版本未配置更新源或更新源不可达，请手动到 GitHub Releases 下载最新版"
        : msg;
      return { updateAvailable: false, currentVersion: app.getVersion(), error: friendly };
    }
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try {
      log("Downloading update...");
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error: any) {
      logError("Update download failed", error);
      return { success: false, error: error?.message || String(error) };
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOAD_PROGRESS, {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    log("Installing update and restarting...");
    autoUpdater.quitAndInstall(false, true);
  });

  // Right-click context menu (triggered from preload via IPC)
  ipcMain.on(IPC_CHANNELS.CONTEXT_MENU_SHOW, (_event, { isInput, selection }: { isInput: boolean; selection: string }) => {
    const win = BrowserWindow.fromWebContents(_event.sender);
    if (!win) return;

    const template: Electron.MenuItemConstructorOptions[] = [];

    if (selection) {
      template.push({ label: "复制", role: "copy" });
    }
    if (isInput) {
      if (selection) template.push({ label: "剪切", role: "cut" });
      template.push({ label: "粘贴", role: "paste" });
      template.push({ label: "全选", role: "selectAll" });
    } else if (selection) {
      template.push({ label: "全选", role: "selectAll" });
    }

    if (template.length > 0) {
      Menu.buildFromTemplate(template).popup({ window: win });
    }
  });
}
