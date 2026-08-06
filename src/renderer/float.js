/* global diriAPI */

// ── 状态色板 ──
const palettes = {
  idle: {
    main: "#6C6EF5",
    mid: "#30268a",
    dark: "#140c38",
    deepDark: "#0d0728",
    highlight: "#C5C1FF",
    glow: "rgba(108, 110, 245, 0.45)",
    label: "待命",
    glowOpacity: 0.22,
    filaments: ["#6C6EF5", "#EC4899", "#8B5CF6"],
    blobs: ["#6C6EF5", "#8B5CF6", "#EC4899"],
    linearGradient: {
      topLeft: "rgba(108, 110, 245, 0.85)",
      middle: "rgba(139, 92, 246, 0.50)",
      bottomRight: "rgba(236, 72, 153, 0.20)"
    }
  },
  listening: {
    main: "#00A2FF",
    mid: "#184594",
    dark: "#0a1738",
    deepDark: "#02071a",
    highlight: "#B8DBFF",
    glow: "rgba(0, 162, 255, 0.55)",
    label: "聆听中",
    glowOpacity: 0.34,
    filaments: ["#00A2FF", "#38BDF8", "#7DD3FC"],
    blobs: ["#00A2FF", "#38BDF8", "#7DD3FC"],
    linearGradient: {
      topLeft: "rgba(0, 162, 255, 0.85)",
      middle: "rgba(56, 189, 248, 0.50)",
      bottomRight: "rgba(125, 211, 252, 0.20)"
    }
  },
  thinking: {
    main: "#FF8033",
    mid: "#9e4313",
    dark: "#3d1404",
    deepDark: "#1a0600",
    highlight: "#FFE0C0",
    glow: "rgba(255, 128, 51, 0.55)",
    label: "思考中",
    glowOpacity: 0.34,
    filaments: ["#FF8033", "#FF9955", "#FFBB77"],
    blobs: ["#FF8033", "#FF9955", "#FFBB77"],
    linearGradient: {
      topLeft: "rgba(255, 128, 51, 0.90)",
      middle: "rgba(255, 128, 51, 0.60)",
      bottomRight: "rgba(255, 128, 51, 0.22)"
    }
  },
  speaking: {
    main: "#0FC882",
    mid: "#0e5a37",
    dark: "#032112",
    deepDark: "#010d06",
    highlight: "#B0FFD4",
    glow: "rgba(15, 200, 130, 0.55)",
    label: "播报中",
    glowOpacity: 0.34,
    filaments: ["#0FC882", "#19D291", "#37EBB4"],
    blobs: ["#0FC882", "#19D291", "#37EBB4"],
    linearGradient: {
      topLeft: "rgba(15, 200, 130, 0.82)",
      middle: "rgba(25, 210, 145, 0.48)",
      bottomRight: "rgba(55, 235, 180, 0.18)"
    }
  },
  error: {
    main: "#F56060",
    mid: "#8a1b1b",
    dark: "#380606",
    deepDark: "#170101",
    highlight: "#FFC0C0",
    glow: "rgba(245, 96, 96, 0.55)",
    label: "出错",
    glowOpacity: 0.34,
    filaments: ["#EF4444", "#FBBF24", "#EC4899"],
    blobs: ["#F56060", "#DC2626", "#8B5CF6"],
    linearGradient: {
      topLeft: "rgba(245, 96, 96, 0.85)",
      middle: "rgba(239, 68, 68, 0.50)",
      bottomRight: "rgba(251, 191, 36, 0.20)"
    }
  },
  muted: {
    main: "#8B8DA8",
    mid: "#4a4c66",
    dark: "#1c1d2e",
    deepDark: "#0d0e17",
    highlight: "#D6D7EA",
    glow: "rgba(139, 141, 168, 0.40)",
    label: "已静音",
    glowOpacity: 0.22,
    filaments: ["#8B8DA8", "#A7A9C4", "#5B5D7A"],
    blobs: ["#8B8DA8", "#6C6EF5", "#A7A9C4"],
    linearGradient: {
      topLeft: "rgba(139, 141, 168, 0.85)",
      middle: "rgba(108, 110, 245, 0.45)",
      bottomRight: "rgba(74, 76, 102, 0.30)"
    }
  }
};

