const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FFMPEG_RELEASE_TAG = "b6.1.1";
const FFMPEG_ASSET = "ffmpeg-win32-x64";
const FFMPEG_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE_TAG}/${FFMPEG_ASSET}`;
const CACHE_DIR = path.join(os.homedir(), ".cache", "daisy-ffmpeg");
const CACHE_FILE = path.join(CACHE_DIR, `${FFMPEG_ASSET}.exe`);

function download(url, dest) {
  execSync(`curl -fsSL -o "${dest}" "${url}"`, { stdio: "inherit" });
}

/** 确保 Windows 包内含 win32 ffmpeg.exe（ffmpeg-static 按平台分发，Linux 上 npm install 只有 Linux 版） */
async function ensureWinFfmpeg(context) {
  const unpackedDir = path.join(context.appOutDir, "resources", "app.asar.unpacked", "node_modules", "ffmpeg-static");
  const target = path.join(unpackedDir, "ffmpeg.exe");
  if (!fs.existsSync(target)) {
    if (!fs.existsSync(CACHE_FILE)) {
      console.log(`[adhoc-sign] downloading win32 ffmpeg to ${CACHE_FILE}`);
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      download(FFMPEG_URL, CACHE_FILE);
    }
    console.log(`[adhoc-sign] injecting ${FFMPEG_ASSET}.exe into win package`);
    fs.copyFileSync(CACHE_FILE, target);
  }
  const linuxBin = path.join(unpackedDir, "ffmpeg");
  if (fs.existsSync(linuxBin)) {
    fs.rmSync(linuxBin, { force: true });
  }
}

exports.default = async function (context) {
  if (context.packager.platform.name === "windows") {
    await ensureWinFfmpeg(context);
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
