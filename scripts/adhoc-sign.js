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

// yt-dlp 官方 Windows 单文件构建（downloadMedia 在 Windows 上与 macOS 共用实现，依赖 yt-dlp.exe）
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const YTDLP_CACHE_DIR = path.join(os.homedir(), ".cache", "daisy-ytdlp");
const YTDLP_CACHE_FILE = path.join(YTDLP_CACHE_DIR, "yt-dlp.exe");

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

  // 清理随 assets/** 混入的 macOS 二进制（Mach-O），Windows 上永不调用
  for (const macBin of ["whisper-cli", "SwitchAudioSource", "yt-dlp"]) {
    const p = path.join(binDir, macBin);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      console.log(`[adhoc-sign] removed macos binary from win package: ${macBin}`);
    }
  }

  const target = path.join(binDir, "whisper-cli.exe");
  if (fs.existsSync(target)) return;

  ensureCache(WHISPER_CACHE_FILE, WHISPER_URL, WHISPER_CACHE_DIR);
  fs.mkdirSync(binDir, { recursive: true });

  const extractDir = path.join(os.tmpdir(), `daisy-whisper-extract-${process.pid}`);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });

  // 用系统解压工具解压 zip（Node 无内置 zip）。python3 优先（macOS/Linux 均预装），
  // 其次 7za/7z（`x -y -o<dir>`），最后 unzip（`-o -d <dir>`，参数语法不同）
  const bin = require("node:child_process");
  let tool = null;
  try { bin.execSync("which python3", { stdio: "ignore" }); tool = "python3"; } catch { /* continue */ }
  if (!tool) {
    for (const base of ["7za", "7z"]) {
      try { bin.execSync(`which ${base}`, { stdio: "ignore" }); tool = base; break; } catch { /* continue */ }
    }
  }
  if (!tool) {
    try { bin.execSync("which unzip", { stdio: "ignore" }); tool = "unzip"; } catch { /* continue */ }
  }
  if (!tool) {
    throw new Error("no zip extractor found (python3/7za/7z/unzip) for whisper inject");
  }

  if (tool === "python3") {
    const script = `
import zipfile, os
z = zipfile.ZipFile(r"${WHISPER_CACHE_FILE}")
files = ${JSON.stringify(WHISPER_FILES)}
os.makedirs(r"${extractDir}", exist_ok=True)
for n in files:
    z.extract("Release/" + n, r"${extractDir}")
`;
    fs.writeFileSync(path.join(extractDir, "extract.py"), script);
    execSync(`python3 ${path.join(extractDir, "extract.py")}`, { stdio: "inherit" });
  } else if (tool === "unzip") {
    execSync(`unzip -o -q "${WHISPER_CACHE_FILE}" -d "${extractDir}"`, { stdio: "inherit" });
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

/** 确保 Windows 包内 assets/bin 含 yt-dlp.exe（download_media 跨平台共用实现，Windows 无此 exe 则 spawn 失败） */
async function ensureWinYtDlp(context) {
  const binDir = path.join(context.appOutDir, "resources", "app.asar.unpacked", "assets", "bin");
  const target = path.join(binDir, "yt-dlp.exe");
  if (fs.existsSync(target)) return;

  ensureCache(YTDLP_CACHE_FILE, YTDLP_URL, YTDLP_CACHE_DIR);
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(YTDLP_CACHE_FILE, target);
  fs.chmodSync(target, 0o755);
  console.log("[adhoc-sign] injected yt-dlp.exe into assets/bin");
}

exports.default = async function (context) {
  if (context.packager.platform.name === "windows") {
    await ensureWinFfmpeg(context);
    await ensureWinWhisper(context);
    await ensureWinYtDlp(context);
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
