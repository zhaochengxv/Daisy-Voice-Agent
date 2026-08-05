/* global diriAPI */

const TARGET_SAMPLE_RATE = 16000;

let audioContext = null;
let mediaStream = null;
let source = null;
let processor = null;
let gainNode = null;
let isRecording = false;
let micReady = false;
let micInitPromise = null;
let resumeInterval = null;
let desiredRecording = false;
let operationGeneration = 0;
let wakeWordEnabled = false;
let shuttingDown = false;
let inputDeviceId = "";
let lastNonZeroLevelAt = 0;
let rebuildCooldownUntil = 0;
const SILENCE_REBUILD_MS = 4000;
const REBUILD_COOLDOWN_MS = 10000;

function logToMain(msg) {
  diriAPI.sendRendererLog("AUDIO_LOG: " + msg);
}

// Enumerate audio input devices (with labels) and report to main so the
// settings page can offer a recorder-device picker. Especially needed for
// Bluetooth headsets: the OS default input may be the laptop mic instead of
// the headset mic.
async function enumerateAudioInputs() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((d) => d.kind === "audioinput")
      .map((d) => ({ deviceId: d.deviceId || "default", label: d.label || "麦克风" }));
    if (inputs.length > 0) {
      logToMain("enumerateAudioInputs: " + JSON.stringify(inputs.map((i) => i.label)));
      diriAPI.reportAudioDevices(inputs);
    }
  } catch (err) {
    logToMain("enumerateAudioInputs failed: " + (err && err.message));
  }
}

// Reload the mic pipeline with the newly selected input device. Keeps the
// pending recording state so a mid-idle switch never drops an active session.
async function switchInputDevice(deviceId) {
  inputDeviceId = deviceId || "";
  logToMain("switchInputDevice: deviceId=" + inputDeviceId);
  const keepRecording = isRecording;
  const keepWanted = desiredRecording;
  releaseMic("input device switched");
  operationGeneration++;
  if (keepRecording || keepWanted || wakeWordEnabled) {
    try {
      await ensureMic();
      if (!shuttingDown) {
        isRecording = keepRecording || desiredRecording;
        if (isRecording) diriAPI.sendAudioReady();
      }
    } catch (err) {
      logToMain("switchInputDevice ensureMic failed: " + err.message);
      if (isRecording) {
        isRecording = false;
        diriAPI.sendAudioError("无法访问麦克风：" + err.message);
      }
    }
  }
  enumerateAudioInputs();
}

diriAPI.onAudioInputDeviceSet((deviceId) => {
  switchInputDevice(deviceId || "");
});

diriAPI.onAudioDevicesRefresh(() => {
  enumerateAudioInputs();
});

