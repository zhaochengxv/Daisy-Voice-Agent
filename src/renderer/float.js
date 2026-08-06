/* global diriAPI */

// ── 状态色板（设计文档 v3：明亮能量系，替代旧版暗沉霓虹）──
// 设计文档状态色体系：idle 能量青、thinking 星云紫、listening 琥珀金、
// speaking 青渐变、error 警示红、sleep/静音 深灰。每个状态带三点布光色：
// keyLight 主光（左上暖） / fillLight 辅光（右下冷） / rimLight 轮廓光（后侧）。
const palettes = {
  idle: {
    main: "#00F0FF",
    mid: "#0088FF",
    dark: "#0b1f3a",
    deepDark: "#050d1c",
    highlight: "#D6FBFF",
    glow: "rgba(0, 240, 255, 0.5)",
    label: "待命",
    glowOpacity: 0.3,
    filaments: ["#00F0FF", "#00B3FF", "#7DE8FF"],
    blobs: ["#00F0FF", "#0088FF", "#38E8FF"],
    keyLight: "rgba(255, 252, 214, 0.5)",
    fillLight: "rgba(80, 140, 255, 0.35)",
    rimLight: "rgba(0, 240, 255, 0.4)",
    linearGradient: {
      topLeft: "rgba(0, 240, 255, 0.9)",
      middle: "rgba(0, 136, 255, 0.5)",
      bottomRight: "rgba(125, 232, 255, 0.2)"
    }
  },
  listening: {
    main: "#FBBF24",
    mid: "#F59E0B",
    dark: "#3a2a08",
    deepDark: "#1a1203",
    highlight: "#FFF3C4",
    glow: "rgba(251, 191, 36, 0.55)",
    label: "聆听中",
    glowOpacity: 0.4,
    filaments: ["#FBBF24", "#FDE68A", "#F59E0B"],
    blobs: ["#FBBF24", "#FDE68A", "#F59E0B"],
    keyLight: "rgba(255, 248, 214, 0.55)",
    fillLight: "rgba(255, 150, 60, 0.3)",
    rimLight: "rgba(253, 230, 138, 0.45)",
    linearGradient: {
      topLeft: "rgba(251, 191, 36, 0.9)",
      middle: "rgba(245, 158, 11, 0.5)",
      bottomRight: "rgba(253, 230, 138, 0.2)"
    }
  },
  thinking: {
    main: "#8B5CF6",
    mid: "#6D28D9",
    dark: "#1e1240",
    deepDark: "#0e081f",
    highlight: "#EDE4FF",
    glow: "rgba(139, 92, 246, 0.55)",
    label: "思考中",
    glowOpacity: 0.4,
    filaments: ["#8B5CF6", "#A78BFA", "#C4B5FD"],
    blobs: ["#8B5CF6", "#A78BFA", "#C4B5FD"],
    keyLight: "rgba(245, 238, 255, 0.5)",
    fillLight: "rgba(180, 120, 255, 0.3)",
    rimLight: "rgba(167, 139, 250, 0.45)",
    linearGradient: {
      topLeft: "rgba(139, 92, 246, 0.9)",
      middle: "rgba(109, 40, 217, 0.5)",
      bottomRight: "rgba(196, 181, 253, 0.2)"
    }
  },
  speaking: {
    main: "#00E5A8",
    mid: "#00C08C",
    dark: "#0a2a22",
    deepDark: "#041310",
    highlight: "#B8FFE4",
    glow: "rgba(0, 229, 168, 0.55)",
    label: "播报中",
    glowOpacity: 0.42,
    filaments: ["#00E5A8", "#00F0FF", "#8AFFE0"],
    blobs: ["#00E5A8", "#00F0FF", "#8AFFE0"],
    keyLight: "rgba(214, 255, 244, 0.55)",
    fillLight: "rgba(0, 160, 220, 0.32)",
    rimLight: "rgba(0, 240, 255, 0.5)",
    linearGradient: {
      topLeft: "rgba(0, 229, 168, 0.9)",
      middle: "rgba(0, 240, 255, 0.5)",
      bottomRight: "rgba(138, 255, 224, 0.2)"
    }
  },
  error: {
    main: "#F56060",
    mid: "#DC2626",
    dark: "#3a0a0a",
    deepDark: "#180303",
    highlight: "#FFC9C9",
    glow: "rgba(245, 96, 96, 0.55)",
    label: "出错",
    glowOpacity: 0.4,
    filaments: ["#F56060", "#FF9E9E", "#FBBF24"],
    blobs: ["#F56060", "#DC2626", "#FF9E9E"],
    keyLight: "rgba(255, 228, 228, 0.5)",
    fillLight: "rgba(180, 40, 40, 0.3)",
    rimLight: "rgba(255, 158, 158, 0.45)",
    linearGradient: {
      topLeft: "rgba(245, 96, 96, 0.9)",
      middle: "rgba(220, 38, 38, 0.5)",
      bottomRight: "rgba(251, 191, 36, 0.2)"
    }
  },
  muted: {
    main: "#6B7280",
    mid: "#4B5563",
    dark: "#1c2128",
    deepDark: "#0d1014",
    highlight: "#D6DCE4",
    glow: "rgba(107, 114, 128, 0.4)",
    label: "已静音",
    glowOpacity: 0.25,
    filaments: ["#6B7280", "#9CA3AF", "#4B5563"],
    blobs: ["#6B7280", "#00F0FF", "#9CA3AF"],
    keyLight: "rgba(226, 232, 240, 0.4)",
    fillLight: "rgba(80, 90, 110, 0.28)",
    rimLight: "rgba(156, 163, 175, 0.35)",
    linearGradient: {
      topLeft: "rgba(107, 114, 128, 0.85)",
      middle: "rgba(0, 240, 255, 0.4)",
      bottomRight: "rgba(75, 85, 99, 0.3)"
    }
  }
};

// ── 皮肤预设（设置页可切换，覆盖主状态色形成不同视觉主题）──
// 每个皮肤只覆盖各状态的 main/mid/highlight/glow，整体替换 palette 时其余字段沿用。
const skins = {
  // 默认能量青：idle 青蓝能量 + 琥珀聆听 + 星云紫思考（设计文档原色）
  energy: null,
  // 极光紫：全状态偏紫罗兰，霓虹冷艳
  aurora: {
    idle:     { main: "#8B5CF6", mid: "#6D28D9", highlight: "#EDE4FF", glow: "rgba(139, 92, 246, 0.5)" },
    listening:{ main: "#A78BFA", mid: "#7C3AED", highlight: "#F1E8FF", glow: "rgba(167, 139, 250, 0.55)" },
    thinking: { main: "#C084FC", mid: "#9333EA", highlight: "#F5E8FF", glow: "rgba(192, 132, 252, 0.55)" },
    speaking: { main: "#38BDF8", mid: "#0EA5E9", highlight: "#D8F4FF", glow: "rgba(56, 189, 248, 0.55)" },
    error:    { main: "#F56060", mid: "#DC2626", highlight: "#FFC9C9", glow: "rgba(245, 96, 96, 0.55)" },
    muted:    { main: "#6B7280", mid: "#4B5563", highlight: "#D6DCE4", glow: "rgba(107, 114, 128, 0.4)" },
  },
  // 暖阳琥珀：金黄活力主题
  amber: {
    idle:     { main: "#F59E0B", mid: "#D97706", highlight: "#FFEFC9", glow: "rgba(245, 158, 11, 0.5)" },
    listening:{ main: "#FBBF24", mid: "#F59E0B", highlight: "#FFF3C4", glow: "rgba(251, 191, 36, 0.55)" },
    thinking: { main: "#F97316", mid: "#EA580C", highlight: "#FFE3CD", glow: "rgba(249, 115, 22, 0.55)" },
    speaking: { main: "#F59E0B", mid: "#D97706", highlight: "#FFEFC9", glow: "rgba(245, 158, 11, 0.55)" },
    error:    { main: "#F56060", mid: "#DC2626", highlight: "#FFC9C9", glow: "rgba(245, 96, 96, 0.55)" },
    muted:    { main: "#6B7280", mid: "#4B5563", highlight: "#D6DCE4", glow: "rgba(107, 114, 128, 0.4)" },
  },
  // 翡翠深绿：沉稳科技主题
  emerald: {
    idle:     { main: "#10B981", mid: "#059669", highlight: "#D1FAE5", glow: "rgba(16, 185, 129, 0.5)" },
    listening:{ main: "#34D399", mid: "#10B981", highlight: "#D7FBEA", glow: "rgba(52, 211, 153, 0.55)" },
    thinking: { main: "#2DD4BF", mid: "#14B8A6", highlight: "#D5FBF5", glow: "rgba(45, 212, 191, 0.55)" },
    speaking: { main: "#10B981", mid: "#059669", highlight: "#D1FAE5", glow: "rgba(16, 185, 129, 0.55)" },
    error:    { main: "#F56060", mid: "#DC2626", highlight: "#FFC9C9", glow: "rgba(245, 96, 96, 0.55)" },
    muted:    { main: "#6B7280", mid: "#4B5563", highlight: "#D6DCE4", glow: "rgba(107, 114, 128, 0.4)" },
  },
};

