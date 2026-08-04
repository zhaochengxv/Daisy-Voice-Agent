const { execSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function (context) {
  if (context.packager.platform.name !== "mac") {
    // codesign 仅用于 macOS；Windows 构建无需签名
    console.log("[adhoc-sign] skipping (non-mac platform)");
    return;
  }
  const appName = context.packager.appInfo.productName;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`\n[adhoc-sign] ad-hoc signing ${appPath}`);
  execSync(`codesign --deep --force --sign - "${appPath}"`, { stdio: "inherit" });
  console.log("[adhoc-sign] done");
};