const targetConfigs = {
  idle:      { speed: 0.35, spread: 0.46, pulse: 0.04, rotation: 0.06 },
  listening: { speed: 0.45, spread: 0.52, pulse: 0.06, rotation: 0.09 },
  thinking:  { speed: 0.65, spread: 0.40, pulse: 0.05, rotation: 0.14 },
  speaking:  { speed: 0.50, spread: 0.48, pulse: 0.08, rotation: 0.08 },
  error:     { speed: 0.70, spread: 0.55, pulse: 0.10, rotation: 0.18 },
  muted:     { speed: 0.22, spread: 0.38, pulse: 0.03, rotation: 0.04 }
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

// 状态切换冲击波（一次性的能量涟漪，渲染循环中衰减扩散）
let pulses = [];
// speaking 表面能量粒子（随高频音量闪烁漂移）
let sparkles = [];
let lastVisualState = null;

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

  // 状态真正变化时：徽标弹入 + 球体能量冲击波（同一状态重复通知不重复触发）
  if (lastVisualState !== state) {
    if (statusBadgeEl) {
      statusBadgeEl.classList.remove("pop");
      void statusBadgeEl.offsetWidth; // 强制重排以重启动画
      statusBadgeEl.classList.add("pop");
    }
    pulses.push({ age: 0, maxAge: 1.05, color: palette.main });
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
  orbScale = lerp(orbScale, baseScale * breath, 0.04);
  wakeScale = lerp(wakeScale, targetWakeScale, 0.04);

  let shakeX = 0, shakeY = 0;
  if (currentState === 'error') {
    shakeX = Math.sin(time * 65) * 2.5;
    shakeY = Math.cos(time * 55) * 2.5;
  }

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.scale(dpr, dpr);
  ctx.translate(w / 2 + shakeX, h / 2 + shakeY + slideOffset);
  ctx.scale(orbScale * wakeScale, orbScale * wakeScale);
  ctx.translate(-w / 2, -h / 2);

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 6;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  drawSphereBase(cx, cy, radius, currentState);
  drawNeonFilaments(cx, cy, radius, bands.mid, currentState);
  drawOrbitRing(cx, cy, radius, currentState);
  drawRipples(cx, cy, radius, currentState);
  drawInnerShadow(cx, cy, radius, isDark);
  drawGlassWallRefraction(cx, cy, radius);

  ctx.restore();

  drawGlassHighlights(cx, cy, radius, currentState, isDark);
  ctx.restore();

  // 状态冲击波：能量涟漪从球心冲出球体（clip 外绘制，不被球面裁切）
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
    ctx.beginPath();
    ctx.arc(cx, cy, pr, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${prgb.r}, ${prgb.g}, ${prgb.b}, ${pa})`;
    ctx.lineWidth = 2.4 * (1 - prog) + 0.6;
    ctx.stroke();
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

function drawSphereBase(cx, cy, radius, activeState) {
  const palette = palettes[activeState] || palettes.idle;

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();

  const baseGrad = ctx.createLinearGradient(
    cx - radius, cy - radius,
    cx + radius, cy + radius
  );

  baseGrad.addColorStop(0, palette.linearGradient.topLeft);
  baseGrad.addColorStop(0.5, palette.linearGradient.middle);
  baseGrad.addColorStop(1, palette.linearGradient.bottomRight);

  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
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
    const centerAlpha = (activeState === "speaking" || activeState === "listening") ? 0.70 + vol * 0.25 : 0.62;
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

/** 行星环光带：斜穿球体的科技光环（与应用图标视觉语言统一），speaking/listening 时高亮 */
function drawOrbitRing(cx, cy, radius, activeState) {
  const active = activeState === "speaking" || activeState === "listening";
  const palette = palettes[activeState] || palettes.idle;
  const rgb = hexToRgb(palette.main);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 10);
  const rx = radius * 1.12, ry = radius * 0.42;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${active ? 0.5 : 0.22})`;
  ctx.lineWidth = active ? 2.8 : 1.5;
  ctx.stroke();
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
function spawnRipple() {
  if (!orbContainer) return;
  const el = document.createElement("div");
  el.className = "ripple";
  orbContainer.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}
window.addEventListener("click", (e) => {
  if (dragMoved) return; // 拖动后不当作点击
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
  if (isOrb) {
    spawnRipple();
    if (currentState === "listening") {
      diriAPI.stopRecording();
    } else {
      diriAPI.startRecording();
    }
  } else {
    diriAPI.openSettings();
  }
});

// 按压反馈：鼠标按下 orb 时按压缩实（放大缩小阻尼），抬起恢复
window.addEventListener("mousedown", (e) => {
  if (isPointInElement(e.clientX, e.clientY, orbContainer)) {
    orbContainer.classList.add("pressed");
  }
});
window.addEventListener("mouseup", () => {
  orbContainer.classList.remove("pressed");
});

// 初始状态色（避免首帧等待 IPC 事件才上色）
applyStateVisuals("idle");
resizeCanvas();
render();