function downsampleBuffer(inputBuffer, inputSampleRate) {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return inputBuffer;
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const newLength = Math.round(inputBuffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < inputBuffer.length; i++) {
      accum += inputBuffer[i];
      count++;
    }

    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function floatTo16BitPCM(input) {
  const output = new ArrayBuffer(input.length * 2);
  const view = new DataView(output);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(output);
}

function uint8ToBase64(bytes) {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

let audioLogCounter = 0;

function releaseMic(reason) {
  const hadResources = Boolean(mediaStream || audioContext || source || processor || gainNode);
  if (hadResources) {
    logToMain("releaseMic: " + reason);
  }

  if (resumeInterval) {
    clearInterval(resumeInterval);
    resumeInterval = null;
  }

  if (processor) {
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch (_error) {}
  }
  if (source) {
    try { source.disconnect(); } catch (_error) {}
  }
  if (gainNode) {
    try { gainNode.disconnect(); } catch (_error) {}
  }
  // Mark mic not-ready BEFORE stopping tracks so the track.onended/onmute
  // self-heal handlers don't mistake an intentional release for a device drop.
  micReady = false;
  isRecording = false;
  if (mediaStream) {
    try {
      mediaStream.getTracks().forEach((track) => track.stop());
    } catch (_error) {}
  }

  const contextToClose = audioContext;
  audioContext = null;
  mediaStream = null;
  source = null;
  processor = null;
  gainNode = null;
  lastNonZeroLevelAt = 0;

  if (contextToClose && contextToClose.state !== "closed") {
    contextToClose.close().catch((error) => {
      logToMain("releaseMic: failed to close AudioContext: " + error.message);
    });
  }
}

async function ensureMic() {
  if (micReady && audioContext && mediaStream) return true;
  if (micInitPromise) return micInitPromise;

  const initPromise = (async () => {
    let newStream = null;
    let newContext = null;
    let newSource = null;
    let newProcessor = null;
    let newGain = null;

    try {
      logToMain("ensureMic: requesting getUserMedia deviceId=" + (inputDeviceId || "default"));
      // Bluetooth HFP headsets bring their own hardware echo-cancel/gain; when
      // Chromium layers software AEC/AGC/NS on top, the two adaptive filters
      // fight and the input collapses to near-silence (observed as maxLevel≈0.0003
      // even though the OS mic test is loud). Detection below re-acquires with
      // processing disabled for Bluetooth endpoints.
      const buildConstraints = (processing) => {
        const c = {
          channelCount: 1,
          echoCancellation: processing,
          noiseSuppression: processing,
          autoGainControl: processing,
        };
        if (inputDeviceId) {
          c.deviceId = { exact: inputDeviceId };
        }
        return c;
      };
      const acquireStream = async (processing) => {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: buildConstraints(processing) });
        } catch (gumError) {
          // Selected device is gone (e.g. headset unplugged). Fall back to the
          // OS default instead of failing the whole session.
          if (inputDeviceId) {
            logToMain("ensureMic: selected device failed (" + gumError.message + "), falling back to default");
            inputDeviceId = "";
            return await navigator.mediaDevices.getUserMedia({
              audio: { channelCount: 1, echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing },
            });
          }
          throw gumError;
        }
      };

      newStream = await acquireStream(true);
      const firstTrack = newStream.getAudioTracks()[0];
      const deviceLabel = (firstTrack && firstTrack.label) || "";
      if (firstTrack && /bluetooth/i.test(deviceLabel)) {
        logToMain("ensureMic: bluetooth input detected (" + deviceLabel + "), retrying without AEC/AGC/NS");
        newStream.getTracks().forEach((track) => track.stop());
        newStream = await acquireStream(false);
      }

      // Device-level self-heal: if the OS stream ends or is muted (headset
      // unplugged / Bluetooth renegotiation / driver hiccup), rebuild the whole
      // pipeline instead of silently feeding digital zeros to ASR sessions.
      newStream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (!micReady || shuttingDown) return;
          logToMain("ensureMic: audio track ended unexpectedly, rebuilding");
          rebuildMic("audio track ended unexpectedly");
        };
        track.onmute = () => {
          if (!micReady || shuttingDown) return;
          logToMain("ensureMic: audio track muted unexpectedly, rebuilding");
          rebuildMic("audio track muted unexpectedly");
        };
      });

      newContext = new AudioContext({ sampleRate: 48000 });
      newSource = newContext.createMediaStreamSource(newStream);

      const bufferSize = 4096;
      newProcessor = newContext.createScriptProcessor(bufferSize, 1, 1);
      newGain = newContext.createGain();
      newGain.gain.value = 0.0001;

      // Capture the context locally so a later cleanup cannot make this
      // callback dereference a different generation's global AudioContext.
      const inputSampleRate = newContext.sampleRate;
      newProcessor.onaudioprocess = (event) => {
        if (!isRecording && !wakeWordEnabled) return;
        const inputData = event.inputBuffer.getChannelData(0);

        let max = 0;
        for (let i = 0; i < inputData.length; i++) {
          const abs = Math.abs(inputData[i]);
          if (abs > max) max = abs;
        }
        if (max > 0) lastNonZeroLevelAt = Date.now();

        audioLogCounter++;
        if (audioLogCounter % 100 === 0) {
          logToMain("audio flowing: " + audioLogCounter + " frames, maxLevel=" + max.toFixed(4));
        }

        // Self-heal: an active recording session expects the user's voice, so
        // sustained exact-digital-silence while recording means the pipeline
        // died (Bluetooth AEC collapse / device hang). Rebuild it once.
        if (isRecording && lastNonZeroLevelAt > 0) {
          const silentMs = Date.now() - lastNonZeroLevelAt;
          if (silentMs >= SILENCE_REBUILD_MS) {
            logToMain("digital silence during recording for " + silentMs + "ms, rebuilding mic pipeline");
            lastNonZeroLevelAt = 0;
            rebuildMic("digital silence during recording");
          }
        }

        const downsampled = downsampleBuffer(inputData, inputSampleRate);
        const pcm = floatTo16BitPCM(downsampled);
        diriAPI.sendAudioData(uint8ToBase64(pcm));
      };

      newSource.connect(newProcessor);
      newProcessor.connect(newGain);
      newGain.connect(newContext.destination);

      mediaStream = newStream;
      audioContext = newContext;
      source = newSource;
      processor = newProcessor;
      gainNode = newGain;
      micReady = true;
      logToMain("ensureMic: mic acquired and pipeline ready");

      if (newContext.state === "suspended") {
        await newContext.resume();
        logToMain("ensureMic: resumed suspended AudioContext");
      }

      // releaseMic 可能在 resume() 挂起期间执行并将 audioContext 置空，
      // 此时放弃本次初始化，避免残留空转 interval。
      if (audioContext !== newContext) {
        return false;
      }

      if (resumeInterval) clearInterval(resumeInterval);
      resumeInterval = setInterval(() => {
        if (audioContext && audioContext.state === "suspended") {
          audioContext.resume().catch(() => {});
          logToMain("ensureMic: resumed suspended AudioContext (periodic check)");
        }
      }, 5000);

      if (shuttingDown || (!desiredRecording && !wakeWordEnabled)) {
        releaseMic(shuttingDown ? "window shutting down" : "pending start was cancelled");
        return false;
      }

      return true;
    } catch (error) {
      if (newProcessor) {
        newProcessor.onaudioprocess = null;
        try { newProcessor.disconnect(); } catch (_disconnectError) {}
      }
      if (newSource) {
        try { newSource.disconnect(); } catch (_disconnectError) {}
      }
      if (newGain) {
        try { newGain.disconnect(); } catch (_disconnectError) {}
      }
      if (newStream) {
        try { newStream.getTracks().forEach((track) => track.stop()); } catch (_stopError) {}
      }
      if (newContext && newContext.state !== "closed") {
        newContext.close().catch(() => {});
      }
      throw error;
    }
  })();

  micInitPromise = initPromise;
  try {
    return await initPromise;
  } finally {
    if (micInitPromise === initPromise) {
      micInitPromise = null;
    }
  }
}

