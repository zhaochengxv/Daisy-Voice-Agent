import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, ipcMain, Menu, BrowserWindow, systemPreferences } from "electron";
import { autoUpdater } from "electron-updater";
import { config, isAsrConfigured, isLlmConfigured, getWhisperModelPath, getBundledBin, WHISPER_MODELS, getWritableEnvPath, expectedWhisperModelBytes } from "./config/env";
import { IPC_CHANNELS } from "./ipc/channels";
import { createFloatWindow, getFloatWindow, sendToFloatWindow, showFloatWindow, hideFloatWindow } from "./windows/floatWindow";
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
} from "./asr/whisperGpu";
import { detectNvidiaGpu } from "./control/windows";
import { DeepSeekClient, DualChannel } from "./llm/deepseek";
import { ConversationManager, prefetchDesktopPath } from "./llm/conversation";
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
let playingTtsSessionId: number | null = null;  // session ID when TTS playback started
let toolAckPending = false;
let wakeWordMonitor: WakeWordMonitor | null = null;
let currentSessionId = 0;  // increments on each new session, used to detect stale async callbacks
let isScreenLocked = false;

const volumeGuard = new VolumeGuard();
const ttsPipeline = new TtsPipeline();

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
let wasWokenByVoice = false; // tracks if session was initiated by voice wake-up
let voiceSilenceTimer: NodeJS.Timeout | null = null;
let voiceStartSilenceTimer: NodeJS.Timeout | null = null;
let earlyCommandTimer: NodeJS.Timeout | null = null;
let asrResultConsumed = false;
const VOICE_SILENCE_MS = 3000;

function stopSpeaking(): void {
  ttsPipeline.stop();
  isSpeaking = false;
  playingTtsSessionId = null;

  sendToFloatWindow(IPC_CHANNELS.TTS_END);
}

function muteCurrentAnswerSpeech(): void {
  if (!isSpeaking || toolAckPending) {
    log("TTS mute request ignored — no final answer is currently being spoken");
    return;
  }

  log("TTS muted by orb click; retaining current answer state");

  ttsPipeline.stop();
  isSpeaking = false;
  playingTtsSessionId = null;

  sendToFloatWindow(IPC_CHANNELS.TTS_END);
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
  wasWokenByVoice = false;
  toolAckPending = false;
  asrResultConsumed = false;

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
  const useWhisper = config.whisper.shortcutUseWhisper;
  safetyNetTimer = setTimeout(() => {
    if (isSessionActive) {
      log(`ASR final timeout (${useWhisper ? 50 : 12}s), forcing session reset`);
      isSessionActive = false;
      asrSession = null;
      updateState("idle");
      startAutoHideTimer();
    }
    safetyNetTimer = null;
  }, useWhisper ? 50000 : 12000);
}

function startVoiceListening(): void {
  log("Starting voice listening mode (auto-send on 3s silence)");
  muteSystemAndPauseMedia();
  voiceWakeMode = true;
  isSessionActive = true;
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

  asrSession = new WhisperAsrSession();
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
    if (!voiceWakeMode) return;
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
    handleUserInput(text);
  });
  asrSession.on("error", (message) => {
    clearEarlyCommandTimer();
    if (!voiceWakeMode) return;
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
    wasWokenByVoice = false;
    stopRecording();
    asrSession = null;
    updateState("error", message);
    startAutoHideTimer();
  });

  updateState("listening");
  asrSession.start();
  startRecording();

  // If no speech starts within 3 seconds, end voice listening
  voiceStartSilenceTimer = setTimeout(() => {
    log("Voice start silence timeout (no speech detected), going to idle");
    endVoiceListening();
  }, 3000);
}

function endVoiceListening(): void {
  if (!voiceWakeMode) return;
  log("Ending voice listening, sending to ASR");
  voiceWakeMode = false;
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
        asrSession?.removeAllListeners();
        asrSession = null;
      }
    }
  }, 500);

  // Voice 模式固定用本地 whisper-cli（弱 CPU 首次推理可达数十秒），安全网放宽到 50s
  safetyNetTimer = setTimeout(() => {
    if (isSessionActive) {
      log("Voice ASR final timeout (50s), forcing session reset");
      isSessionActive = false;
      asrSession = null;
      updateState("idle");
      startAutoHideTimer();
    }
    safetyNetTimer = null;
  }, 50000);
}

function handleUserInput(text: string): void {
  asrSession = null;
  isSessionActive = false;
  const gen = currentSessionId;
  if (!text.trim()) {
    log("Empty transcript, going idle");
    updateState("idle");
    startAutoHideTimer();
    return;
  }

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

  llmClient.on("done", ({ display: displayText }: DualChannel) => {
    if (sessionId !== currentSessionId) return;
    log(`LLM done, display length: ${displayText.length}`);
    sendToFloatWindow(IPC_CHANNELS.LLM_DONE);
    if (llmClient) {
      conversation.setMessages(llmClient.getConversation());
    } else {
      conversation.addAssistantMessage(displayText);
    }
    conversationHistoryStore.add("daisy", displayText);
    toolAckPending = false;

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
      playingTtsSessionId = null;
      if (wasWokenByVoice) {
        log("Continuous voice dialogue: loop back to listening");
        startVoiceListening();
      } else {
        isSessionActive = false;
        updateState("idle");
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
    log("Auto-hiding orb after inactivity");
    hideOrb();
  }, AUTO_HIDE_TIMEOUT_MS);
  // 进入闲置立即恢复播放(不等悬浮球消失)
  unmuteSystemOnly();
  restoreMediaOnly();
  // Resume wake word monitoring when going idle
  if (wakeWordMonitor && !isSessionActive && !isSpeaking && !isScreenLocked) {
    wakeWordMonitor.resume();
  }
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
  const payload = { state, ...(message ? { message } : {}), ...(metadata || {}) };
  log(`State update: ${state} ${message || ""} ${metadata ? JSON.stringify(metadata) : ""}`.trim());
  sendToFloatWindow(IPC_CHANNELS.STATE_UPDATE, JSON.stringify(payload));
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

  // Windows 悬浮球手动拖动：renderer 上报相对位移，主进程移动无边框窗口
  ipcMain.on(IPC_CHANNELS.FLOAT_DRAG, (_event, dx: number, dy: number) => {
    const fw = getFloatWindow();
    if (!fw || fw.isDestroyed()) return;
    const [x, y] = fw.getPosition();
    fw.setPosition(x + Math.round(dx), y + Math.round(dy));
  });

  ipcMain.on(IPC_CHANNELS.TTS_MUTE_CURRENT, () => {
    muteCurrentAnswerSpeech();
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
      // 部署前先释放 whisper-server 对 bin 目录 DLL 的占用（Windows 文件锁）
      await whisperServer.dispose();
      const zipPath = await downloadWhisperGpuComponent((percent) => {
        sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, {
          phase: "download",
          percent,
        });
      });
      sendToSettingsWindow(IPC_CHANNELS.WHISPER_GPU_PROGRESS, { phase: "extract", percent: 100 });
      await extractWhisperGpuComponent(zipPath);
      fs.promises.unlink(zipPath).catch(() => {});
      log("whisperGpu: GPU component deployed, restart to activate");
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logError("whisperGpu deploy failed", error);
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
