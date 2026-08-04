const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FFMPEG_RELEASE_TAG = "b6.1.1";
const FFMPEG_ASSET = "ffmpeg-win32-x64";
const FFMPEG_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE_TAG}/${FFMPEG_ASSET}`;
const FFMPEG_CACHE_DIR = path.join(os.homedir(), ".cache", "daisy-ffmpeg");
const FFMPEG_CACHE_FILE = path.join(FFMPEG_CACHE_DIR, `${FFMPEG_ASSET}.exe`);

// whisper.cpp v1.9.2 官方 Release。核心文件：whisper-cli.exe + ggml/whisper DLL（同目录依赖）
const WHISPER_VERSION = "v1.9.2";
const WHISPER_ASSET = "whisper-bin-x64.zip";
const WHISPER_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/${WHISPER_ASSET}`;
const WHISPER_CACHE_DIR = path.join(os.homedir(), ".cache", "daisy-whisper");
const WHISPER_CACHE_FILE = path.join(WHISPER_CACHE_DIR, WHISPER_ASSET);
const WHISPER_FILES = [
  "whisper-cli.exe",
  "whisper.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-cpu-x64.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-cascadelake.dll",
];

function download(url, dest) {
  execSync(`curl -fsSL -o "${dest}" "${url}"`, { stdio: "inherit" });
}

function ensureCache(cacheFile, url, cacheDir) {
  if (fs.existsSync(cacheFile)) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  console.log(`[adhoc-sign] downloading ${path.basename(cacheFile)} to ${cacheFile}`);
  download(url, cacheFile);
}

/** 确保 Windows 包内含 win32 ffmpeg.exe（ffmpeg-static 按平台分发，Linux 上 npm install 只有 Linux 版） */
async function ensureWinFfmpeg(context) {
  const unpackedDir = path.join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules", "ffmpeg-static");
  const target = path.join(unpackedDir, "ffmpeg.exe");
  if (!fs.existsSync(target)) {
    ensureCache(FFMPEG_CACHE_FILE, FFMPEG_URL, FFMPEG_CACHE_DIR);
    console.log(`[adhoc-sign] injecting ${FFMPEG_ASSET}.exe into win package`);
    fs.copyFileSync(FFMPEG_CACHE_FILE, target);
  }
  const linuxBin = path.join(unpackedDir, "ffmpeg");
  if (fs.existsSync(linuxBin)) {
    fs.rmSync(linuxBin, { force: true });
  }
}

/** 确保 Windows 包内 assets/bin 含 whisper-cli.exe 及依赖 DLL（唤醒词开箱即用） */
async function ensureWinWhisper(context) {
  const binDir = path.join(context.appOutDir, "resources", "app.asar.unpacked", "assets", "bin");
  const target = path.join(binDir, "whisper-cli.exe");
  if (fs.existsSync(target)) return;

  ensureCache(WHISPER_CACHE_FILE, WHISPER_URL, WHISPER_CACHE_DIR);
  fs.mkdirSync(binDir, { recursive: true });

  const extractDir = path.join(os.tmpdir(), `daisy-whisper-extract-${process.pid}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  // 用系统解压工具解压 zip（Node 无内置 zip）：7za（electron-builder 缓存）/ unzip / python3
  const bin = require("node:child_process");
  const candidates = [];
  for (const base of ["7za", "7z", "unzip"]) {
    try { bin.execSync(`which ${base}`, { stdio: "ignore" }); candidates.push(base); } catch { /* continue */ }
  }
  if (candidates.length === 0) {
    try { bin.execSync("which python3", { stdio: "ignore" }); candidates.push("python3"); } catch { /* continue */ }
  }
  if (candidates.length === 0) {
    throw new Error("no zip extractor found (7za/7z/unzip/python3) for whisper inject");
  }

  const tool = candidates[0];
  if (tool === "python3") {
    const script = `
import zipfile, os, sys
z = zipfile.ZipFile(r"${WHISPER_CACHE_FILE}")
files = ${JSON.stringify(WHISPER_FILES)}
os.makedirs(r"${extractDir}", exist_ok=True)
for n in files:
    z.extract("Release/" + n, r"${extractDir}")
`;
    fs.writeFileSync(path.join(extractDir, "extract.py"), script);
    execSync(`python3 ${path.join(extractDir, "extract.py")}`, { stdio: "inherit" });
  } else {
    execSync(`"${tool}" x -y -o"${extractDir}" "${WHISPER_CACHE_FILE}"`, { stdio: "inherit" });
  }

  for (const name of WHISPER_FILES) {
    const src = path.join(extractDir, "Release", name);
    if (!fs.existsSync(src)) {
      console.error(`[adhoc-sign] missing expected file in whisper archive: ${name}`);
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(binDir, name));
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
  console.log(`[adhoc-sign] injected whisper-cli.exe + ${WHISPER_FILES.length - 1} DLLs into assets/bin`);
}

exports.default = async function (context) {
  if (context.packager.platform.name === "windows") {
    await ensureWinFfmpeg(context);
    await ensureWinWhisper(context);
    return;
  }
  if (context.packager.platform.name !== "mac") {
    console.log("[adhoc-sign] skipping (non-mac/non-win platform)");
    return;
  }
  const appName = context.packager.appInfo.productName;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`\n[adhoc-sign] ad-hoc signing ${appPath}`);
  execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: "inherit" });
  console.log("[adhoc-sign] done");
};