// 当前生效皮肤（null = 默认能量青）。皮肤字段合并覆盖到各状态 palette。
let activeSkin = null;
// 默认 palette 快照：皮肤应用会就地改写 palettes，切回默认时必须用快照还原。
const defaultPalettes = JSON.parse(JSON.stringify(palettes));
function restoreDefaultPalettes() {
  for (const state of Object.keys(defaultPalettes)) {
    palettes[state] = JSON.parse(JSON.stringify(defaultPalettes[state]));
  }
}
function applySkin(skin) {
  if (skin === activeSkin) return;
  activeSkin = skin;
  const skinDef = skins[skin] || null;
  if (!skinDef) {
    // 恢复默认：用内置 palettes（已含设计文档原色），重新上色当前状态
    restoreDefaultPalettes();
    applyStateVisuals(currentState);
    return;
  }
  for (const state of Object.keys(skinDef)) {
    const pal = palettes[state];
    if (!pal) continue;
    const override = skinDef[state];
    pal.main = override.main;
    pal.mid = override.mid;
    pal.highlight = override.highlight;
    pal.glow = override.glow;
    // 派生：dark/deepDark 用 mid 的暗化版本；布光色随主色
    pal.dark = shadeHex(override.mid, 0.35);
    pal.deepDark = shadeHex(override.mid, 0.16);
    pal.keyLight = hexToRgba(override.highlight, 0.5);
    pal.fillLight = hexToRgba(override.main, 0.3);
    pal.rimLight = hexToRgba(override.highlight, 0.45);
    pal.filaments = [override.main, override.main, override.highlight];
    pal.blobs = [override.main, override.highlight, override.mid];
  }
  applyStateVisuals(currentState);
}

// hex -> "rgba(r, g, b, a)"（皮肤布光色生成用）
function hexToRgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

