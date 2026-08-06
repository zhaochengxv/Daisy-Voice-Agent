import { useState, useEffect, useRef } from "react";
import {
  Sparkles,
  Mic,
  Globe,
  Volume2,
  Zap,
  Keyboard,
  Settings,
  RefreshCw,
  Download,
  Check,
  AlertCircle,
  X,
  Power,
  History,
  ExternalLink,
  ScanEye,
  Palette,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { IdleOrb } from "./components/IdleOrb";

// macOS 用隐藏标题栏需顶部留白容纳红绿灯；Windows 原生标题栏已占空间，减少留白
const isMacOSSettings = (window.diriAPI?.platform || "darwin") !== "win32";
const TOP_PADDING_CLASS = isMacOSSettings ? "pt-14" : "pt-3";

interface SettingsState {
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  DEEPSEEK_MODEL: string;
  VOLCENGINE_APP_ID: string;
  VOLCENGINE_ACCESS_TOKEN: string;
  VOLCENGINE_RESOURCE_ID: string;
  SHORTCUT_USE_WHISPER: boolean;
  FIRECRAWL_API_KEY: string;
  EDGE_TTS_VOICE: string;
  EDGE_TTS_RATE: number;
  WAKE_WORD_ENABLED: boolean;
  WHISPER_MODEL: string;
  GLOBAL_SHORTCUT_DISPLAY: string;
  AUTO_LAUNCH: boolean;
  AUDIO_INPUT_DEVICE: string;
  VISUAL_API_KEY: string;
  VISUAL_BASE_URL: string;
  VISUAL_MODEL: string;
  VISUAL_BACKUP_API_KEY: string;
  VISUAL_BACKUP_BASE_URL: string;
  VISUAL_BACKUP_MODEL: string;
  FLOAT_SKIN: string;
  FLOAT_AVATAR_PATH: string;
}

interface ChatEntry {
  sender: "user" | "daisy";
  text: string;
  timestamp: number;
}

const DEFAULT_SETTINGS: SettingsState = {
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  VOLCENGINE_APP_ID: "",
  VOLCENGINE_ACCESS_TOKEN: "",
  VOLCENGINE_RESOURCE_ID: "volc.seedasr.sauc.duration",
  SHORTCUT_USE_WHISPER: false,
  FIRECRAWL_API_KEY: "",
  EDGE_TTS_VOICE: "zh-CN-XiaoxiaoNeural",
  EDGE_TTS_RATE: 20,
  WAKE_WORD_ENABLED: true,
  WHISPER_MODEL: "ggml-base.bin",
  GLOBAL_SHORTCUT_DISPLAY: "RightOption",
  AUTO_LAUNCH: false,
  AUDIO_INPUT_DEVICE: "",
  VISUAL_API_KEY: "",
  VISUAL_BASE_URL: "https://open.bigmodel.cn/api/paas/v4",
  VISUAL_MODEL: "glm-4.6v-flash",
  VISUAL_BACKUP_API_KEY: "",
  VISUAL_BACKUP_BASE_URL: "https://api.siliconflow.cn/v1",
  VISUAL_BACKUP_MODEL: "Qwen/Qwen2.5-VL-7B-Instruct",
  FLOAT_SKIN: "energy",
  FLOAT_AVATAR_PATH: "",
};

function rateToStr(n: number): string {
  return (n >= 0 ? "+" : "") + n + "%";
}
function rateFromStr(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 20 : Math.max(-50, Math.min(50, n));
}
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return (i >= 2 ? v.toFixed(1) : Math.round(v)) + " " + units[i];
}