async function rebuildMic(reason) {
  const now = Date.now();
  if (now < rebuildCooldownUntil) return;
  rebuildCooldownUntil = now + REBUILD_COOLDOWN_MS;
  logToMain("rebuildMic: " + reason);
  const keepRecording = isRecording;
  const keepWanted = desiredRecording;
  const keepWake = wakeWordEnabled;
  releaseMic("mic self-heal rebuild: " + reason);
  operationGeneration++;
  if (keepRecording || keepWanted || keepWake) {
    try {
      await ensureMic();
      if (!shuttingDown) {
        isRecording = keepRecording || desiredRecording;
        if (isRecording) diriAPI.sendAudioReady();
      }
    } catch (err) {
      logToMain("rebuildMic ensureMic failed: " + err.message);
      if (isRecording) {
        isRecording = false;
        diriAPI.sendAudioError("麦克风恢复失败：" + err.message);
      }
    }
  }
}

async function setWakeWordEnabled(enabled) {
  wakeWordEnabled = enabled;
  logToMain("setWakeWordEnabled: enabled=" + enabled + " isRecording=" + isRecording);

  if (!enabled) {
    if (!desiredRecording && !isRecording) {
      releaseMic("wake-word monitoring disabled");
    }
    return;
  }

  if (!shuttingDown) {
    try {
      await ensureMic();
    } catch (error) {
      logToMain("setWakeWordEnabled: wake-word mic start failed: " + error.message);
      diriAPI.sendAudioError("无法访问麦克风：" + error.message);
    }
  }
}

async function startRecording() {
  const myGeneration = ++operationGeneration;
  desiredRecording = true;
  logToMain("startRecording: generation=" + myGeneration + " isRecording=" + isRecording + " micReady=" + micReady);

  // Baseline the silence watchdog: a session that yields no audio for
  // SILENCE_REBUILD_MS while recording triggers a pipeline rebuild.
  lastNonZeroLevelAt = Date.now();

  try {
    const ready = await ensureMic();
    if (myGeneration !== operationGeneration || !desiredRecording || shuttingDown) return;
    if (!ready || !micReady) {
      throw new Error("麦克风初始化已取消");
    }

    isRecording = true;
    logToMain("startRecording: ready generation=" + myGeneration);
    diriAPI.sendAudioReady();
  } catch (error) {
    if (myGeneration !== operationGeneration || !desiredRecording || shuttingDown) return;
    desiredRecording = false;
    isRecording = false;
    releaseMic("recording start failed");
    logToMain("startRecording FAILED: " + error.message);
    diriAPI.sendAudioError("无法访问麦克风：" + error.message);
  }
}

function stopRecording() {
  const myGeneration = ++operationGeneration;
  logToMain("stopRecording: generation=" + myGeneration + " isRecording=" + isRecording + " micReady=" + micReady);
  desiredRecording = false;
  isRecording = false;

  if (!wakeWordEnabled) {
    releaseMic("recording stopped");
  }

  // Always acknowledge STOP, including cancellation during getUserMedia.
  // The in-flight initializer checks desiredRecording before publishing READY.
  diriAPI.sendAudioStopped();
}

diriAPI.onStartRecording(() => {
  startRecording();
});

diriAPI.onStopRecording(() => {
  stopRecording();
});

diriAPI.onWakeWordEnabled((enabled) => {
  setWakeWordEnabled(Boolean(enabled));
});

window.addEventListener("load", () => {
  enumerateAudioInputs();
  // Re-enumerate after mic permission is granted so device labels populate.
  setTimeout(enumerateAudioInputs, 2000);
});

window.onerror = (message, source, lineno, colno, error) => {
  diriAPI.sendRendererError(`audio.js error: ${message} at ${source}:${lineno}:${colno} ${error?.stack || ""}`);
};

window.onunhandledrejection = (event) => {
  diriAPI.sendRendererError(`audio.js unhandled rejection: ${event.reason}`);
};

window.addEventListener("beforeunload", () => {
  shuttingDown = true;
  operationGeneration++;
  desiredRecording = false;
  releaseMic("window unloading");
});