// hex 明暗调节：f>1 提亮、0<f<1 压暗（派生 dark/deepDark 基底）
function shadeHex(hex, f) {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`;
}

// ── 自定义头像叠加（「潇洒哥 3D 动感头像」类需求）──
// 头像图片叠加在球体表面：带 3D 倾斜跟随 + 呼吸缩放，随状态色淡入淡出，
// 不改变球体本身的能量渲染（球体仍是主体，头像是表面材质层）。
let avatarImage = null;
let avatarImageUrl = null;
function loadAvatar(path) {
  if (avatarImageUrl === path) return;
  avatarImageUrl = path;
  avatarImage = null;
  if (!path) return;
  const img = new Image();
  img.onload = () => { avatarImage = img; };
  img.onerror = () => { logToMain("FLOAT_LOG: avatar load failed: " + path); avatarImage = null; };
  img.src = path.startsWith("file:") ? path : encodeURI("file:///" + String(path).split("\\").join("/").replace(/^\/+/, ""));
}

diriAPI.getFloatAppearance().then((appearance) => {
  applySkin(appearance.skin);
  loadAvatar(appearance.avatarPath);
}).catch(() => {});
diriAPI.onFloatAppearanceChanged((appearance) => {
  applySkin(appearance.skin);
  loadAvatar(appearance.avatarPath);
});

const targetConfigs = {
  idle:      { speed: 0.35, spread: 0.46, pulse: 0.04, rotation: 0.06 },
  listening: { speed: 0.45, spread: 0.52, pulse: 0.06, rotation: 0.09 },
  thinking:  { speed: 0.65, spread: 0.40, pulse: 0.05, rotation: 0.14 },
  speaking:  { speed: 0.50, spread: 0.48, pulse: 0.08, rotation: 0.08 },
  error:     { speed: 0.70, spread: 0.55, pulse: 0.10, rotation: 0.18 },
  muted:     { speed: 0.22, spread: 0.38, pulse: 0.03, rotation: 0.04 }
};

// ── 弹性形变物理（设计文档「静若处子，动若脱兔」）──
// 球体缩放/倾斜/呼吸不再用硬性 lerp，而是弹簧-阻尼动力学：
// 状态切换时目标值突变，球体带惯性冲向目标并在目标附近来回弹两下才稳定，
// 产生真实的「弹性果冻」体感（比线性插值更有生命力）。
const spring = (val, vel, target, stiffness, damping) => {
  vel = (vel + (target - val) * stiffness) * damping;
  val += vel;
  return { val, vel };
};

// ── 运行状态 ──
let currentState = 'idle';
const speedMultiplier = 0.1; // 固定 0.1x
let visible = false;
let isLoopRunning = false;
let dpr = Math.min(window.devicePixelRatio || 1, 2.0); // 限制 Retina 最大缩放倍率为 2.0，降低高清绘制压力

let animSpeed = targetConfigs.idle.speed;
let animSpread = targetConfigs.idle.spread;
let animPulse = targetConfigs.idle.pulse;
let animRotation = targetConfigs.idle.rotation;
let orbScale = 1;
let opacity = 0;
let wakeScale = 1.0;
let targetWakeScale = 1.0;
let wakeShrinkTimer = null;
let slideOffset = -100;

// 交互缩放（canvas 内实现，避免 Windows 透明窗口 CSS transform 放大累积）：
// uiHoverScale 悬停放大、uiPressScale 按下缩小、modeScale 迷你形态放大。
let uiHoverScale = 1.0;
let uiPressScale = 1.0;
let isPointerDownOnOrb = false;
// 悬停能量注入：hover 时核心更亮、轨道粒子加速（微交互质感）
let hoverEnergy = 0.0;

// 弹性形变速度缓存（spring 动力学）
let scaleVel = 0;
let tiltXVel = 0;
let tiltYVel = 0;

// 状态切换能量裂纹（神秘符文感：状态变化时核心辐射亮纹后隐去；error 态持续显现）
let fracture = null;

// 球内微观尘埃微粒（深空感：低速漂移 + 微弱闪烁，speaking 随音量加速）
let dust = [];
let dustInited = false;

// ── 3D 立体渲染状态（软渲染/数学投影）──
// 球面点云绕轴自转 + 鼠标视差倾斜 + 透视近大远小，呈现真实 3D 立体感。
// 刻意不引入 WebGL/three.js：Windows 透明窗口对 GPU 合成有已知黑屏风险，
// 纯 canvas 2D 投影无兼容隐患，且与现有玻璃质感层无缝融合。
let spherePoints = [];
let sphereRotY = 0;
let tiltX = 0;      // 鼠标视差倾斜（上下轴）
let tiltY = 0;      // 鼠标视差倾斜（左右轴）
let spinBoost = 0;  // 点击自转脉冲
let lastPointerU = 0.5; // 指针在 orb 内的归一化坐标（0-1）
let lastPointerV = 0.5;

function buildSpherePoints(n) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push({ x: Math.cos(theta) * rad, y, z: Math.sin(theta) * rad });
  }
  return pts;
}
spherePoints = buildSpherePoints(260);

function rotateYX(x, y, z, ry, rx) {
  const cosY = Math.cos(ry), sinY = Math.sin(ry);
  const cosX = Math.cos(rx), sinX = Math.sin(rx);
  const x1 = x * cosY + z * sinY;
  const z1 = -x * sinY + z * cosY;
  const y2 = y * cosX - z1 * sinX;
  const z2 = y * sinX + z1 * cosX;
  return { x: x1, y: y2, z: z2 };
}

let gaseousTime = 0;
let globalRotationAngle = 0;
let time = 0;
let lastFrameTime = performance.now();

// TTS audio analysis
let audioCtx = null;
let analyser = null;
let audioSource = null;
let currentAudio = null;
let currentAudioPath = null;
let interrupted = false;
let playToken = 0;

const canvas = document.getElementById("orbCanvas");
const ctx = canvas.getContext("2d");
const orbContainer = document.getElementById("orbContainer");
const asrTextEl = document.getElementById("asrText");
const llmOutputEl = document.getElementById("llmOutput");
const statusLabelEl = document.getElementById("statusLabel");
const statusBadgeEl = document.getElementById("statusBadge");
const orbHaloEl = document.getElementById("orbHalo");
const capsuleEl = document.getElementById("capsule");

// ── 悬浮球形态与平台降级 ──
let currentFloatMode = "standard";
// Windows 透明窗口 backdrop-filter 采样异常（拖动放大的已知隐患），CSS 降级
if (diriAPI.platform === "win32") document.body.classList.add("win32");

diriAPI.onFloatModeChanged((mode) => {
  currentFloatMode = mode === "mini" ? "mini" : mode === "hidden" ? "hidden" : "standard";
  document.body.classList.toggle("mini", currentFloatMode === "mini");
  const hintEl = document.getElementById("orbHint");
  if (hintEl) {
    hintEl.textContent = currentFloatMode === "mini"
      ? "单击对话 · 双击展开 · 右键菜单"
      : "单击录音 · 双击切换形态 · 右键菜单";
  }
});

function toggleFloatMode() {
  const next = currentFloatMode === "mini" ? "standard" : "mini";
  diriAPI.setFloatMode(next);
}

// 状态切换冲击波（一次性的能量涟漪，渲染循环中衰减扩散）
let pulses = [];
// speaking 表面能量粒子（随高频音量闪烁漂移）
let sparkles = [];
let lastVisualState = null;

// ── 光标跟随高光（液态玻璃"视差"：高光点随鼠标在球面移动，增强材质真实感）──
let cursorGlowX = 0;
let cursorGlowY = 0;
let cursorGlowActive = false;
let cursorGlowFade = 0;
// 桌面空闲时的高光静止位：球体左上常规高光区
let lastCursorTime = 0;

window.addEventListener("mousemove", (e) => {
  if (orbContainer) {
    const rect = canvas.getBoundingClientRect();
    const inOrb = isPointInElement(e.clientX, e.clientY, orbContainer);
    cursorGlowActive = inOrb;
    if (inOrb) {
      cursorGlowX = e.clientX - rect.left;
      cursorGlowY = e.clientY - rect.top;
      lastPointerU = rect.width > 0 ? cursorGlowX / rect.width : 0.5;
      lastPointerV = rect.height > 0 ? cursorGlowY / rect.height : 0.5;
      lastCursorTime = performance.now();
    }
  }
});
window.addEventListener("mouseleave", () => { cursorGlowActive = false; });

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16)
  };
}

/** 状态切换：更新 CSS 变量让整颗胶囊跟随状态色呼吸，并触发能量反馈 */
function applyStateVisuals(state) {
  const palette = palettes[state] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  const root = document.documentElement;
  root.style.setProperty("--accent", palette.main);
  root.style.setProperty("--accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  root.style.setProperty("--glow-opacity", String(palette.glowOpacity));
  if (orbHaloEl) {
    orbHaloEl.style.background =
      `radial-gradient(circle, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35) 0%, transparent 65%)`;
  }
  if (statusLabelEl) statusLabelEl.textContent = palette.label;
  if (capsuleEl) capsuleEl.classList.toggle("speaking", state === "speaking");

  // 状态真正变化时：徽标弹入 + 球体能量冲击波 + 核心辐射裂纹（同一状态重复通知不重复触发）
  if (lastVisualState !== state) {
    if (statusBadgeEl) {
      statusBadgeEl.classList.remove("pop");
      void statusBadgeEl.offsetWidth; // 强制重排以重启动画
      statusBadgeEl.classList.add("pop");
    }
    pulses.push({ age: 0, maxAge: 1.05, color: palette.main });
    fracture = { age: 0, maxAge: 1.5 };
    lastVisualState = state;
  }
}

function resizeCanvas() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.0);
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 92;
  const h = rect.height || 92;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = w * dpr;
  canvas.height = h * dpr;
}

window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 50);

const lerp = (a, b, t) => a + (b - a) * t;

// ── IPC 通信 ──
diriAPI.onStateUpdate((payload) => {
  try {
    const data = JSON.parse(payload);
    let state = data.state || "idle";
    if (state === "processing") state = "thinking";
    currentState = state;
    applyStateVisuals(state);
  } catch (err) {
    logToMain("onStateUpdate error: " + err.message);
  }
});

// ── 实时语音文本显示 ──
function setAsrText(text) {
  if (!asrTextEl) return;
  if (text) {
    asrTextEl.textContent = text;
    asrTextEl.classList.remove("hidden", "placeholder");
  } else {
    asrTextEl.classList.add("hidden");
    asrTextEl.classList.remove("placeholder");
  }
}

diriAPI.onAsrPartial((text) => {
  setAsrText(text || "");
});

diriAPI.onAsrFinal((text) => {
  setAsrText(text || "");
});

diriAPI.onAsrError((message) => {
  setAsrText(message || "");
});

// ── LLM 回答滚动输出区 ──
let llmBuffer = "";
function sanitizeDisplay(chunk) {
  return String(chunk || "")
    .replace(/<display>[\s\S]*?<\/display>/gi, "")
    .replace(/<\/?(?:display|speech)>/gi, "")
    .replace(/\{"display":\s*"([\s\S]*?)"\s*,\s*"speech":\s*"([\s\S]*?)"\}/gi, "$1")
    .trim();
}
function setLlmOutput(text, visible) {
  if (!llmOutputEl) return;
  llmOutputEl.textContent = text;
  llmOutputEl.classList.toggle("hidden", !visible);
  llmOutputEl.scrollTop = llmOutputEl.scrollHeight;
}
diriAPI.onLlmStream((chunk) => {
  const clean = sanitizeDisplay(chunk);
  if (!clean) return;
  llmBuffer += clean;
  setLlmOutput(llmBuffer, true);
});
diriAPI.onLlmDone(() => {
  // 流式结束后保持展示；onShowWindow 会在下一轮清空
});
diriAPI.onLlmError((message) => {
  setLlmOutput("出错了：" + message, true);
});

diriAPI.onShowWindow(() => {
  visible = true;
  wakeScale = 1.0;
  targetWakeScale = 1.0;
  if (wakeShrinkTimer) clearTimeout(wakeShrinkTimer);
  wakeShrinkTimer = setTimeout(() => {
    targetWakeScale = 90 / 120;
  }, 1000);

  // 新一轮会话：清空上一轮 LLM 输出，回答从空白开始滚动
  llmBuffer = "";
  setLlmOutput("", false);

  if (!isLoopRunning) {
    isLoopRunning = true;
    lastFrameTime = performance.now();
    render();
  }
});

diriAPI.onHideWindow(() => {
  visible = false;
  if (wakeShrinkTimer) { clearTimeout(wakeShrinkTimer); wakeShrinkTimer = null; }
  setAsrText("");
  llmBuffer = "";
  setLlmOutput("", false);
});

diriAPI.onSetDocked((docked) => {
  const canvasElement = document.getElementById("orbCanvas");
  if (canvasElement) {
    if (docked) {
      canvasElement.classList.add("docked");
    } else {
      canvasElement.classList.remove("docked");
    }
  }
});

function logToMain(msg) {
  diriAPI.sendRendererLog("FLOAT_LOG: " + msg);
}

diriAPI.onTtsPlay((filePath) => {
  logToMain(`[TTS_PERF] Renderer Received: ${filePath}`);
  // 代际隔离：每来一帧 TTS_PLAY 递增 token，所有异步回调（onended/onerror/play().catch）
  // 只有在 token 仍等于本帧 token 时才响应。旧音频被新音频替换后，其迟到回调全部作废，
  // 避免把「全局 currentAudioPath」（此时已是新文件）误当旧文件上报 → 主进程误删正在播
  // 放的文件（真机日志 06:57:23 连环 TTS playback ended 误删链）。
  const token = ++playToken;
  const thisFilePath = filePath;
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  if (audioSource) { try { audioSource.disconnect(); } catch {} audioSource = null; }
  if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }

  interrupted = false;
  currentAudioPath = thisFilePath;

  const loadStartTime = performance.now();
  // 构造跨平台 file:// URL：Windows 反斜杠转正斜杠（file:///C:/...），
  // 再 encodeURI 处理中文/空格等特殊字符（Windows 用户名常为中文）
  const fileUrl = encodeURI("file:///" + String(filePath).split("\\").join("/").replace(/^\/+/, ""));
  currentAudio = new Audio(fileUrl);
  logToMain(`[TTS_PERF] Audio Loaded (instantiation took ${(performance.now() - loadStartTime).toFixed(1)}ms): ${filePath}`);

  currentAudio.addEventListener("canplay", () => {
    logToMain(`[TTS_PERF] canplay event fired for ${filePath}`);
  });

  currentAudio.addEventListener("canplaythrough", () => {
    logToMain(`[TTS_PERF] canplaythrough event fired for ${filePath}`);
  });

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 128;
    audioSource = audioCtx.createMediaElementSource(currentAudio);
    audioSource.connect(analyser);
    analyser.connect(audioCtx.destination);
    audioCtx.resume().catch(() => {});
  } catch {}

  // 本帧结束的唯一点：token 仍当前时才上报（旧的已作废），且上报的是本帧文件路径。
  // frameDone 防止同一帧 onerror 与 play().catch() 连发两次上报（真机日志同一文件
  // 先 Audio error 再 play() rejected，若重复上报会多跳一帧队列）。
  let frameDone = false;
  const onFrameDone = () => {
    if (frameDone || token !== playToken) return;
    frameDone = true;
    currentAudio = null;
    if (!interrupted) diriAPI.sendTtsPlayEnded(thisFilePath);
    currentAudioPath = null;
    cleanupAudio();
  };

  currentAudio.onended = () => {
    onFrameDone();
  };
  currentAudio.onerror = () => {
    logToMain(`[TTS_PERF] Audio error event: ${currentAudio ? currentAudio.error?.message || "unknown" : "unknown"}`);
    onFrameDone();
  };

  logToMain(`[TTS_PERF] Calling play() for ${filePath}`);
  const playStartTime = performance.now();
  currentAudio.play()
    .then(() => {
      if (token === playToken) {
        logToMain(`[TTS_PERF] play() Promise resolved in ${(performance.now() - playStartTime).toFixed(1)}ms for ${filePath}`);
      }
    })
    .catch((err) => {
      logToMain(`[TTS_PERF] play() Promise rejected: ${err.message} for ${filePath}`);
      onFrameDone();
    });
});

diriAPI.onTtsEnd(() => {
  // 终止一切在途回调：递增 token 使旧音频的迟到 onended/onerror/play().catch 全部作废
  playToken++;
  interrupted = true;
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  currentAudioPath = null;
  cleanupAudio();
});

function cleanupAudio() {
  if (audioSource) { try { audioSource.disconnect(); } catch {} audioSource = null; }
  if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
  sparkles = [];
}

/** 分频段音量分析：低频→球体呼吸缩放，中频→极光光丝振幅，高频→表面粒子闪烁 */
function getAudioBands() {
  if (analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const n = data.length;
    if (n === 0) return { low: 0, mid: 0, high: 0, overall: 0 };
    const lc = Math.max(1, Math.floor(n * 0.15));
    const mc = Math.max(1, Math.floor(n * 0.45));
    let low = 0, mid = 0, high = 0;
    for (let i = 0; i < n; i++) {
      const v = data[i] / 255;
      if (i < lc) low += v;
      else if (i < mc) mid += v;
      else high += v;
    }
    low /= lc;
    mid /= mc;
    high /= Math.max(1, n - mc);
    return { low, mid, high, overall: (low + mid + high) / 3 };
  }
  // 聆听中无真实音频流：用舒缓的正弦组合模拟呼吸感
  if (currentState === 'listening') {
    const sim = 0.12 * Math.sin(time * 0.2) * Math.cos(time * 0.1) +
                0.07 * Math.sin(time * 0.5) + 0.13;
    return { low: sim * 0.6, mid: sim * 0.85, high: sim * 0.45, overall: sim };
  }
  return { low: 0, mid: 0, high: 0, overall: 0 };
}

// ── 渲染主循环 ──
function render() {
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const opacityFactor = visible ? 0.25 : 0.15;
  const slideFactor = visible ? 0.38 : 0.22;

  opacity = lerp(opacity, visible ? 1 : 0, opacityFactor);
  const targetSlideOffset = visible ? 0 : -100;
  slideOffset = lerp(slideOffset, targetSlideOffset, slideFactor);

  if (opacity < 0.003 && !visible) {
    isLoopRunning = false;
    return; // 面板不可见且已完全淡出时，完全停止渲染循环，节省 CPU 资源
  }

  const bands = getAudioBands();

  const now = performance.now();
  const rawDt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  const dt = Math.min(0.08, rawDt) * speedMultiplier;

  cursorGlowFade = lerp(cursorGlowFade, cursorGlowActive ? 1 : 0, 0.12);
  if (!cursorGlowActive && now - lastCursorTime > 1200) {
    cursorGlowFade = lerp(cursorGlowFade, 0.25, 0.02);
  }

  const targetConfig = targetConfigs[currentState] || targetConfigs.idle;
  animSpeed = lerp(animSpeed, targetConfig.speed, 0.04);
  animSpread = lerp(animSpread, targetConfig.spread, 0.04);
  animPulse = lerp(animPulse, targetConfig.pulse, 0.04);
  animRotation = lerp(animRotation, targetConfig.rotation, 0.03);

  gaseousTime += animSpeed * dt * 60;
  globalRotationAngle += animRotation * dt * 9;
  time += dt * 60;

  let baseScale = 1.0;
  if (currentState === 'speaking') baseScale += bands.low * 0.16;
  else if (currentState === 'listening') baseScale += bands.low * 0.10;
  const breath = 1.0 + Math.sin(time * 0.4) * animPulse;
  // 弹性形变：缩放带弹簧惯性（状态切换/音量变化时果冻式弹跳，比硬 lerp 更有体感）
  const scaleResult = spring(orbScale, scaleVel, baseScale * breath, 0.02, 0.94);
  orbScale = scaleResult.val;
  scaleVel = scaleResult.vel;
  wakeScale = lerp(wakeScale, targetWakeScale, 0.04);

  // 交互缩放：hover 放大 1.06、按下 0.94、迷你形态 1.08，全部有界 lerp 永不累积。
  // 在 canvas 内缩放而非 DOM transform，规避 Windows 透明窗口逐帧合成放大 bug。
  const modeScale = currentFloatMode === "mini" ? 1.08 : 1.0;
  uiHoverScale = lerp(uiHoverScale, cursorGlowActive ? 1.06 : 1.0, 0.12);
  uiPressScale = lerp(uiPressScale, isPointerDownOnOrb ? 0.94 : 1.0, 0.20);
  const uiScale = uiHoverScale * uiPressScale * modeScale;
  hoverEnergy = lerp(hoverEnergy, cursorGlowActive ? 1.0 : 0.0, 0.10);

  // ── 3D 自转 + 鼠标视差倾斜 + 点击自转脉冲 ──
  // 转速度：idle ~8.7s/圈、listening ~5s/圈、thinking ~4.2s/圈（time 每帧推进，
  // 基值 0.012/帧@60fps = 0.72rad/s），状态越活跃转得越快。
  const activeSpeed = targetConfigs[currentState] ? targetConfigs[currentState].speed : 0.35;
  sphereRotY += 0.018 + activeSpeed * 0.026 + spinBoost * 0.03;
  spinBoost = lerp(spinBoost, 0, 0.02);
  const targetTiltX = cursorGlowActive ? (lastPointerV - 0.5) * 0.70 : 0;
  const targetTiltY = cursorGlowActive ? (lastPointerU - 0.5) * 0.85 : 0;
  // 视差倾斜同样走弹簧：鼠标移走后球体带惯性回正并轻微弹跳，立体感更真实
  const tiltXRes = spring(tiltX, tiltXVel, targetTiltX, 0.06, 0.90);
  tiltX = tiltXRes.val;
  tiltXVel = tiltXRes.vel;
  const tiltYRes = spring(tiltY, tiltYVel, targetTiltY, 0.06, 0.90);
  tiltY = tiltYRes.val;
  tiltYVel = tiltYRes.vel;

  let shakeX = 0, shakeY = 0;
  if (currentState === 'error') {
    shakeX = Math.sin(time * 65) * 2.5;
    shakeY = Math.cos(time * 55) * 2.5;
  }

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.scale(dpr, dpr);
  // 悬浮漂浮：球体以 6 秒周期做 ±3px 正弦浮动，营造失重悬浮感（设计文档 2.4）
  const floatY = Math.sin(time * 0.016) * 3;
  ctx.translate(w / 2 + shakeX, h / 2 + shakeY + slideOffset + floatY);
  ctx.scale(orbScale * wakeScale * uiScale, orbScale * wakeScale * uiScale);
  ctx.translate(-w / 2, -h / 2);

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 6;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  ensureDust(radius);
  drawDeepSpaceCore(cx, cy, radius, currentState, bands);
  drawNeonFilaments(cx, cy, radius, bands.mid, currentState);
  draw3DPointSphere(cx, cy, radius, currentState);
  drawAvatarOverlay(cx, cy, radius, currentState);
  drawThreePointLighting(cx, cy, radius, currentState, bands);
  drawBaseReflection(cx, cy, radius);
  draw3DOrbits(cx, cy, radius, currentState);
  drawRipples(cx, cy, radius, currentState);
  drawFracture(cx, cy, radius, currentState);
  drawNebulaDust(cx, cy, radius, currentState, bands);
  drawGlassScan(cx, cy, radius, currentState);
  drawCursorGlow(cx, cy, radius, currentState);
  drawChromaticEdge(cx, cy, radius, currentState);
  drawInnerShadow(cx, cy, radius, isDark);
  drawGlassWallRefraction(cx, cy, radius);

  ctx.restore();

  drawGlassHighlights(cx, cy, radius, currentState, isDark);
  ctx.restore();

  // 能量裂纹生命周期：衰减完成后释放
  if (fracture) {
    fracture.age += rawDt;
    if (fracture.age >= fracture.maxAge) fracture = null;
  }

  // 球外能量层是常驻元素（非瞬态），需与球体共用同一变换：
  // 保持 opacity 淡出/淡入、跟随 hover/press/mini 缩放、与 hide 滑动同步，
  // 否则隐藏时球已透明而能量层全亮度残留、mini 形态不同步放大。
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(w / 2 + shakeX, h / 2 + shakeY + slideOffset + floatY);
  ctx.scale(orbScale * wakeScale * uiScale, orbScale * wakeScale * uiScale);
  ctx.translate(-w / 2, -h / 2);
  drawEnergyField(cx, cy, radius, currentState, bands);
  drawCorePulse(cx, cy, radius, currentState);
  drawEmittedParticles(cx, cy, radius, currentState, bands, rawDt);
  ctx.restore();

  /** 能量场外扩：球体外圈始终存在的呼吸光晕（能量"溢出"球体），状态激活/hover 时
 *  更亮更大，speaking 随音量膨胀——让球不再是封闭球体，而是向外辐射的能量源。 */
function drawEnergyField(cx, cy, radius, activeState, bands) {
  const palette = palettes[activeState] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  const active = activeState === "speaking" || activeState === "listening";
  const vol = activeState === "speaking" && bands ? bands.high : 0;
  const hover = hoverEnergy;

  const breath = 1 + Math.sin(time * 0.22) * 0.05;
  const rOut = radius * (1.42 + vol * 0.30 + hover * 0.12) * breath;
  const baseA = (active ? 0.16 : 0.07) + vol * 0.16 + hover * 0.05;

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const g = ctx.createRadialGradient(cx, cy, radius * 0.9, cx, cy, rOut);
  g.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${baseA})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, rOut, 0, Math.PI * 2);
  ctx.fill();

  // 能量鞘边缘：一圈细亮的呼吸环（vol 驱动抖动），定义能量场边界
  const edgeA = (active ? 0.20 : 0.08) + vol * 0.18 + hover * 0.05;
  const eR = rOut * 0.94;
  const wob = Math.sin(time * 0.9) * (vol * 0.5 + 0.08);
  ctx.beginPath();
  ctx.arc(cx, cy, eR + wob, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${edgeA})`;
  ctx.lineWidth = 1.0 + vol * 0.8;
  ctx.stroke();
  ctx.restore();
}