export default function App() {
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [configLoaded, setConfigLoaded] = useState(false);

  const [activeSection, setActiveSection] = useState<string>("llm");
  const [whisperCliInstalled, setWhisperCliInstalled] = useState<boolean>(false);
  const [whisperModelStatus, setWhisperModelStatus] = useState<
    "not_downloaded" | "downloading" | "downloaded"
  >("not_downloaded");
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [isCapturingShortcut, setIsCapturingShortcut] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    type: "success" | "error" | "info" | "";
  }>({ text: "", type: "" });

  const [isHistoryOpen, setIsHistoryOpen] = useState<boolean>(false);
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [isQuitConfirmOpen, setIsQuitConfirmOpen] = useState<boolean>(false);

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "available" | "downloading" | "ready" | "upToDate" | "error">("idle");
  const [updateMessage, setUpdateMessage] = useState<string>("");
  const [updateDownloadPercent, setUpdateDownloadPercent] = useState<number>(0);

  const [audioDevices, setAudioDevices] = useState<Array<{ deviceId: string; label: string }>>([]);

  const isLLMActive = settings.DEEPSEEK_API_KEY.trim().length > 5;
  const isASRActive =
    settings.VOLCENGINE_APP_ID.trim().length > 0 &&
    settings.VOLCENGINE_ACCESS_TOKEN.trim().length > 0;
  const isWhisperActive = whisperCliInstalled && whisperModelStatus === "downloaded";
  const [whisperGpuStatus, setWhisperGpuStatus] = useState<{
    platform: string;
    nvidia: "driver-ok" | "card-only" | "none";
    deployed: boolean;
    downloading: boolean;
  }>({ platform: "", nvidia: "none", deployed: false, downloading: false });
  const [gpuProgress, setGpuProgress] = useState<number>(0);
  const [gpuReceived, setGpuReceived] = useState<number>(0);
  const [gpuTotal, setGpuTotal] = useState<number>(0);
  const [gpuSpeed, setGpuSpeed] = useState<number>(0);
  const [gpuPhase, setGpuPhase] = useState<"download" | "extract" | "manual" | "manual-done" | "">("");
  const [gpuManualUrl, setGpuManualUrl] = useState<string>("");
  const [gpuManualFileName, setGpuManualFileName] = useState<string>("");
  const isFirecrawlActive = settings.FIRECRAWL_API_KEY.trim().length > 0;

  const statusTimerRef = useRef<number | null>(null);
  const showTemporaryStatus = (text: string, type: "success" | "error" | "info") => {
    setStatusMessage({ text, type });
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = window.setTimeout(() => {
      setStatusMessage({ text: "", type: "" });
    }, 4000);
  };

  // ==================== 加载配置 ====================
  useEffect(() => {
    (async () => {
      try {
        if (!window.diriAPI) {
          showTemporaryStatus("Preload 未加载，请联系开发者", "error");
          return;
        }
        const cfg = await window.diriAPI.getConfig();
        const merged: SettingsState = { ...DEFAULT_SETTINGS };
        if (cfg.DEEPSEEK_API_KEY !== undefined) merged.DEEPSEEK_API_KEY = cfg.DEEPSEEK_API_KEY;
        if (cfg.DEEPSEEK_BASE_URL !== undefined) merged.DEEPSEEK_BASE_URL = cfg.DEEPSEEK_BASE_URL;
        if (cfg.DEEPSEEK_MODEL !== undefined) merged.DEEPSEEK_MODEL = cfg.DEEPSEEK_MODEL;
        if (cfg.VOLCENGINE_APP_ID !== undefined) merged.VOLCENGINE_APP_ID = cfg.VOLCENGINE_APP_ID;
        if (cfg.VOLCENGINE_ACCESS_TOKEN !== undefined) merged.VOLCENGINE_ACCESS_TOKEN = cfg.VOLCENGINE_ACCESS_TOKEN;
        if (cfg.VOLCENGINE_RESOURCE_ID !== undefined) merged.VOLCENGINE_RESOURCE_ID = cfg.VOLCENGINE_RESOURCE_ID;
        if (cfg.SHORTCUT_USE_WHISPER !== undefined) merged.SHORTCUT_USE_WHISPER = cfg.SHORTCUT_USE_WHISPER === "true";
        if (cfg.FIRECRAWL_API_KEY !== undefined) merged.FIRECRAWL_API_KEY = cfg.FIRECRAWL_API_KEY;
        if (cfg.EDGE_TTS_VOICE !== undefined) merged.EDGE_TTS_VOICE = cfg.EDGE_TTS_VOICE;
        if (cfg.EDGE_TTS_RATE !== undefined) merged.EDGE_TTS_RATE = rateFromStr(cfg.EDGE_TTS_RATE);
        if (cfg.WAKE_WORD_ENABLED !== undefined) merged.WAKE_WORD_ENABLED = cfg.WAKE_WORD_ENABLED === "true";
        if (cfg.WHISPER_MODEL !== undefined) merged.WHISPER_MODEL = cfg.WHISPER_MODEL;
        if (cfg.GLOBAL_SHORTCUT !== undefined) merged.GLOBAL_SHORTCUT_DISPLAY = cfg.GLOBAL_SHORTCUT || "RightOption";
        if (cfg.AUTO_LAUNCH !== undefined) merged.AUTO_LAUNCH = cfg.AUTO_LAUNCH === "true";
        if (cfg.AUDIO_INPUT_DEVICE !== undefined) merged.AUDIO_INPUT_DEVICE = cfg.AUDIO_INPUT_DEVICE;
        if (cfg.VISUAL_API_KEY !== undefined) merged.VISUAL_API_KEY = cfg.VISUAL_API_KEY;
        if (cfg.VISUAL_BASE_URL !== undefined) merged.VISUAL_BASE_URL = cfg.VISUAL_BASE_URL;
        if (cfg.VISUAL_MODEL !== undefined) merged.VISUAL_MODEL = cfg.VISUAL_MODEL;
        if (cfg.VISUAL_BACKUP_API_KEY !== undefined) merged.VISUAL_BACKUP_API_KEY = cfg.VISUAL_BACKUP_API_KEY;
        if (cfg.VISUAL_BACKUP_BASE_URL !== undefined) merged.VISUAL_BACKUP_BASE_URL = cfg.VISUAL_BACKUP_BASE_URL;
        if (cfg.VISUAL_BACKUP_MODEL !== undefined) merged.VISUAL_BACKUP_MODEL = cfg.VISUAL_BACKUP_MODEL;
        if (cfg.FLOAT_SKIN !== undefined) merged.FLOAT_SKIN = cfg.FLOAT_SKIN || "energy";
        if (cfg.FLOAT_AVATAR_PATH !== undefined) merged.FLOAT_AVATAR_PATH = cfg.FLOAT_AVATAR_PATH || "";
        try {
          merged.AUTO_LAUNCH = await window.diriAPI.getAutoLaunch();
        } catch {}
        try {
          const devices = await window.diriAPI.getAudioDevices();
          setAudioDevices(devices || []);
        } catch {}
        setSettings(merged);
        setConfigLoaded(true);
        await refreshWhisperStatus();
      } catch (err: any) {
        showTemporaryStatus("加载配置失败：" + (err?.message || err), "error");
      }
    })();
  }, []);

  const refreshWhisperStatus = async (modelName?: string) => {
    try {
      const name = modelName || settings.WHISPER_MODEL;
      const status = await window.diriAPI.getWhisperStatus(name);
      setWhisperCliInstalled(status.cliInstalled);
      setWhisperModelStatus(status.modelExists ? "downloaded" : "not_downloaded");
    } catch {
      setWhisperCliInstalled(false);
      setWhisperModelStatus("not_downloaded");
    }
  };

  // ==================== 应用版本 + 下载进度 ====================
  useEffect(() => {
    (async () => {
      try {
        const v = await window.diriAPI.getAppVersion();
        setCurrentVersion(v);
      } catch { /* ignore */ }
    })();
    const off = window.diriAPI.onUpdateDownloadProgress((p) => {
      setUpdateDownloadPercent(p.percent);
      if (p.percent >= 100) {
        setUpdateStatus("ready");
        showTemporaryStatus("✓ 新版本已下载完成，点击重启安装", "success");
      }
    });
    return () => off();
  }, []);

  const handleInputChange = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // ==================== 快捷键捕获 ====================
  useEffect(() => {
    if (!isCapturingShortcut) return;
    const off = window.diriAPI.onShortcutCaptured((payload) => {
      if (payload.cancelled) {
        setIsCapturingShortcut(false);
        showTemporaryStatus("已取消快捷键设置", "info");
        return;
      }
      if (payload.keyName) {
        handleInputChange("GLOBAL_SHORTCUT_DISPLAY", payload.keyName);
        setIsCapturingShortcut(false);
        showTemporaryStatus(`触发键已设置为：${payload.keyName}（保存后生效）`, "success");
      }
    });
    window.diriAPI.captureShortcut();
    return () => off();
  }, [isCapturingShortcut]);

  // ==================== Whisper 下载进度 ====================
  useEffect(() => {
    const off = window.diriAPI.onWhisperDownloadProgress((p) => {
      setDownloadProgress(p.percent);
      if (p.percent >= 100) {
        if (p.status === "下载完成" || p.status === "已存在") {
          setWhisperModelStatus("downloaded");
          showTemporaryStatus("✓ Whisper 模型下载完成", "success");
        } else if (p.status.startsWith("下载失败")) {
          setWhisperModelStatus("not_downloaded");
          showTemporaryStatus(p.status, "error");
        }
        setTimeout(() => refreshWhisperStatus(), 500);
      }
    });
    return () => off();
  }, []);

  // ==================== Whisper GPU 组件状态 ====================
  const refreshWhisperGpuStatus = async () => {
    try {
      const st = await window.diriAPI.getWhisperGpuStatus();
      setWhisperGpuStatus(st);
    } catch {
      /* 忽略：非 Windows 或 IPC 不可用 */
    }
  };

  useEffect(() => {
    refreshWhisperGpuStatus();
    const off = window.diriAPI.onWhisperGpuProgress((p) => {
      setGpuPhase(p.phase);
      setGpuProgress(p.percent);
      setGpuReceived(p.received || 0);
      setGpuTotal(p.total || 0);
      setGpuSpeed(p.speed || 0);
      if (p.manualUrl) setGpuManualUrl(p.manualUrl);
      if (p.manualFileName) setGpuManualFileName(p.manualFileName);
      if (p.percent >= 100 && p.phase === "extract") {
        showTemporaryStatus("✓ GPU 组件部署完成，重启 Daisy 后生效", "success");
        setTimeout(() => refreshWhisperGpuStatus(), 500);
      }
      if (p.phase === "manual-done" && p.percent >= 100) {
        showTemporaryStatus("✓ 手动下载的 GPU 组件已自动部署，重启 Daisy 后生效", "success");
        setTimeout(() => refreshWhisperGpuStatus(), 500);
      }
    });
    return () => off();
  }, []);

  const handleDeployGpu = async () => {
    setGpuPhase("download");
    setGpuProgress(0);
    setGpuReceived(0);
    setGpuTotal(0);
    setGpuSpeed(0);
    setWhisperGpuStatus((prev) => ({ ...prev, downloading: true }));
    try {
      const res = await window.diriAPI.downloadWhisperGpu();
      if (!res.success) {
        if (res.manual) {
          setGpuPhase("manual");
          if (res.manualUrl) setGpuManualUrl(res.manualUrl);
          if (res.manualFileName) setGpuManualFileName(res.manualFileName);
          return;
        }
        showTemporaryStatus("GPU 组件部署失败：" + (res.error || "未知错误"), "error");
      }
    } catch (err) {
      showTemporaryStatus("GPU 组件部署异常：" + String(err), "error");
    } finally {
      setGpuPhase("");
      setGpuProgress(0);
      setGpuReceived(0);
      setGpuTotal(0);
      setGpuSpeed(0);
      refreshWhisperGpuStatus();
    }
  };

  const handleRemoveGpu = async () => {
    const res = await window.diriAPI.removeWhisperGpu();
    if (res.success) {
      showTemporaryStatus("已移除 GPU 组件，恢复 CPU 版", "success");
    } else {
      showTemporaryStatus("移除失败：" + (res.error || "未知错误"), "error");
    }
    refreshWhisperGpuStatus();
  };

  // ==================== 悬浮球外观 ====================
  const handleSkinChange = async (skin: string) => {
    setSettings((prev) => ({ ...prev, FLOAT_SKIN: skin }));
    try {
      const res = await window.diriAPI.setFloatAppearance({ skin });
      if (res.success) {
        showTemporaryStatus(`已切换为「${res.skin}」皮肤，悬浮球已实时变色`, "success");
      } else {
        showTemporaryStatus("切换皮肤失败：" + (res.error || "未知错误"), "error");
      }
    } catch (err) {
      showTemporaryStatus("切换皮肤异常：" + String(err), "error");
    }
  };

  const handleChooseAvatar = async () => {
    try {
      const res = await window.diriAPI.chooseAvatarFile();
      if (res.success && res.path) {
        setSettings((prev) => ({ ...prev, FLOAT_AVATAR_PATH: res.path }));
        await handleAvatarApply(res.path);
      }
    } catch (err) {
      showTemporaryStatus("选择图片失败：" + String(err), "error");
    }
  };

  const handleAvatarApply = async (path: string) => {
    setSettings((prev) => ({ ...prev, FLOAT_AVATAR_PATH: path }));
    try {
      const res = await window.diriAPI.setFloatAppearance({ avatarPath: path });
      if (res.success) {
        showTemporaryStatus(path ? "✓ 头像已应用到悬浮球" : "已清除自定义头像", "success");
      } else {
        showTemporaryStatus("应用头像失败：" + (res.error || "未知错误"), "error");
      }
    } catch (err) {
      showTemporaryStatus("应用头像异常：" + String(err), "error");
    }
  };

  // ==================== 保存设置 ====================
  const handleSaveSettings = async () => {
    if (!configLoaded) {
      showTemporaryStatus("配置正在加载，请稍候…", "error");
      return;
    }
    const payload: Record<string, string> = {
      DEEPSEEK_API_KEY: settings.DEEPSEEK_API_KEY.trim(),
      DEEPSEEK_BASE_URL: settings.DEEPSEEK_BASE_URL.trim(),
      DEEPSEEK_MODEL: settings.DEEPSEEK_MODEL.trim(),
      VOLCENGINE_APP_ID: settings.VOLCENGINE_APP_ID.trim(),
      VOLCENGINE_ACCESS_TOKEN: settings.VOLCENGINE_ACCESS_TOKEN.trim(),
      VOLCENGINE_RESOURCE_ID: settings.VOLCENGINE_RESOURCE_ID.trim(),
      SHORTCUT_USE_WHISPER: String(settings.SHORTCUT_USE_WHISPER),
      FIRECRAWL_API_KEY: settings.FIRECRAWL_API_KEY.trim(),
      EDGE_TTS_VOICE: settings.EDGE_TTS_VOICE,
      EDGE_TTS_RATE: rateToStr(settings.EDGE_TTS_RATE),
      WAKE_WORD_ENABLED: String(settings.WAKE_WORD_ENABLED),
      WHISPER_MODEL: settings.WHISPER_MODEL,
      GLOBAL_SHORTCUT: settings.GLOBAL_SHORTCUT_DISPLAY,
      AUTO_LAUNCH: String(settings.AUTO_LAUNCH),
      AUDIO_INPUT_DEVICE: settings.AUDIO_INPUT_DEVICE,
      VISUAL_API_KEY: settings.VISUAL_API_KEY.trim(),
      VISUAL_BASE_URL: settings.VISUAL_BASE_URL.trim(),
      VISUAL_MODEL: settings.VISUAL_MODEL.trim(),
      VISUAL_BACKUP_API_KEY: settings.VISUAL_BACKUP_API_KEY.trim(),
      VISUAL_BACKUP_BASE_URL: settings.VISUAL_BACKUP_BASE_URL.trim(),
      VISUAL_BACKUP_MODEL: settings.VISUAL_BACKUP_MODEL.trim(),
    };
    try {
      const ok = await window.diriAPI.updateConfig(payload);
      if (ok) {
        showTemporaryStatus("✓ 保存成功，已同步到 daisy.env", "success");
        await refreshWhisperStatus();
      } else {
        showTemporaryStatus("保存失败：主进程写入 daisy.env 出错", "error");
      }
    } catch (err: any) {
      showTemporaryStatus("保存失败：" + (err?.message || err), "error");
    }
  };

  // ==================== Whisper 操作 ====================
  const handleRefreshWhisper = async () => {
    showTemporaryStatus("正在检查本地 Whisper 状态…", "info");
    await refreshWhisperStatus();
    showTemporaryStatus("✓ Whisper 状态已刷新", "success");
  };

  const handleDownloadModel = () => {
    if (whisperModelStatus === "downloaded" || whisperModelStatus === "downloading") return;
    setWhisperModelStatus("downloading");
    setDownloadProgress(0);
    window.diriAPI.downloadWhisperModel(settings.WHISPER_MODEL);
    showTemporaryStatus(`开始下载 ${settings.WHISPER_MODEL} …`, "info");
  };

  // ==================== 对话历史 ====================
  const loadChatHistory = async () => {
    try {
      const history = await window.diriAPI.getChatHistory();
      setChatHistory(history);
    } catch {
      setChatHistory([]);
    }
  };

  const handleClearHistory = async () => {
    try {
      await window.diriAPI.clearChatHistory();
      setChatHistory([]);
      showTemporaryStatus("对话历史已清空", "info");
    } catch {}
  };

  const handleOpenHistory = () => {
    loadChatHistory();
    setIsHistoryOpen(true);
  };

  // ==================== 退出 ====================
  const handleConfirmQuit = () => {
    setIsQuitConfirmOpen(false);
    window.diriAPI.quitApp();
  };

  // ==================== 检查更新 ====================
  const handleCheckUpdate = async () => {
    if (updateStatus === "checking" || updateStatus === "downloading") return;
    try {
      setUpdateStatus("checking");
      setUpdateMessage("");
      setUpdateDownloadPercent(0);
      const result = await window.diriAPI.checkForUpdate();
      if (result.error) {
        setUpdateStatus("error");
        setUpdateMessage(result.error);
        showTemporaryStatus(`检查更新失败：${result.error}`, "error");
        return;
      }
      if (!result.updateAvailable) {
        setUpdateStatus("upToDate");
        setUpdateMessage(result.currentVersion);
        showTemporaryStatus("✓ 已是最新版本", "success");
        return;
      }
      setUpdateStatus("available");
      setUpdateMessage(`${result.currentVersion} → ${result.latestVersion}`);
      // 检查到更新后，自动开始下载
      try {
        const dl = await window.diriAPI.downloadUpdate();
        if (!dl.success) {
          setUpdateStatus("error");
          setUpdateMessage(dl.error || "下载失败");
          showTemporaryStatus(`下载失败：${dl.error || "未知错误"}`, "error");
          return;
        }
        setUpdateStatus("downloading");
        showTemporaryStatus(`正在下载新版本 ${result.latestVersion}…`, "info");
      } catch (err: any) {
        setUpdateStatus("error");
        setUpdateMessage(err?.message || String(err));
        showTemporaryStatus("下载失败：" + (err?.message || err), "error");
      }
    } catch (err: any) {
      setUpdateStatus("error");
      setUpdateMessage(err?.message || String(err));
      showTemporaryStatus("检查更新失败：" + (err?.message || err), "error");
    }
  };

  const handleInstallUpdate = () => {
    window.diriAPI.installUpdate();
  };

  return (
    <div className="settings-body min-h-screen text-slate-800 p-0 relative selection:bg-sky-100 flex items-center justify-center">
      <div className="bg-ambient-glow">
        <div className="orb orb-1"></div>
        <div className="orb orb-2"></div>
        <div className="orb orb-3"></div>
      </div>

      <div className={`w-full h-screen relative z-10 grid grid-cols-[240px_1fr] gap-6 px-6 pb-6 ${TOP_PADDING_CLASS}`}>
        {/* Sidebar */}
        <aside className="liquid-glass flex flex-col h-full rounded-[28px] overflow-hidden p-5">
          <div className="flex items-center gap-[18px] pb-5 mb-5 border-b border-white/50 relative group">
            <div className="transition-transform duration-500 ease-out group-hover:scale-110 group-hover:-rotate-6">
              <IdleOrb />
            </div>
            <div className="transition-transform duration-500 ease-out group-hover:translate-x-1">
              <h1 className="font-display font-bold text-[21px] tracking-wide text-slate-800">Daisy</h1>
              <p className="text-[11px] font-medium text-slate-400 mt-0.5">智能助理</p>
            </div>
          </div>

          <nav className="flex-1 flex flex-col gap-3.5 overflow-y-auto pr-1 pb-5 glass-scroll">
            {[
              { id: "llm", label: "大语言模型", icon: Sparkles },
              { id: "asr", label: "语音识别", icon: Mic },
              { id: "search", label: "联网搜索", icon: Globe },
              { id: "tts", label: "语音播报", icon: Volume2 },
              { id: "wake", label: "语音唤醒", icon: Zap },
              { id: "vision", label: "视觉理解", icon: ScanEye },
              { id: "shortcut", label: "快捷键", icon: Keyboard },
              { id: "appearance", label: "悬浮球外观", icon: Palette },
              { id: "system", label: "系统配置", icon: Settings },
            ].map((tab) => {
              const IconComp = tab.icon;
              const isActive = activeSection === tab.id;
              return (
                <button key={tab.id} onClick={() => setActiveSection(tab.id)}
                  className={`nav-item-3d ${isActive ? "active" : ""}`}>
                  <IconComp className={`w-4 h-4 ml-1.5 ${isActive ? "text-white" : "text-slate-500"}`} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="pt-4 mt-4 border-t border-white/50 flex flex-col gap-2.5">
            {[
              { label: "大模型连接", active: isLLMActive },
              { label: "云端 ASR", active: isASRActive },
              { label: "本地 Whisper", active: isWhisperActive },
              { label: "网页 Firecrawl", active: isFirecrawlActive },
            ].map((st, i) => (
              <div key={i} className="flex items-center justify-between text-[11px] px-1">
                <span className="text-slate-400 font-medium">{st.label}</span>
                <div className="flex items-center gap-2">
                  <span className="text-slate-500 font-mono text-[10px]">
                    {st.active ? "在线" : "未就绪"}
                  </span>
                  <div className={`glass-indicator-dot ${st.active ? "ok" : "warn"}`}></div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Content */}
        <div className="relative flex flex-col h-full overflow-hidden pb-2">
          <main className="flex-1 overflow-y-auto pb-16 pr-2 glass-scroll">
            <AnimatePresence mode="popLayout">
              <motion.div
                key={activeSection}
                initial={{ opacity: 0, y: 8, scale: 0.995 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.995 }}
                transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                className="flex flex-col gap-5"
              >
                {/* LLM */}
                {activeSection === "llm" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">大语言模型</h2>
                      <p className="text-[12px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                        <span>配置对话大模型（DeepSeek 兼容 OpenAI 格式）</span>
                        <span className="text-slate-300 select-none">•</span>
                        <a
                          href="https://platform.deepseek.com/api_keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>获取</span>
                        </a>
                      </p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">API Key</label>
                        <input type="password" value={settings.DEEPSEEK_API_KEY}
                          onChange={(e) => handleInputChange("DEEPSEEK_API_KEY", e.target.value)}
                          placeholder="sk-..." className="glass-input" autoComplete="off" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">Base URL</label>
                        <input type="text" value={settings.DEEPSEEK_BASE_URL}
                          onChange={(e) => handleInputChange("DEEPSEEK_BASE_URL", e.target.value)}
                          placeholder="https://api.deepseek.com" className="glass-input" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">模型 (Model)</label>
                        <input type="text" value={settings.DEEPSEEK_MODEL}
                          onChange={(e) => handleInputChange("DEEPSEEK_MODEL", e.target.value)}
                          placeholder="deepseek-v4-flash" className="glass-input" />
                      </div>
                    </div>
                  </div>
                )}

                {/* ASR */}
                {activeSection === "asr" && (
                  <div className="flex flex-col gap-5">
                    <div>
                      <div className="mb-5 px-1">
                        <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音识别</h2>
                        <p className="text-[12px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                          <span>火山引擎 / 豆包 Seed ASR，用于将语音转成文字</span>
                          <span className="text-slate-300 select-none">•</span>
                          <a
                            href="https://console.volcengine.com/speech/service/10038"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            <span>获取</span>
                          </a>
                        </p>
                      </div>
                      <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                        <div className="flex flex-col gap-2">
                          <label className="text-[12px] font-semibold text-slate-500 ml-1">App ID</label>
                          <input type="text" value={settings.VOLCENGINE_APP_ID}
                            onChange={(e) => handleInputChange("VOLCENGINE_APP_ID", e.target.value)}
                            placeholder="VOLCENGINE_APP_ID" className="glass-input" />
                        </div>
                        <div className="flex flex-col gap-2">
                          <label className="text-[12px] font-semibold text-slate-500 ml-1">Access Token</label>
                          <input type="password" value={settings.VOLCENGINE_ACCESS_TOKEN}
                            onChange={(e) => handleInputChange("VOLCENGINE_ACCESS_TOKEN", e.target.value)}
                            placeholder="VOLCENGINE_ACCESS_TOKEN" className="glass-input" autoComplete="off" />
                        </div>
                        <div className="flex flex-col gap-2">
                          <label className="text-[12px] font-semibold text-slate-500 ml-1">Resource ID</label>
                          <input type="text" value={settings.VOLCENGINE_RESOURCE_ID}
                            onChange={(e) => handleInputChange("VOLCENGINE_RESOURCE_ID", e.target.value)}
                            placeholder="volc.seedasr.sauc.duration" className="glass-input" />
                        </div>
                        <div className="rounded-[14px] bg-amber-50 border border-amber-200 px-4 py-3 text-[11px] leading-relaxed text-amber-700">
                          <span className="font-semibold">报 403 提示 resource not granted？</span> 说明 resource_id 对应的服务还没在你的账号下开通。请到火山控制台「语音技术 → 语音识别 → 语音识别大模型」开通流式识别，并确认 Resource ID 与开通版本一致：开通 <b>Seed ASR v2</b> 用 <code className="bg-amber-100 px-1 py-0.5 rounded">volc.seedasr.sauc.duration</code>；开通 <b>大模型 1.0</b> 用 <code className="bg-amber-100 px-1 py-0.5 rounded">volc.bigasr.sauc.duration</code>。App ID / Access Token 必须在同一应用下。修改后重启 Daisy 生效。
                        </div>
                      </div>
                      <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-4 mt-4">
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col gap-0.5">
                            <label className="text-[12px] font-semibold text-slate-500 ml-1">录音输入设备</label>
                            <p className="text-[11px] text-slate-400 ml-1">
                              蓝牙耳机说话没反应时，多半是系统默认麦克风不是耳机。在这里选定耳机麦克风（如 {audioDevices.length > 0 && `"${audioDevices[0].label}"`}）并保存。
                            </p>
                          </div>
                          <button onClick={async () => {
                            try {
                              window.diriAPI.refreshAudioDevices();
                              await new Promise((r) => setTimeout(r, 600));
                              const devices = await window.diriAPI.getAudioDevices();
                              setAudioDevices(devices || []);
                              showTemporaryStatus("已刷新录音设备列表", "info");
                            } catch {
                              showTemporaryStatus("刷新设备列表失败", "error");
                            }
                          }} className="text-[11px] px-3 py-1.5 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-600 font-medium transition-all">
                            刷新
                          </button>
                        </div>
                        <select
                          value={settings.AUDIO_INPUT_DEVICE}
                          onChange={(e) => handleInputChange("AUDIO_INPUT_DEVICE", e.target.value)}
                          className="glass-input cursor-pointer"
                        >
                          <option value="">系统默认麦克风</option>
                          {audioDevices.map((d) => (
                            <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                          ))}
                        </select>
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          提示：Windows 蓝牙耳机需在「声音设置 → 输入」中把耳机设为默认麦克风；若耳机只开了立体声（音乐）模式，麦克风不可用，需切换为「耳机/耳麦」模式后刷新列表。
                        </p>
                      </div>
                      <div className="liquid-glass p-5 rounded-[22px] flex flex-col gap-2 mt-4">
                        <h4 className="text-sm font-semibold text-slate-800">参数获取步骤</h4>
                        <ol className="text-[12px] text-slate-500 leading-relaxed list-decimal list-inside flex flex-col gap-1.5">
                          <li>注册并登录 <a href="https://console.volcengine.com" target="_blank" rel="noopener noreferrer" className="text-slate-600 hover:text-slate-800 font-medium hover:underline">火山引擎控制台</a>，完成实名认证（无需充值）</li>
                          <li>在左侧菜单进入「语音技术」→「语音识别大模型 / 录音文件识别」服务（或直接打开上方「获取」链接），点击「开通服务」</li>
                          <li>进入「应用管理」→ 若提示「尚未创建应用，点击现在创建」→ 创建应用</li>
                          <li><b>选择「接入能力」</b>：勾选语音识别相关能力（本项目走 <b>流式语音识别</b> WebSocket，选择「语音识别大模型」或「流式语音识别」即可；语音合成/声音复刻等不需要，可不勾）</li>
                          <li>创建成功后，在应用的「访问令牌」页复制 <b>App ID</b> 与 <b>Access Token</b> 粘贴到上方对应输入框</li>
                          <li><b>Resource ID</b>：开通 <b>Seed ASR v2（语音识别大模型最新版）</b>用 <code className="text-slate-700 bg-slate-100 px-1 py-0.5 rounded">volc.seedasr.sauc.duration</code>；若控制台显示开通的是大模型 <b>1.0</b>，则改为 <code className="text-slate-700 bg-slate-100 px-1 py-0.5 rounded">volc.bigasr.sauc.duration</code>。以控制台开通详情页展示的 Resource ID 为准</li>
                          <li>保存后点击左下角「保存」按钮生效；配置成功后状态栏「云端 ASR」会点亮</li>
                        </ol>
                      </div>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">快捷键模式改用本地 Whisper</h4>
                        <p className="text-[11px] text-slate-400">开启后按快捷键说话不调用云端 ASR，零成本但识别率略低</p>
                      </div>
                      <label className="glass-switch-container">
                        <input type="checkbox" checked={settings.SHORTCUT_USE_WHISPER}
                          onChange={(e) => handleInputChange("SHORTCUT_USE_WHISPER", e.target.checked)} />
                        <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                      </label>
                    </div>
                  </div>
                )}

                {/* Search */}
                {activeSection === "search" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">联网搜索</h2>
                      <p className="text-[12px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                        <span>Firecrawl 提供的网页智能搜索与实时爬取能力</span>
                        <span className="text-slate-300 select-none">•</span>
                        <a
                          href="https://www.firecrawl.dev/app/api-keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>获取</span>
                        </a>
                      </p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">API Key</label>
                        <input type="password" value={settings.FIRECRAWL_API_KEY}
                          onChange={(e) => handleInputChange("FIRECRAWL_API_KEY", e.target.value)}
                          placeholder="fc-..." className="glass-input" autoComplete="off" />
                      </div>
                    </div>
                  </div>
                )}

                {/* TTS */}
                {activeSection === "tts" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音播报</h2>
                      <p className="text-[12px] text-slate-400 mt-1">微软 Edge TTS 免费云端高自然度语音合成</p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-6">
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">播报音色</label>
                        <div className="select-container">
                          <select value={settings.EDGE_TTS_VOICE}
                            onChange={(e) => handleInputChange("EDGE_TTS_VOICE", e.target.value)}
                            className="glass-select">
                            <optgroup label="女声">
                              <option value="zh-CN-XiaoxiaoNeural">晓晓 (默认, 温暖自然)</option>
                              <option value="zh-CN-XiaoyiNeural">晓伊 (活泼灵动)</option>
                            </optgroup>
                            <optgroup label="男声">
                              <option value="zh-CN-YunxiNeural">云希 (极富磁性)</option>
                              <option value="zh-CN-YunyangNeural">云扬 (新闻播报风格)</option>
                              <option value="zh-CN-YunjianNeural">云健 (浑厚有力)</option>
                            </optgroup>
                            <optgroup label="特色方言">
                              <option value="zh-CN-liaoning-XiaobeiNeural">晓贝 (爽朗东北话)</option>
                              <option value="zh-CN-shaanxi-XiaoniNeural">晓妮 (朴实陕西话)</option>
                              <option value="zh-TW-HsiaoChenNeural">曉臻 (嗲雅台湾腔)</option>
                              <option value="zh-HK-HiuMaanNeural">曉曼 (粤语女声)</option>
                            </optgroup>
                          </select>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between ml-1">
                          <label className="text-[12px] font-semibold text-slate-500">语速调整</label>
                          <span className="text-[11px] font-bold font-mono text-sky-600 bg-sky-50/70 border border-sky-200/50 px-2 py-0.5 rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                            {rateToStr(settings.EDGE_TTS_RATE)}
                          </span>
                        </div>
                        <div className="pt-2">
                          <input type="range" min="-50" max="50" step="5"
                            value={settings.EDGE_TTS_RATE}
                            onChange={(e) => handleInputChange("EDGE_TTS_RATE", parseInt(e.target.value, 10))}
                            className="glass-slider" />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Wake */}
                {activeSection === "wake" && (
                  <div className="flex flex-col gap-5">
                    <div>
                      <div className="mb-5 px-1">
                        <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">语音唤醒</h2>
                        <p className="text-[12px] text-slate-400 mt-1">基于本地 Whisper.cpp 的智能唤醒词监听</p>
                      </div>
                      <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between">
                        <div className="flex flex-col gap-1 pr-4">
                          <h4 className="text-sm font-semibold text-slate-800">启用语音唤醒</h4>
                          <p className="text-[11px] text-slate-400">
                            对着麦克风说出 <strong className="font-semibold text-[14px] text-slate-800 bg-slate-100/80 px-1.5 py-0.5 rounded-[4px] mx-1">"Hey, Daisy"</strong> 即可唤醒助理
                          </p>
                        </div>
                        <label className="glass-switch-container">
                          <input type="checkbox" checked={settings.WAKE_WORD_ENABLED}
                            onChange={(e) => handleInputChange("WAKE_WORD_ENABLED", e.target.checked)} />
                          <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                        </label>
                      </div>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-4.5">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-1">
                        <span className="text-[13px] font-semibold text-slate-700">whisper-cli</span>
                        {whisperCliInstalled ? (
                          <span className="text-[12px] font-bold text-emerald-500 flex items-center gap-1">
                            <Check className="w-4 h-4" /> 已安装
                          </span>
                        ) : (
                          <span className="text-[12px] font-semibold text-rose-500 flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5" /> 未安装
                          </span>
                        )}
                      </div>
                      {!whisperCliInstalled && (
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                          唤醒词依赖 whisper-cli。安装包已内置 whisper-cli.exe，若仍显示未安装，请从
                          <a href="https://github.com/ggml-org/whisper.cpp/releases" target="_blank" rel="noopener noreferrer"
                            className="text-slate-600 hover:text-slate-800 font-medium hover:underline"> whisper.cpp Releases </a>
                          下载 <code className="text-slate-600 bg-slate-100 px-1 py-0.5 rounded">whisper-bin-x64.zip</code>，
                          解压出 Release 目录下的 whisper-cli.exe 和全部 ggml-*.dll / whisper.dll，放入安装目录
                          <code className="text-slate-600 bg-slate-100 px-1 py-0.5 rounded">resources\app.asar.unpacked\assets\bin\</code>。
                        </p>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-slate-700">依赖模型</span>
                        <div className="select-container w-44">
                          <select value={settings.WHISPER_MODEL}
                            onChange={(e) => { handleInputChange("WHISPER_MODEL", e.target.value); setTimeout(() => refreshWhisperStatus(e.target.value), 150); }}
                            className="glass-select py-1.5 text-[12px] pr-8">
                            <option value="ggml-tiny.bin">Tiny (39MB, 极速)</option>
                            <option value="ggml-base.bin">Base (142MB, 均衡)</option>
                            <option value="ggml-small.bin">Small (466MB, 精准)</option>
                          </select>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed px-1">
                        低配电脑(≤4 核)推荐 <strong className="text-slate-600 font-semibold">Tiny / Base</strong> 保响应速度；
                        高配电脑可选 <strong className="text-slate-600 font-semibold">Small</strong> 提升唤醒准确率。
                        切换后需重新下载并重启 Daisy 生效。
                      </p>
                      <div className="rounded-[14px] bg-sky-50 border border-sky-200 px-4 py-3 text-[11px] leading-relaxed text-sky-700">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-sky-800">GPU 加速（可选，仅高配 N 卡）</span>
                          {whisperGpuStatus.deployed ? (
                            <span className="text-[11px] font-bold text-emerald-600 flex items-center gap-1">
                              <Check className="w-3.5 h-3.5" /> 已部署
                            </span>
                          ) : (
                            <span className="text-[11px] font-semibold text-slate-400">未部署</span>
                          )}
                        </div>
                        {whisperGpuStatus.nvidia === "driver-ok" && !whisperGpuStatus.deployed && (
                          <p className="mt-1 text-slate-600">
                            检测到 NVIDIA 显卡及驱动。一键下载官方 CUDA 版 whisper（约 670MB）到本机数据目录，
                            重启后自动启用 GPU 加速，低配/无 N 卡机器无需操作。
                          </p>
                        )}
                        {whisperGpuStatus.nvidia === "card-only" && !whisperGpuStatus.deployed && (
                          <p className="mt-1 text-slate-600">
                            检测到 NVIDIA 显卡但 <code className="text-sky-600 bg-sky-100 px-1 py-0.5 rounded">nvidia-smi</code> 不可用，
                            需先安装 NVIDIA 显卡驱动才能启用 GPU 加速。
                          </p>
                        )}
                        {whisperGpuStatus.nvidia === "none" && (
                          <p className="mt-1 text-slate-600">
                            未检测到 NVIDIA 显卡（或当前非 Windows 平台），使用默认 CPU 版 whisper 即可。
                          </p>
                        )}
                        {whisperGpuStatus.deployed && (
                          <p className="mt-1 text-slate-600">
                            GPU 组件已部署到本机数据目录，检测到 <code className="text-sky-600 bg-sky-100 px-1 py-0.5 rounded">ggml-cuda.dll</code> 自动启用 GPU，
                            重启 Daisy 后生效。删除即可随时回退 CPU 版。
                          </p>
                        )}
                        {whisperGpuStatus.downloading || gpuPhase ? (
                          gpuPhase === "manual" ? (
                            <div className="mt-2 rounded-[10px] bg-amber-50 border border-amber-200 px-3 py-2.5">
                              <p className="text-[11px] font-semibold text-amber-700 flex items-center gap-1">
                                <AlertCircle className="w-3.5 h-3.5 shrink-0" /> 网络较慢，自动下载预计需数小时
                              </p>
                              <p className="mt-1 text-[11px] leading-relaxed text-amber-700">
                                建议用浏览器 / 下载器手动下载（支持断点续传，通常快很多），文件名
                                <code className="mx-1 px-1 py-0.5 rounded bg-amber-100 text-[10px]">{gpuManualFileName || "whisper-cublas-*.zip"}</code>
                                保存到<strong>下载</strong>或<strong>桌面</strong>文件夹。完成后 Daisy 会自动检测并部署，无需再操作。
                              </p>
                              {gpuManualUrl && (
                                <a
                                  href={gpuManualUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-semibold transition-colors"
                                >
                                  <Download className="w-3.5 h-3.5" /> 打开下载页面
                                </a>
                              )}
                              <p className="mt-2 text-[11px] text-amber-600">正在后台监控下载文件夹，检测到文件将自动部署…</p>
                            </div>
                          ) : gpuPhase === "manual-done" ? (
                            <div className="mt-2 rounded-[10px] bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-[11px] font-semibold text-emerald-700">
                              {gpuProgress >= 100 ? "✓ GPU 组件已自动部署，重启 Daisy 后生效" : "未检测到手动下载的文件，请确认已下载到 下载/桌面 文件夹"}
                            </div>
                          ) : (
                            <div className="mt-2 flex items-center gap-2">
                              <div className="flex-1 h-1.5 rounded-full bg-sky-100 overflow-hidden">
                                <div className="h-full bg-sky-500 transition-all" style={{ width: `${gpuProgress}%` }} />
                              </div>
                              <span className="text-[11px] text-sky-600 whitespace-nowrap">
                                {gpuPhase === "extract"
                                  ? "解压中"
                                  : gpuTotal > 0
                                    ? `下载中 ${gpuProgress}% · ${formatBytes(gpuReceived)}/${formatBytes(gpuTotal)}${gpuSpeed > 0 ? ` · ${formatBytes(gpuSpeed)}/s` : ""}`
                                    : "正在连接下载源…"}
                              </span>
                            </div>
                          )
                        ) : whisperGpuStatus.nvidia === "driver-ok" && !whisperGpuStatus.deployed ? (
                          <button
                            onClick={handleDeployGpu}
                            className="mt-2 px-3 py-1.5 rounded-[10px] bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-semibold transition-colors"
                          >
                            一键部署 GPU 组件
                          </button>
                        ) : whisperGpuStatus.deployed ? (
                          <button
                            onClick={handleRemoveGpu}
                            className="mt-2 px-3 py-1.5 rounded-[10px] bg-white border border-slate-200 hover:border-rose-300 hover:text-rose-500 text-slate-500 text-[11px] font-semibold transition-colors"
                          >
                            移除 GPU 组件（回退 CPU 版）
                          </button>
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-semibold text-slate-700">模型状态</span>
                        {whisperModelStatus === "downloaded" ? (
                          <span className="text-[12px] font-bold text-emerald-500">✓ 已就绪 (本地缓存)</span>
                        ) : whisperModelStatus === "downloading" ? (
                          <span className="text-[12px] font-bold text-sky-500 animate-pulse">↓ 正在下载 ({downloadProgress}%)</span>
                        ) : (
                          <span className="text-[12px] font-semibold text-rose-500 flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5" /> ✗ 未下载 (需安装)
                          </span>
                        )}
                      </div>
                      {whisperModelStatus === "downloading" && (
                        <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden shadow-inner border border-white">
                          <div className="bg-gradient-to-r from-emerald-400 to-teal-400 h-full rounded-full transition-all duration-200"
                            style={{ width: `${downloadProgress}%` }} />
                        </div>
                      )}
                      <div className="flex gap-3 pt-2">
                        <button onClick={handleRefreshWhisper}
                          className="flex-1 py-2.5 rounded-full btn-glass-clear cursor-pointer text-[12px] flex items-center justify-center gap-1.5">
                          <RefreshCw className="w-3.5 h-3.5" /><span>刷新状态</span>
                        </button>
                        <button onClick={handleDownloadModel}
                          disabled={whisperModelStatus === "downloaded" || whisperModelStatus === "downloading"}
                          className={`flex-1 py-2.5 rounded-full cursor-pointer text-[12px] flex items-center justify-center gap-1.5 ${
                            whisperModelStatus === "downloaded"
                              ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
                              : "btn-glass-blue text-white"}`}>
                          <Download className="w-3.5 h-3.5" />
                          <span>{whisperModelStatus === "downloaded" ? "模型已下载" : "下载模型"}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Vision */}
                {activeSection === "vision" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">视觉理解</h2>
                      <p className="text-[12px] text-slate-400 mt-1 flex items-center gap-1.5 flex-wrap">
                        <span>让 Daisy 看懂本地图片与视频：问「这张图里有什么」即可识别画面内容（analyze_image / analyze_video 工具）</span>
                        <a
                          href="https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-slate-400 hover:text-slate-600 transition-all active:scale-95 cursor-pointer font-medium hover:underline"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>GLM-4.6V-Flash 官方文档</span>
                        </a>
                      </p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">API Key（智谱 API Key，官网 bigmodel.cn 创建）</label>
                        <input type="password" value={settings.VISUAL_API_KEY}
                          onChange={(e) => handleInputChange("VISUAL_API_KEY", e.target.value)}
                          placeholder="智谱 API Key，GLM-4.6V-Flash 完全免费" className="glass-input" autoComplete="off" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">接口地址</label>
                        <input value={settings.VISUAL_BASE_URL}
                          onChange={(e) => handleInputChange("VISUAL_BASE_URL", e.target.value)}
                          placeholder="https://open.bigmodel.cn/api/paas/v4" className="glass-input" autoComplete="off" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">模型名称</label>
                        <input value={settings.VISUAL_MODEL}
                          onChange={(e) => handleInputChange("VISUAL_MODEL", e.target.value)}
                          placeholder="glm-4.6v-flash" className="glass-input" autoComplete="off" />
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        默认智谱 GLM-4.6V-Flash（官方免费，视觉推理 + 128K 上下文，效果超过 Qwen3-VL-8B）。
                        也可换豆包：接口地址填 <code className="text-slate-500">https://ark.cn-beijing.volces.com/api/v3</code>、模型填 <code className="text-slate-500">doubao-seed-2-1-turbo-260628</code>、API Key 用火山方舟密钥（约 3 元/百万输入 token，识图一次约 1 分钱。注意旧版 doubao-seed-1-6-vision 已下线不可用）。
                        视频分析会抽取 3~5 个关键帧后一并识别。
                      </p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5 mt-5">
                      <div>
                        <h3 className="font-display font-semibold text-[15px] tracking-tight text-slate-800">备用视觉模型（可选，推荐）</h3>
                        <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                          免费模型高峰期限流（智谱返回「拥挤/繁忙」，官方错误码 1302/1305）时，Daisy 会自动重试并降级到备用供应商，保证看图不断档。
                          推荐硅基流动（cloud.siliconflow.cn，注册送额度，无需实名即可用）：填入硅基流动 API Key 即可，接口地址与模型已默认填好。
                        </p>
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">备用 API Key（硅基流动，cloud.siliconflow.cn 创建）</label>
                        <input type="password" value={settings.VISUAL_BACKUP_API_KEY}
                          onChange={(e) => handleInputChange("VISUAL_BACKUP_API_KEY", e.target.value)}
                          placeholder="sk-...（硅基流动 API Key）" className="glass-input" autoComplete="off" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">备用接口地址</label>
                        <input value={settings.VISUAL_BACKUP_BASE_URL}
                          onChange={(e) => handleInputChange("VISUAL_BACKUP_BASE_URL", e.target.value)}
                          placeholder="https://api.siliconflow.cn/v1" className="glass-input" autoComplete="off" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">备用模型名称</label>
                        <input value={settings.VISUAL_BACKUP_MODEL}
                          onChange={(e) => handleInputChange("VISUAL_BACKUP_MODEL", e.target.value)}
                          placeholder="Qwen/Qwen2.5-VL-7B-Instruct" className="glass-input" autoComplete="off" />
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        硅基流动备选模型：<code className="text-slate-500">Qwen/Qwen3-VL-8B-Instruct</code>（新一代，效果更佳）或 <code className="text-slate-500">Qwen/Qwen2.5-VL-7B-Instruct</code>。
                        也可填其他任意 OpenAI 兼容视觉模型。
                      </p>
                    </div>
                  </div>
                )}

                {/* Shortcut */}
                {activeSection === "shortcut" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">快捷键</h2>
                      <p className="text-[12px] text-slate-400 mt-1">全局呼唤设置：按住说话、松手发送。点击右侧按钮后按下任意按键设置</p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                      <div className="flex flex-col gap-2">
                        <label className="text-[12px] font-semibold text-slate-500 ml-1">唤醒触发键</label>
                        <div className="flex gap-4 items-center">
                          <div className={`flex-1 font-mono font-semibold px-4 py-3.5 rounded-2xl border text-center transition-all ${
                            isCapturingShortcut ? "bg-sky-50 text-sky-500 border-sky-300 animate-pulse" : "glass-input"}`}>
                            {isCapturingShortcut ? "请在键盘上按下目标键..." : settings.GLOBAL_SHORTCUT_DISPLAY}
                          </div>
                          <button onClick={() => setIsCapturingShortcut(true)} disabled={isCapturingShortcut}
                            className="btn-glass-blue px-6 py-3.5 rounded-2xl cursor-pointer font-medium text-[13px]">
                            <span>{isCapturingShortcut ? "监听中..." : "设置快捷键"}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* System */}
                {activeSection === "system" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">系统</h2>
                      <p className="text-[12px] text-slate-400 mt-1">开机自启、版本与更新检查</p>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">开机自启</h4>
                        <p className="text-[11px] text-slate-400">在您的计算机启动或登录系统时，自动激活并后台运行 Daisy</p>
                      </div>
                      <label className="glass-switch-container">
                        <input type="checkbox" checked={settings.AUTO_LAUNCH}
                          onChange={(e) => handleInputChange("AUTO_LAUNCH", e.target.checked)} />
                        <div className="glass-switch-track"><div className="glass-switch-thumb"></div></div>
                      </label>
                    </div>
                    <div className="liquid-glass p-5 rounded-[22px] flex items-center justify-between mt-5">
                      <div className="flex flex-col gap-1 pr-4">
                        <h4 className="text-sm font-semibold text-slate-800">当前版本</h4>
                        <p className="text-[11px] text-slate-400">
                          {currentVersion ? `v${currentVersion}` : "读取中…"}
                          {updateStatus === "upToDate" && updateMessage && (
                            <span className="ml-2 text-emerald-500">✓ 已是最新</span>
                          )}
                          {updateStatus === "available" && updateMessage && (
                            <span className="ml-2 text-amber-500">→ {updateMessage.split("→ ")[1]}</span>
                          )}
                          {(updateStatus === "checking" || updateStatus === "downloading") && (
                            <span className="ml-2 text-sky-500">
                              {updateStatus === "checking" ? "正在检查…" : `下载中 ${updateDownloadPercent}%`}
                            </span>
                          )}
                          {updateStatus === "ready" && (
                            <span className="ml-2 text-emerald-500">✓ 新版本已就绪</span>
                          )}
                          {updateStatus === "error" && (
                            <span className="ml-2 text-rose-500">{updateMessage || "出错"}</span>
                          )}
                        </p>
                        {updateStatus === "downloading" && (
                          <div className="w-full max-w-[260px] bg-slate-100 rounded-full h-2 overflow-hidden shadow-inner border border-white mt-2">
                            <div className="bg-gradient-to-r from-emerald-400 to-teal-400 h-full rounded-full transition-all duration-200"
                              style={{ width: `${updateDownloadPercent}%` }} />
                          </div>
                        )}
                      </div>
                      {(updateStatus === "ready") ? (
                        <button onClick={handleInstallUpdate}
                          className="btn-glass-blue px-6 py-3 rounded-full cursor-pointer text-[13px] font-medium">
                          <span>重启并安装</span>
                        </button>
                      ) : (
                        <button onClick={handleCheckUpdate}
                          disabled={updateStatus === "checking" || updateStatus === "downloading"}
                          className={`px-6 py-3 rounded-full text-[13px] font-medium ${
                            updateStatus === "checking" || updateStatus === "downloading"
                              ? "bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed"
                              : "btn-glass-red text-white cursor-pointer"
                          }`}>
                          <span>
                            {updateStatus === "checking" ? "检查中…" :
                             updateStatus === "downloading" ? `下载中 ${updateDownloadPercent}%` :
                             updateStatus === "upToDate" ? "再次检查" :
                             updateStatus === "error" ? "重试" :
                             updateStatus === "available" ? "下载中…" : "检查更新"}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* 悬浮球外观：皮肤预设 + 自定义头像 */}
                {activeSection === "appearance" && (
                  <div>
                    <div className="mb-5 px-1">
                      <h2 className="font-display font-semibold text-2xl tracking-tight text-slate-800">悬浮球外观</h2>
                      <p className="text-[12px] text-slate-400 mt-1">选择视觉主题皮肤，或叠加一张自定义头像（如 3D 动感角色头像）</p>
                    </div>
                    <div className="liquid-glass p-6 rounded-[24px] flex flex-col gap-5">
                      <div className="flex flex-col gap-2">
                        <h4 className="text-sm font-semibold text-slate-800">主题皮肤</h4>
                        <p className="text-[11px] text-slate-400">切换后悬浮球立即变色，无需重启</p>
                        <div className="grid grid-cols-2 gap-3 mt-2">
                          {[
                            { id: "energy", name: "能量青", desc: "默认 · 青蓝能量", swatches: ["#00F0FF", "#0088FF", "#FBBF24", "#8B5CF6"] },
                            { id: "aurora", name: "极光紫", desc: "紫罗兰霓虹", swatches: ["#8B5CF6", "#A78BFA", "#38BDF8", "#C084FC"] },
                            { id: "amber", name: "暖阳琥珀", desc: "金黄活力", swatches: ["#F59E0B", "#FBBF24", "#F97316", "#F56060"] },
                            { id: "emerald", name: "翡翠深绿", desc: "沉稳科技", swatches: ["#10B981", "#34D399", "#2DD4BF", "#F56060"] },
                          ].map((skin) => (
                            <button
                              key={skin.id}
                              onClick={() => handleSkinChange(skin.id)}
                              className={`rounded-[16px] border p-3.5 text-left transition-all ${
                                settings.FLOAT_SKIN === skin.id
                                  ? "border-sky-400 bg-sky-50 shadow-sm ring-1 ring-sky-200"
                                  : "border-slate-200 bg-white hover:border-slate-300"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-[13px] font-semibold text-slate-800">{skin.name}</span>
                                {settings.FLOAT_SKIN === skin.id && (
                                  <span className="w-4 h-4 rounded-full bg-sky-500 flex items-center justify-center">
                                    <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />
                                  </span>
                                )}
                              </div>
                              <div className="flex gap-1.5 mt-2">
                                {skin.swatches.map((c) => (
                                  <span key={c} className="w-4 h-4 rounded-full border border-white shadow-sm" style={{ background: c }} />
                                ))}
                              </div>
                              <p className="text-[10px] text-slate-400 mt-1.5">{skin.desc}</p>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="h-px bg-slate-200" />

                      <div className="flex flex-col gap-2">
                        <h4 className="text-sm font-semibold text-slate-800">自定义头像</h4>
                        <p className="text-[11px] text-slate-400">
                          上传一张本地图片叠加到悬浮球表面（建议正方形透明 PNG，自动裁圆并融入球体）。
                          例如使用「潇洒哥」等 3D 动感角色头像，打造专属悬浮球。
                        </p>
                        <div className="flex items-center gap-3 mt-1">
                          <input
                            type="text"
                            value={settings.FLOAT_AVATAR_PATH}
                            onChange={(e) => handleInputChange("FLOAT_AVATAR_PATH", e.target.value)}
                            placeholder="本地图片路径，如 C:\Users\you\avatar.png 或留空清除"
                            className="flex-1 min-w-0 rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-[12px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-300"
                          />
                          <button
                            onClick={handleChooseAvatar}
                            className="px-4 py-2 rounded-[10px] bg-slate-800 hover:bg-slate-900 text-white text-[12px] font-medium transition-colors shrink-0"
                          >
                            选择图片…
                          </button>
                          {settings.FLOAT_AVATAR_PATH && (
                            <button
                              onClick={() => handleAvatarApply("")}
                              className="px-4 py-2 rounded-[10px] bg-white border border-slate-200 hover:border-rose-300 hover:text-rose-500 text-slate-500 text-[12px] font-medium transition-colors shrink-0"
                            >
                              清除
                            </button>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-2">
                          <button
                            onClick={() => handleAvatarApply(settings.FLOAT_AVATAR_PATH)}
                            className="px-4 py-2 rounded-[10px] bg-sky-600 hover:bg-sky-700 text-white text-[12px] font-semibold transition-colors"
                          >
                            应用头像
                          </button>
                          <span className="text-[11px] text-slate-400">保存后悬浮球立即叠加该头像</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </main>

          {/* Footer */}
          <footer className="h-[72px] liquid-glass rounded-[22px] px-5 flex items-center justify-between gap-4 mr-2 shrink-0 mt-4">
            <div className="flex-1 min-w-0 pr-4">
              <AnimatePresence mode="wait">
                {statusMessage.text && (
                  <motion.div key={statusMessage.text}
                    initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}
                    className={`text-[12px] font-medium flex items-center gap-1.5 truncate ${
                      statusMessage.type === "success" ? "text-emerald-500"
                      : statusMessage.type === "error" ? "text-rose-500" : "text-sky-500"}`}>
                    <span className="w-2 h-2 rounded-full bg-current animate-ping" />
                    <span>{statusMessage.text}</span>
                  </motion.div>
                )}
              </AnimatePresence>
              {!statusMessage.text && (
                <span className="text-[11px] text-slate-400 font-medium">
                  {configLoaded ? "配置项与 Daisy 后台服务保持动态同步中" : "正在加载 daisy.env 配置…"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button onClick={handleOpenHistory}
                className="px-5 py-3 rounded-full btn-glass-green cursor-pointer text-[13px] flex items-center gap-1.5">
                <History className="w-4 h-4 text-emerald-600 animate-pulse" />
                <span>对话历史</span>
              </button>
              <button onClick={handleSaveSettings} disabled={!configLoaded}
                className="px-6 py-3 rounded-full btn-glass-blue cursor-pointer text-[13px]">
                <span>保存设置</span>
              </button>
            </div>
          </footer>
        </div>
      </div>

      {/* 对话历史弹窗 */}
      <AnimatePresence>
        {isHistoryOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="absolute inset-0 bg-slate-900/20 backdrop-blur-md z-40 flex items-center justify-center p-8"
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 15 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 15 }}
              transition={{ type: "spring", stiffness: 350, damping: 28, mass: 0.8 }}
              className="w-[480px] max-h-[560px] liquid-glass p-6 rounded-[30px] flex flex-col shadow-[0_20px_50px_rgba(30,40,60,0.15)]">
              <div className="flex items-center justify-between pb-4 border-b border-slate-100 mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-sky-400 to-emerald-400 flex items-center justify-center shadow-md">
                    <History className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-slate-800">Daisy · 对话历史</h3>
                    <p className="text-[10px] text-slate-400 font-medium">最近 10 次交互记录</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {chatHistory.length > 0 && (
                    <button onClick={handleClearHistory}
                      className="text-[11px] text-slate-400 hover:text-rose-500 hover:bg-slate-100/50 px-2 py-1 rounded-lg transition-all font-medium cursor-pointer mr-1">
                      清空历史
                    </button>
                  )}
                  <button onClick={() => setIsHistoryOpen(false)}
                    className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200/80 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors cursor-pointer">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto mb-4 space-y-3.5 pr-1 glass-scroll min-h-[200px] max-h-[400px]">
                {chatHistory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center text-slate-400 py-12">
                    <History className="w-8 h-8 mb-3 opacity-30" />
                    <p className="text-[13px] font-medium">暂无对话历史</p>
                    <p className="text-[11px] mt-1">通过快捷键或唤醒词与 Daisy 对话后，记录会显示在这里</p>
                  </div>
                ) : (
                  chatHistory.map((chat, idx) => (
                    <div key={idx} className={`flex flex-col ${chat.sender === "user" ? "items-end" : "items-start"}`}>
                      <div className={`px-4 py-2.5 rounded-2xl text-[12px] leading-relaxed max-w-[85%] whitespace-pre-wrap ${
                        chat.sender === "user"
                          ? "bg-sky-500 text-white rounded-tr-none shadow-[0_4px_12px_rgba(14,165,233,0.18)] font-medium"
                          : "bg-white/75 backdrop-blur-md text-slate-800 rounded-tl-none border border-white/60 shadow-[0_4px_10px_rgba(15,23,42,0.03)]"}`}>
                        {chat.text}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 退出确认 */}
      <AnimatePresence>
        {isQuitConfirmOpen && (
          <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-md z-40 flex items-center justify-center p-8">
            <motion.div initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
              className="w-[360px] liquid-glass p-6 rounded-[28px] text-center">
              <div className="w-12 h-12 rounded-full bg-rose-50 border border-rose-100 mx-auto flex items-center justify-center mb-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]">
                <Power className="w-6 h-6 text-rose-500" />
              </div>
              <h3 className="font-semibold text-slate-800 text-base mb-2">退出 Daisy 助手</h3>
              <p className="text-[12px] text-slate-400 mb-5 leading-relaxed">退出后，语音监听及快捷键唤醒服务将会完全中断。确定要退出吗？</p>
              <div className="flex gap-3">
                <button onClick={() => setIsQuitConfirmOpen(false)}
                  className="flex-1 py-2.5 rounded-full btn-glass-clear cursor-pointer text-[12px]"><span>取消</span></button>
                <button onClick={handleConfirmQuit}
                  className="flex-1 py-2.5 rounded-full btn-glass-red cursor-pointer text-[12px]"><span>确认退出</span></button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