/** 核心心跳：每 2.4s（真实时间）从球心透出球体向外的同心能量波（活的发动机感），speaking 加速。
 *  注意 time 以 6x 真实时间前进，故周期需乘以 6：idle 2.4s→14.4、speaking 1.1s→6.6。 */
function drawCorePulse(cx, cy, radius, activeState) {
  const palette = palettes[activeState] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  const hrgb = hexToRgb(palette.highlight);
  const speaking = activeState === "speaking";
  const interval = speaking ? 6.6 : 14.4;
  const cycles = speaking ? 2 : 1; // 说话时双波叠加

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let c = 0; c < cycles; c++) {
    const phase = ((time % interval) + c * interval / cycles) % interval;
    const prog = phase / interval;
    const r = radius * (0.28 + prog * 1.35);
    const a = (1 - prog) * (speaking ? 0.30 : 0.18);
    if (a <= 0.01) continue;
    // 波前高亮薄环 + 柔光填充
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${hrgb.r}, ${hrgb.g}, ${hrgb.b}, ${a})`;
    ctx.lineWidth = 1.2 * (1 - prog) + 0.3;
    ctx.stroke();
    const fillG = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r);
    fillG.addColorStop(0, "rgba(255,255,255,0)");
    fillG.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a * 0.5})`);
    ctx.fillStyle = fillG;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 能量外溢粒子：speaking/listening 时从球面持续迸发微型光点向外漂移消散（能量持续放射），
 *  hover 时也能少量外溢强化「活体」感知 */
let emittedParticles = [];
function drawEmittedParticles(cx, cy, radius, activeState, bands, dtRef) {
  const speaking = activeState === "speaking";
  const listening = activeState === "listening";
  const vol = speaking && bands ? bands.high : 0;
  const spawnRate = (speaking ? 0.9 + vol * 1.2 : listening ? 0.35 : 0.08) + hoverEnergy * 0.35;
  const palette = palettes[activeState] || palettes.idle;
  const hrgb = hexToRgb(palette.highlight);
  const dtSec = dtRef || 0.016;

  if (Math.random() < spawnRate * 0.06 && emittedParticles.length < 46) {
    const a = Math.random() * Math.PI * 2;
    emittedParticles.push({
      a,
      r: radius + 1 + Math.random() * 4,
      v: 0.28 + Math.random() * 0.5 + vol * 0.6,
      life: 0,
      maxLife: 0.5 + Math.random() * 0.7,
      size: 0.6 + Math.random() * 1.1,
      drift: (Math.random() - 0.5) * 0.4,
    });
  }

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = emittedParticles.length - 1; i >= 0; i--) {
    const p = emittedParticles[i];
    p.life += dtSec;
    if (p.life >= p.maxLife) { emittedParticles.splice(i, 1); continue; }
    const prog = p.life / p.maxLife;
    p.r += p.v * (1 - prog * 0.5);
    p.a += p.drift * 0.02;
    const a = (1 - prog) * (speaking ? 0.55 : 0.35);
    if (a <= 0.01) continue;
    const px = cx + Math.cos(p.a) * p.r;
    const py = cy + Math.sin(p.a) * p.r;
    ctx.fillStyle = `rgba(${hrgb.r}, ${hrgb.g}, ${hrgb.b}, ${a})`;
    ctx.beginPath();
    ctx.arc(px, py, p.size * (1 - prog * 0.6), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// 状态冲击波：能量涟漪从球心冲出球体（clip 外绘制，不被球面裁切）
  // 双层结构：内层白色核心环（能量源） + 外层状态色光环（扩散），末端亮核随衰减缩小。
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    p.age += rawDt;
    if (p.age >= p.maxAge) { pulses.splice(i, 1); continue; }
    const prog = p.age / p.maxAge;
    const pr = radius * (0.5 + prog * 1.35);
    const pa = (1 - prog) * 0.5;
    const prgb = hexToRgb(p.color);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    // 内层：白核心（紧随波前的高亮薄环，模拟能量源运动）
    ctx.beginPath();
    ctx.arc(cx, cy, pr * 0.94, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${pa * 0.55})`;
    ctx.lineWidth = 1.1;
    ctx.stroke();
    // 外层：状态色光环
    ctx.beginPath();
    ctx.arc(cx, cy, pr, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${prgb.r}, ${prgb.g}, ${prgb.b}, ${pa})`;
    ctx.lineWidth = 2.4 * (1 - prog) + 0.6;
    ctx.stroke();
    ctx.restore();
  }

  // 说话中：球体边缘随机能量光刺（高频音量驱动，弱化为细光晕线）
  if (currentState === "speaking" && bands.high > 0.02) {
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const flares = 6;
    for (let i = 0; i < flares; i++) {
      const baseA = time * 0.55 + i * 2.1;
      const spread = (Math.sin(time * 0.9 + i) * 0.7) * bands.high;
      const a = baseA + spread;
      const fx = cx + Math.cos(a) * (radius - 1);
      const fy = cy + Math.sin(a) * (radius - 1);
      const len = radius * (0.10 + 0.14 * bands.high);
      const tx = cx + Math.cos(a) * (radius + len);
      const ty = cy + Math.sin(a) * (radius + len);
      const grad = ctx.createLinearGradient(fx, fy, tx, ty);
      grad.addColorStop(0, `rgba(255,255,255,${0.10 + 0.12 * bands.high})`);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 说话中表面能量粒子：随高频音量在球面内闪烁漂移
  if (currentState === "speaking") {
    if (sparkles.length < 36 && Math.random() < 0.16 + bands.high * 0.5) {
      sparkles.push({
        a: Math.random() * Math.PI * 2,
        d: radius * (0.28 + Math.random() * 0.5),
        life: 0,
        maxLife: 0.5 + Math.random() * 0.9,
        size: 1 + Math.random() * 1.9,
      });
    }
  }
  for (let i = sparkles.length - 1; i >= 0; i--) {
    const s = sparkles[i];
    s.life += rawDt;
    if (s.life >= s.maxLife) { sparkles.splice(i, 1); continue; }
    const sp = s.life / s.maxLife;
    const sa = (1 - sp) * (0.3 + bands.high * 0.7);
    if (sa <= 0.01) continue;
    const wobble = Math.sin(time * 0.28 + s.a * 3) * 2.4;
    const sx = cx + Math.cos(s.a) * (s.d + wobble);
    const sy = cy + Math.sin(s.a) * (s.d + wobble);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = `rgba(226, 246, 255, ${sa})`;
    ctx.beginPath();
    ctx.arc(sx, sy, s.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (isLoopRunning) {
    requestAnimationFrame(render);
  }
}

/** 3D 恒星点云球体：球面 360 点按 Fibonacci 均匀分布，绕 Y 轴自转 + 鼠标视差
 *  tilt，透视投影（近大远小、深处暗近处亮），按深度远→近排序绘制。
 *  这是整颗球的主体立体感来源——不再是平面渐变，而是真实旋转的 3D 天体。 */
function draw3DPointSphere(cx, cy, radius, activeState) {
  const palette = palettes[activeState] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  const hrgb = hexToRgb(palette.highlight);
  const n = spherePoints.length;
  const f = radius * 3.0;
  const r = radius * 0.86;
  const ry = sphereRotY + tiltY;
  const rx = tiltX;

  // 投影并计算深度
  const proj = [];
  for (let i = 0; i < n; i++) {
    const p = spherePoints[i];
    const q = rotateYX(p.x, p.y, p.z, ry, rx);
    const depth = f / (f + q.z * r);
    proj.push({
      x: cx + q.x * r * depth,
      y: cy + q.y * r * depth,
      z: q.z,
      depth,
    });
  }
  proj.sort((a, b) => a.z - b.z);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < n; i++) {
    const d = proj[i];
    const depth01 = (d.z + 1) / 2;
    const size = 1.9 * d.depth + 0.45;
    const alpha = 0.08 + depth01 * 0.62;
    // 深处偏状态色，近处偏高亮
    const mix = depth01;
    const cr = Math.floor(lerp(rgb.r, hrgb.r, mix * 0.9));
    const cg = Math.floor(lerp(rgb.g, hrgb.g, mix * 0.9));
    const cb = Math.floor(lerp(rgb.b, hrgb.b, mix * 0.9));
    ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 三点布光（设计文档核心：让球体呈现真实立体材质而非平面渐变）。
 *  主光在左上方（暖白）、辅光在右下方（冷色状态光）、轮廓光在球体左上边缘。
 *  叠加在 3D 点云之上，强化「受光面亮、背光面暗、边缘有轮廓」的立体感。 */
function drawThreePointLighting(cx, cy, radius, activeState, bands) {
  const palette = palettes[activeState] || palettes.idle;
  const vol = activeState === "speaking" && bands ? bands.high : 0;
  ctx.save();
  ctx.globalCompositeOperation = "screen";

  // 1. 主光（左上暖白）：大范围柔光罩，让受光面整体提亮偏暖
  const keyGrad = ctx.createRadialGradient(
    cx - radius * 0.38, cy - radius * 0.42, 0,
    cx - radius * 0.38, cy - radius * 0.42, radius * 1.05
  );
  keyGrad.addColorStop(0, palette.keyLight);
  keyGrad.addColorStop(0.4, "rgba(255,255,255,0.18)");
  keyGrad.addColorStop(0.62, "rgba(255,255,255,0.08)");
  keyGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = keyGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // 1b. 高光热区：主光中心再加一道更小更亮的点，形成"球面最高点"的镜面泛光
  const hotGrad = ctx.createRadialGradient(
    cx - radius * 0.34, cy - radius * 0.38, 0,
    cx - radius * 0.34, cy - radius * 0.38, radius * 0.42
  );
  hotGrad.addColorStop(0, "rgba(255,255,255,0.34)");
  hotGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hotGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // 2. 辅光（右下冷色）：补充阴影面的状态色，让背光面带环境反光而不死黑
  const fillGrad = ctx.createRadialGradient(
    cx + radius * 0.42, cy + radius * 0.46, 0,
    cx + radius * 0.42, cy + radius * 0.46, radius * 0.95
  );
  fillGrad.addColorStop(0, palette.fillLight);
  fillGrad.addColorStop(0.6, "rgba(255,255,255,0.05)");
  fillGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = fillGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // 2b. 明暗分界线（Terminator）：受光面亮、背光面暗的强对比是"球体立体感"的核心来源。
  // 在右下阴影侧叠加压暗层，让球体呈现明确的体积转折，而不是一团平铺的渐变。
  ctx.globalCompositeOperation = "source-over";
  const termGrad = ctx.createRadialGradient(
    cx - radius * 0.30, cy - radius * 0.35, radius * 0.05,
    cx - radius * 0.30, cy - radius * 0.35, radius * 1.32
  );
  termGrad.addColorStop(0, "rgba(0,0,0,0)");
  termGrad.addColorStop(0.45, "rgba(0,0,0,0)");
  termGrad.addColorStop(0.70, "rgba(0,0,0,0.24)");
  termGrad.addColorStop(0.88, "rgba(0,0,0,0.50)");
  termGrad.addColorStop(1, "rgba(0,0,0,0.60)");
  ctx.fillStyle = termGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "screen";

  // 3. 轮廓光（左上边缘描边）：主光对侧产生逆光轮廓，说话时随音量增亮
  const rimBoost = activeState === "speaking" ? vol * 0.18 : 0;
  const rimAlpha = 0.22 + rimBoost + hoverEnergy * 0.08;
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 0.6, -Math.PI * 0.95, -Math.PI * 0.05);
  ctx.strokeStyle = palette.rimLight.replace(/[\d.]+\)$/, `${Math.min(0.65, rimAlpha)})`);
  ctx.lineWidth = 2.2 + vol * 1.4;
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.restore();
}

/** 自定义头像叠加层：图片裁成圆形贴到球面上，随 3D 倾斜做轻微视差、随音量呼吸。
 *  头像本身半透明融于能量球，保持球体立体感不丢失。无头像时直接跳过（零开销）。 */
function drawAvatarOverlay(cx, cy, radius, activeState) {
  if (!avatarImage || avatarImage.width <= 0) return;
  const palette = palettes[activeState] || palettes.idle;
  // 随状态淡入淡出：待命弱、激活态强（头像可辨识但不抢能量球主体）
  const stateAlpha = activeState === "idle" || activeState === "muted" ? 0.62 : 0.80;
  const breathe = 1 + Math.sin(time * 0.5) * 0.02;

  ctx.save();
  // 头像按球面透视轻度压缩，形成「贴纸贴在球上」的立体感
  const tiltCompress = 1 - Math.abs(Math.sin(tiltY)) * 0.18;
  const avR = radius * 0.68 * breathe;
  ctx.globalAlpha = stateAlpha;
  ctx.beginPath();
  ctx.arc(cx, cy, avR, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(
    avatarImage,
    cx - avR, cy - avR * (2 - tiltCompress),
    avR * 2, avR * 2 * tiltCompress
  );
  // 头像外圈细描边，融入球体材质
  ctx.beginPath();
  ctx.arc(cx, cy, avR, 0, Math.PI * 2);
  ctx.strokeStyle = palette.highlight;
  ctx.globalAlpha = stateAlpha * 0.35;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.restore();
}

/** 深空能量核心：暗物质基底 + 内部白色等离子核（体积光）+ 状态色辉光 + 湍流星云亮斑。
 *  相比旧版「线性渐变球」：白色核心从内部照亮，外层状态色渐变扩散，配合缓慢旋转的
 *  湍流光斑，呈现「活体能量」的神秘体积感而非平面霓虹贴片。 */
function drawDeepSpaceCore(cx, cy, radius, activeState, bands) {
  const palette = palettes[activeState] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  const hrgb = hexToRgb(palette.highlight);

  // 1. 深空基底：状态色暗部 → 近黑，底部更沉（保留玻璃球轮廓）
  const baseGrad = ctx.createRadialGradient(
    cx, cy, radius * 0.08,
    cx, cy, radius
  );
  baseGrad.addColorStop(0, palette.dark);
  baseGrad.addColorStop(0.55, palette.deepDark);
  baseGrad.addColorStop(1, "rgba(1, 2, 8, 1)");
  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  const coreAmp = 0.5 + hoverEnergy * 0.5; // hover 时核心更亮

  // 2. 白色等离子核心（内部体积光，深空能量的"燃点"）——设计文档要求能量核明亮通透
  const coreR = radius * 0.36;
  const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  coreGrad.addColorStop(0, `rgba(255,255,255,${1.0 * coreAmp})`);
  coreGrad.addColorStop(0.4, `rgba(255,255,255,${0.55 * coreAmp})`);
  coreGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fill();

  // 3. 状态色辉光（核心向外扩散，给等离子体染色）
  const glowR = radius * 0.72;
  const glowGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  glowGrad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.60 * coreAmp})`);
  glowGrad.addColorStop(0.5, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.20 * coreAmp})`);
  glowGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 4. 湍流星云亮斑：绕核心缓慢公转的柔光斑（神秘的活体感，speaking 时随音量脉动）
  const layers = 4;
  const volBoost = activeState === "speaking" && bands ? bands.high * 0.04 : 0;
  for (let i = 0; i < layers; i++) {
    const angle = globalRotationAngle * 0.9 + i * (Math.PI * 2 / layers);
    const dist = radius * (0.30 + 0.13 * Math.sin(time * 0.045 + i * 2.1));
    const px = cx + Math.cos(angle) * dist;
    const py = cy + Math.sin(angle) * dist * 0.82;
    const blobR = radius * (0.28 + 0.12 * Math.sin(time * 0.06 + i * 1.9));
    const bA = 0.06 + 0.05 * Math.sin(time * 0.03 + i * 1.3) + volBoost;
    if (bA <= 0.01) continue;
    const blobGrad = ctx.createRadialGradient(px, py, 0, px, py, blobR);
    blobGrad.addColorStop(0, `rgba(${hrgb.r}, ${hrgb.g}, ${hrgb.b}, ${bA})`);
    blobGrad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = blobGrad;
    ctx.beginPath();
    ctx.arc(px, py, blobR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** 底部环境反光：球体下缘内侧的柔和环境光，让球体"坐"在环境里而非悬浮贴片 */
function drawBaseReflection(cx, cy, radius) {
  ctx.save();
  // 底部内反射：球体下缘内侧的柔和环境光，让球体"坐"在环境里而非悬浮贴片
  const g = ctx.createRadialGradient(
    cx, cy + radius * 0.72, radius * 0.05,
    cx, cy + radius * 0.95, radius * 0.72
  );
  g.addColorStop(0, "rgba(255, 255, 255, 0.20)");
  g.addColorStop(0.5, "rgba(255, 255, 255, 0.07)");
  g.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  // 地面接触阴影：球体正下方一道贴地暗影（与主光方向一致的椭球投影），
  // 强化「球浮在桌面上空」的空间感——立体感的另一半来自影子。
  const shadowG = ctx.createRadialGradient(
    cx, cy + radius * 1.02, radius * 0.04,
    cx, cy + radius * 0.98, radius * 0.82
  );
  shadowG.addColorStop(0, "rgba(0, 0, 0, 0.30)");
  shadowG.addColorStop(0.55, "rgba(0, 0, 0, 0.16)");
  shadowG.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = shadowG;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.06, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 初始化球内尘埃微粒：位置用半径比例，radius 变化无需重建 */
function ensureDust(radius) {
  if (dustInited || radius <= 0) return;
  dustInited = true;
  const count = 42;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.pow(Math.random(), 0.6) * radius * 0.82;
    dust.push({
      a,
      d,
      speed: 0.0025 + Math.random() * 0.006,
      wobbleAmp: 0.6 + Math.random() * 2.2,
      wobbleFreq: 0.05 + Math.random() * 0.09,
      size: 0.4 + Math.random() * 0.8,
      phase: Math.random() * Math.PI * 2,
      twinkle: 0.15 + Math.random() * 0.35,
    });
  }
}

/** 球内微观尘埃：低速公转 + 正弦摆动 + 微弱闪烁（深空微观感）。
 *  speaking 时随音量加速、亮度随高频闪烁，与表面火花呼应。 */
function drawNebulaDust(cx, cy, radius, activeState, bands) {
  const vol = activeState === "speaking" && bands ? bands.high : 0;
  const speedBoost = 1 + vol * 2.2;
  const twinkleBoost = 0.25 + vol * 0.55;
  ctx.save();
  for (let i = 0; i < dust.length; i++) {
    const p = dust[i];
    p.a += p.speed * 0.32 * speedBoost;
    const wob = Math.sin(time * 0.18 + p.phase) * p.wobbleAmp;
    const px = cx + Math.cos(p.a) * p.d + wob;
    const py = cy + Math.sin(p.a) * p.d * 0.9 + Math.cos(p.phase * 2) * 1.2;
    const twinkle = p.twinkle * (0.6 + 0.4 * Math.sin(time * 0.45 + p.phase * 3)) + twinkleBoost;
    if (twinkle <= 0.03) continue;
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = `rgba(215, 228, 255, ${twinkle})`;
    ctx.beginPath();
    ctx.arc(px, py, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 能量裂纹：状态切换时核心辐射的亮纹（神秘符文感），衰减后隐去；error 态持续脉动 */
function drawFracture(cx, cy, radius, activeState) {
  const hasFracture = fracture && fracture.age < fracture.maxAge;
  const isError = activeState === "error";
  if (!hasFracture && !isError) return;
  const palette = palettes[activeState] || palettes.idle;
  const hrgb = hexToRgb(palette.highlight);
  const frac = hasFracture ? 1 - fracture.age / fracture.maxAge : 0.55 + 0.35 * Math.sin(time * 1.2);
  if (frac <= 0.02) return;
  const count = isError ? 7 : 5;
  const baseAngle = time * 0.04;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < count; i++) {
    const a = baseAngle + i * (Math.PI * 2 / count) + Math.sin(time * 0.3 + i) * 0.12;
    const len = radius * (0.30 + 0.22 * Math.abs(Math.sin(time * 0.8 + i * 2.4)));
    const x0 = cx + Math.cos(a) * radius * 0.22;
    const y0 = cy + Math.sin(a) * radius * 0.22;
    const x1 = cx + Math.cos(a) * (radius * 0.22 + len);
    const y1 = cy + Math.sin(a) * (radius * 0.22 + len);
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, `rgba(${hrgb.r}, ${hrgb.g}, ${hrgb.b}, ${0.75 * frac})`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.strokeStyle = grad;
    ctx.lineWidth = 0.9;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.restore();
}

/** 玻璃折射扫描：一道极柔的斜向高光带缓慢横穿球体，模拟液态玻璃内部的光路 */
function drawGlassScan(cx, cy, radius, activeState) {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const t = (time * 0.10) % 2;
  const pos = t < 1 ? t : 2 - t;
  const x = cx - radius + pos * radius * 2;
  const g = ctx.createLinearGradient(x - radius * 0.30, 0, x + radius * 0.30, 0);
  const intensity = activeState === "speaking" ? 0.09 : 0.05;
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, `rgba(255,255,255,${intensity})`);
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 光标跟随高光：高光点随鼠标位置在球面漂移（Apple Vision 式材质视差） */
function drawCursorGlow(cx, cy, radius, activeState) {
  if (cursorGlowFade < 0.02) return;
  const palette = palettes[activeState] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  // 未 hover 时高光回落球心（与顶部高光叠加成柔和的核心辉光），hover 后跟随鼠标
  const gx = cursorGlowActive ? cursorGlowX : cx;
  const gy = cursorGlowActive ? cursorGlowY : cy;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, radius * 0.72);
  g.addColorStop(
    0,
    `rgba(${Math.floor(lerp(rgb.r, 255, 0.55))}, ${Math.floor(lerp(rgb.g, 255, 0.55))}, ${Math.floor(lerp(rgb.b, 255, 0.55))}, ${0.28 * cursorGlowFade})`
  );
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 色散边缘：球体边缘极细的红/蓝错位描边，模拟高折射玻璃的棱镜色散 */
function drawChromaticEdge(cx, cy, radius, activeState) {
  const palette = palettes[activeState] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.arc(cx - 0.55, cy, radius - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255, 70, 100, ${0.10 + rgb.r / 255 * 0.04})`;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + 0.55, cy, radius - 0.5, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(70, 150, 255, ${0.12 + rgb.b / 255 * 0.04})`;
  ctx.stroke();
  ctx.restore();
}

function drawNeonFilaments(cx, cy, radius, vol, activeState) {
  const palette = palettes[activeState] || palettes.idle;
  const colors = palette.filaments;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.translate(cx, cy);
  ctx.rotate(globalRotationAngle);
  ctx.translate(-cx, -cy);

  for (let i = 0; i < colors.length; i++) {
    const rgb = hexToRgb(colors[i]);
    const speedFactor = gaseousTime * (0.60 + i * 0.05) + i * 2.0;

    const drawPath = () => {
      ctx.beginPath();
      const points = 144;
      for (let j = 0; j <= points; j++) {
        const angle = (j / points) * Math.PI * 2;
        let wave1 = 0;
        let wave2 = 0;
        if (i === 0) {
          wave1 = Math.sin(angle * 3.0 + speedFactor * 1.3) * 5.6;
          wave2 = Math.cos(angle * 2.0 - speedFactor * 0.7) * 3.4;
        } else if (i === 1) {
          wave1 = Math.sin(angle * 4.0 - speedFactor * 0.9) * 4.5;
          wave2 = Math.cos(angle * 3.0 + speedFactor * 1.1) * 3.8;
        } else {
          wave1 = Math.sin(angle * 2.0 + speedFactor * 0.6) * 6.0;
          wave2 = Math.cos(angle * 5.0 - speedFactor * 1.4) * 3.0;
        }
        const waveVolume = (activeState === "speaking" || activeState === "listening") ? vol * 9.5 : 0;
        const r_base = radius * (0.81 - i * 0.04);
        const r = r_base + wave1 + wave2 + waveVolume * Math.sin(angle * 4.0 + gaseousTime * 4);
        const cos_tilt = (i === 0) ? 0.95 : 0.68;
        const x_local = Math.cos(angle) * r;
        const y_local = Math.sin(angle) * r * cos_tilt;
        const tilt_angle = (i === 0) ? -Math.PI / 12 : (i === 1 ? Math.PI / 3.2 : -Math.PI / 3.2);

        const x = cx + x_local * Math.cos(tilt_angle) - y_local * Math.sin(tilt_angle);
        const y = cy + x_local * Math.sin(tilt_angle) + y_local * Math.cos(tilt_angle);

        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    drawPath();
    ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    drawPath();
    // 3D 恒星点云已作为主体纹理，光丝降为暗背景极光（避免与点云叠加成噪点）
    const centerAlpha = (activeState === "speaking" || activeState === "listening") ? 0.42 + vol * 0.18 : 0.34;
    ctx.strokeStyle = `rgba(${Math.floor(lerp(rgb.r, 255, 0.45))}, ${Math.floor(lerp(rgb.g, 255, 0.45))}, ${Math.floor(lerp(rgb.b, 255, 0.45))}, ${centerAlpha})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function drawInnerShadow(cx, cy, radius, isDark) {
  const innerShadow = ctx.createRadialGradient(
    cx + radius * 0.05, cy + radius * 0.08, radius * 0.75,
    cx + radius * 0.08, cy + radius * 0.12, radius * 1.05
  );
  innerShadow.addColorStop(0, "rgba(0, 0, 0, 0)");
  innerShadow.addColorStop(0.8, "rgba(0, 0, 0, 0)");
  innerShadow.addColorStop(0.92, isDark ? "rgba(0, 0, 0, 0.04)" : "rgba(0, 0, 0, 0.01)");
  innerShadow.addColorStop(1, isDark ? "rgba(0, 0, 0, 0.12)" : "rgba(0, 0, 0, 0.04)");

  ctx.fillStyle = innerShadow;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

function drawGlassWallRefraction(cx, cy, radius) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1.2, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 2.0;
  ctx.stroke();

  const wallGrad = ctx.createRadialGradient(cx, cy, radius * 0.93, cx, cy, radius);
  wallGrad.addColorStop(0, "rgba(255, 255, 255, 0)");
  wallGrad.addColorStop(0.85, "rgba(255, 255, 255, 0.02)");
  wallGrad.addColorStop(1, "rgba(255, 255, 255, 0.12)");

  ctx.fillStyle = wallGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 3D 双轨道环：在真实 3D 空间倾斜的两条轨道，绕 Y 轴随球体自转（速度差形成相对运动），
 *  透视投影后呈现真实立体椭圆；远侧部分因深度暗化，近侧高亮——轨道不再是 2D 贴片，
 *  而是环绕球体的立体环带。带流动能量点与尾迹（speaking/listening 高亮）。 */
function draw3DOrbits(cx, cy, radius, activeState) {
  const palette = palettes[activeState] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  const hrgb = hexToRgb(palette.highlight);
  const active = activeState === "speaking" || activeState === "listening";
  const f = radius * 3.0;
  const segments = 96;

  const rings = [
    { tilt: -Math.PI / 10, radiusK: 1.14, speed: 0.5, phase: 0 },
    { tilt: Math.PI / 3.4, radiusK: 1.06, speed: -0.32, phase: Math.PI / 2 },
  ];

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri];
    const rr = radius * ring.radiusK;
    const ry = sphereRotY * ring.speed + ring.phase + tiltY * 0.5;
    const cosT = Math.cos(ring.tilt), sinT = Math.sin(ring.tilt);
    const cosY = Math.cos(ry), sinY = Math.sin(ry);

    const pts = [];
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      const cx0 = Math.cos(a) * rr;
      const cz = Math.sin(a) * rr;
      // tilt 绕 X 轴
      const y1 = -cz * sinT;
      const z1 = cz * cosT;
      // 绕 Y 自转
      const x2 = cx0 * cosY + z1 * sinY;
      const z2 = -cx0 * sinY + z1 * cosY;
      const depth = f / (f + z2);
      pts.push({ x: cx + x2 * depth, y: cy + y1 * depth, z: z2 });
    }
    // 远→近，让近侧线条盖住远侧，形成立体遮挡
    pts.sort((a, b) => a.z - b.z);

    // 分段绘制：远端弱、近端亮（深度立体感）
    for (let j = 1; j < pts.length; j++) {
      const depth01 = (pts[j].z + rr) / (2 * rr);
      const lineAlpha = (active ? 0.30 : 0.13) * (0.35 + depth01 * 0.65);
      ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${lineAlpha})`;
      ctx.lineWidth = (active ? 1.6 : 1.0) * (0.6 + depth01 * 0.4);
      ctx.beginPath();
      ctx.moveTo(pts[j - 1].x, pts[j - 1].y);
      ctx.lineTo(pts[j].x, pts[j].y);
      ctx.stroke();
    }

    // 流动能量点 + 尾迹
    if (active || activeState === "thinking") {
      const dots = active ? 5 : 3;
      const speed = active ? 0.30 : 0.14;
      for (let i = 0; i < dots; i++) {
        const headT = (time * speed + i / dots) % 1;
        const ha = headT * Math.PI * 2;
        const makeP = (ang) => {
          const cx0 = Math.cos(ang) * rr;
          const cz = Math.sin(ang) * rr;
          const y1 = -cz * sinT;
          const z1 = cz * cosT;
          const x2 = cx0 * cosY + z1 * sinY;
          const z2 = -cx0 * sinY + z1 * cosY;
          const depth = f / (f + z2);
          return { x: cx + x2 * depth, y: cy + y1 * depth, z: z2, depth };
        };
        const head = makeP(ha);
        ctx.fillStyle = `rgba(${hrgb.r}, ${hrgb.g}, ${hrgb.b}, ${active ? 0.95 : 0.7})`;
        ctx.beginPath();
        ctx.arc(head.x, head.y, 1.5 * head.depth, 0, Math.PI * 2);
        ctx.fill();
        for (let k = 1; k <= 4; k++) {
          const tt = headT - k * 0.05;
          if (tt < 0) continue;
          const tail = makeP(tt * Math.PI * 2);
          const alphaT = (1 - k / 5) * (active ? 0.55 : 0.3);
          ctx.fillStyle = `rgba(${hrgb.r}, ${hrgb.g}, ${hrgb.b}, ${alphaT})`;
          ctx.beginPath();
          ctx.arc(tail.x, tail.y, 1.5 * tail.depth * (1 - k * 0.15), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  ctx.restore();
}

/** 聆听声波涟漪：聆听中从球心向外扩散的光环，强化「正在收音」的感知 */
function drawRipples(cx, cy, radius, activeState) {
  if (activeState !== "listening") return;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 3; i++) {
    const phase = (time * 0.06 + i / 3) % 1;
    const r = radius * (0.15 + phase * 0.85);
    const alpha = (1 - phase) * 0.30;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(125, 205, 255, ${alpha})`;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
  ctx.restore();
}

function drawGlassHighlights(cx, cy, radius, activeState, isDark) {
  // 镜面高光点：左上偏上的小柔光斑，模拟单一光源在玻璃球面的直接反射（体积感关键）
  const sx = cx - radius * 0.36;
  const sy = cy - radius * 0.42;
  const specR = radius * 0.20;
  const specG = ctx.createRadialGradient(sx, sy, 0, sx, sy, specR);
  specG.addColorStop(0, "rgba(255,255,255,0.78)");
  specG.addColorStop(0.22, "rgba(255,255,255,0.34)");
  specG.addColorStop(0.6, "rgba(255,255,255,0.08)");
  specG.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.fillStyle = specG;
  ctx.beginPath();
  ctx.arc(sx, sy, specR, 0, Math.PI * 2);
  ctx.fill();

  // 高光核心小亮点：更小更锐的主反射点，让球面"材质"浮现
  const coreR = specR * 0.38;
  const coreG = ctx.createRadialGradient(sx, sy, 0, sx, sy, coreR);
  coreG.addColorStop(0, "rgba(255,255,255,0.95)");
  coreG.addColorStop(0.55, "rgba(255,255,255,0.35)");
  coreG.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = coreG;
  ctx.beginPath();
  ctx.arc(sx, sy, coreR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1.0, -Math.PI * 0.85, -Math.PI * 0.15);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1.2, Math.PI * 0.5, Math.PI * 0.95);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
  ctx.lineWidth = 1.0;
  ctx.stroke();
}

// ── 鼠标穿透智能判断（仅 macOS）──
// Windows 悬浮球可交互（点击打开设置/拖动），若动态切换穿透会在鼠标移出
// orb 后使窗口永久穿透、事件再无法接收，导致卡死。
// macOS 下 orb 与右侧文本区都是可交互区域，鼠标经过时取消穿透。
let isMouseOverInteractiveElement = false;
if (diriAPI.platform === "darwin") {
  window.addEventListener("mousemove", (e) => {
    const overOrb = isPointInElement(e.clientX, e.clientY, orbContainer);
    const overBadge = isPointInElement(e.clientX, e.clientY, document.getElementById("statusBadge"));
    const overText = asrTextEl && !asrTextEl.classList.contains("hidden") && isPointInElement(e.clientX, e.clientY, asrTextEl);
    const overLlm = llmOutputEl && !llmOutputEl.classList.contains("hidden") && isPointInElement(e.clientX, e.clientY, llmOutputEl);
    const isOverInteractive = overOrb || overBadge || overText || overLlm;
    if (isOverInteractive !== isMouseOverInteractiveElement) {
      isMouseOverInteractiveElement = isOverInteractive;
      diriAPI.setIgnoreMouse(!isMouseOverInteractiveElement);
    }
  });
}

// ── Windows 悬浮球拖动 ──
// 无边框窗口无系统拖拽条，-webkit-app-region: drag 会拦截 click，故用
// renderer 上报相对位移 + 主进程 setPosition 实现手动拖动。
// 拖动绑定在整个窗口上（orb 与右侧文本区均可拖动），避免文本区成为死角。
let isDragging = false;
let dragMoved = false;
let lastDragX = 0;
let lastDragY = 0;
if (diriAPI.platform !== "darwin") {
  window.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // 仅左键拖动，右键留给自绘菜单
    isDragging = true;
    dragMoved = false;
    lastDragX = e.screenX;
    lastDragY = e.screenY;
  });
  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.screenX - lastDragX;
    const dy = e.screenY - lastDragY;
    if (dx !== 0 || dy !== 0) {
      if (!dragMoved && (Math.abs(dx) + Math.abs(dy) > 4)) dragMoved = true;
      lastDragX = e.screenX;
      lastDragY = e.screenY;
      diriAPI.floatDrag(dx, dy);
    }
  });
  window.addEventListener("mouseup", () => {
    isDragging = false;
  });
}

function isPointInElement(x, y, el) {
  if (!el || el.style.display === "none" || el.style.opacity === "0" || el.classList.contains("hidden")) return false;
  const rect = el.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// 点击交互：
// - 说话中（speaking）：点击任意位置静音当前回答 → 进入 muted 待命态。
// - 已静音（muted）：点击任意位置重听被静音的最后回答（恢复播放）。
// - 空闲/思考/错误：点击 orb → 切换录音（开/关一轮语音会话）；
//   点击文本区 → 打开设置窗口。文本区承载 LLM 输出，避免与录音入口冲突。
// 双击 orb 在 standard/mini 间切换，双击的第二次 click 会被抑制不触发录音。
function spawnRipple() {
  if (!orbContainer) return;
  const el = document.createElement("div");
  el.className = "ripple";
  orbContainer.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}

// 单击/双击消歧：orb 区域的单击延迟 300ms 执行，若在窗口内再来一次 click 则
// 取消并交给 dblclick 处理。彻底解决「双击 orb 误触发录音」与形态切换不稳。
let pendingOrbClickTimer = null;
function cancelPendingOrbClick() {
  if (pendingOrbClickTimer) {
    clearTimeout(pendingOrbClickTimer);
    pendingOrbClickTimer = null;
  }
}
function handleOrbSingleClick() {
  pendingOrbClickTimer = null;
  if (dragMoved) return;
  spawnRipple();
  if (currentState === "listening") {
    diriAPI.stopRecording();
  } else {
    diriAPI.startRecording();
  }
}
function handleOrbDoubleClick() {
  cancelPendingOrbClick();
  if (dragMoved) return;
  spawnRipple();
  toggleFloatMode();
}

// ── 自绘右键菜单 ──
const floatMenuEl = document.getElementById("floatMenu");
function showFloatMenu(x, y) {
  if (!floatMenuEl) return;
  const menuW = 168, menuH = 220;
  const maxX = window.innerWidth - menuW - 4;
  const maxY = window.innerHeight - menuH - 4;
  floatMenuEl.style.left = Math.max(4, Math.min(x, maxX)) + "px";
  floatMenuEl.style.top = Math.max(4, Math.min(y, maxY)) + "px";
  floatMenuEl.classList.remove("hidden");
}
function hideFloatMenu() {
  if (floatMenuEl) floatMenuEl.classList.add("hidden");
}
// 菜单自身的事件不冒泡到 window（避免触发拖动/录音/开设置）
if (floatMenuEl) {
  ["mousedown", "mouseup", "click", "dblclick", "mousemove"].forEach((evt) => {
    floatMenuEl.addEventListener(evt, (e) => e.stopPropagation());
  });
  floatMenuEl.addEventListener("click", (e) => {
    const item = e.target.closest(".menu-item");
    if (!item) return;
    const action = item.getAttribute("data-action");
    if (action) diriAPI.floatMenuAction(action);
    hideFloatMenu();
  });
}
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  showFloatMenu(e.clientX, e.clientY);
});
// 左键点击菜单外任意处关闭菜单
window.addEventListener("mousedown", (e) => {
  if (e.button === 0) hideFloatMenu();
}, true);

// 点击交互：
// - 说话中（speaking）：点击任意位置静音当前回答 → 进入 muted 待命态（即时响应）。
// - 已静音（muted）：点击任意位置重听被静音的最后回答（即时响应）。
// - 空闲/思考/错误：单击 orb → 切换录音（延迟 300ms 消歧，不误触双击）；
//   双击 orb → standard/mini 切换（双击不触发录音）；
//   点击文本区 → 打开设置窗口。
window.addEventListener("click", (e) => {
  if (dragMoved) return; // 拖动后不当作点击
  // 说话/静音态的即时动作无双击冲突
  if (currentState === "speaking") {
    spawnRipple();
    diriAPI.muteCurrentTts();
    return;
  }
  if (currentState === "muted") {
    spawnRipple();
    diriAPI.replayCurrentTts();
    return;
  }
  const isOrb = isPointInElement(e.clientX, e.clientY, orbContainer);
  if (!isOrb) {
    // mini 形态下窗口即球体本身，球外透明区点击不动作（避免 Windows 下误开设置）
    if (currentFloatMode === "mini") return;
    // 文本区/空白：打开设置（取消在途的 orb 单击，防止误开录音）
    cancelPendingOrbClick();
    diriAPI.openSettings();
    return;
  }
  // orb 区域：第二击取消第一击的延迟动作，交给 dblclick；否则排程单击
  if (pendingOrbClickTimer) {
    cancelPendingOrbClick();
    return;
  }
  pendingOrbClickTimer = setTimeout(handleOrbSingleClick, 250);
});
window.addEventListener("dblclick", (e) => {
  if (dragMoved) return;
  cancelPendingOrbClick();
  if (isPointInElement(e.clientX, e.clientY, orbContainer)) {
    handleOrbDoubleClick();
  }
});

// 按压反馈（canvas 内缩放）：按下 orb 缩小、抬起恢复；右键不参与
window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (isPointInElement(e.clientX, e.clientY, orbContainer)) {
    isPointerDownOnOrb = true;
    spinBoost = 1.2; // 点击自转脉冲：球体受击加速旋转（3D 立体交互反馈）
  }
});
window.addEventListener("mouseup", () => {
  isPointerDownOnOrb = false;
});
window.addEventListener("mouseleave", () => {
  isPointerDownOnOrb = false;
});

// 初始状态色（避免首帧等待 IPC 事件才上色）
applyStateVisuals("idle");
resizeCanvas();
render();
