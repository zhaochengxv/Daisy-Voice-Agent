# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[User Instruction Summary]
- Date: 2026-08-04
- Context: 审查修复完成后，用户连续多次回复「你决定」
- Instructions:
  - 当用户回复「你决定」时，表示将后续决策权委托给 Agent，应按最优路径自主推进（决策并执行、验证、提交推送），无需再向用户确认或询问下一步选择。
  - 决策落地后给出简短结果总结即可。

[Project Knowledge Summary]
- Date: 2026-08-04
- Context: Discovered by Agent while performing Windows 适配与 PowerShell 脚本验证
- Category: Build Methods / Troubleshooting & Debugging / Environment Configuration
- Instructions:
  - Linux 沙箱无 macOS/Windows 真机、无 osascript/PowerShell/扬声器，只能保证「编译 + 单测 + 平台分派逻辑正确」；Windows API 运行时行为（剪贴板/user32/COM）必须靠 `.monkeycode/docs/windows-smoke-test.md` 真机冒烟，勿向用户承诺已验证可用。
  - 无 libicu 的 Linux 跑 pwsh 需设 `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`；pwsh 可从 GitHub releases 下载 tar.gz 解压即用（/tmp/pwsh），用于 `node scripts/check-ps.js` 校验 windows.ts 全部 PowerShell 脚本语法。

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while performing whisper 超时修复与 Windows 交叉打包（v1.5.5）
- Category: Build Methods / Troubleshooting & Debugging
- Instructions:
  - 本沙箱 wine 8.0 已损坏：前缀初始化时 RpcSs 无法启动（OLE ifstub 报错 + `start_rpcss Failed`），任何原生 PE 均 exit 53/c0000135，`npm run dist:win` 的 NSIS 步骤必挂「wine process failed」。不要浪费时间修 wine。
  - 打包绕法：本地补丁 `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js`，把 NSIS uninstaller 提取逻辑改为优先 `UninstallerReader.exec(installerPath, uninstallerPath)`（纯 JS 解析，macOS 同款），wine 仅作兜底。注意 `npm ci` 后补丁丢失，需重打。
  - 发布命名已根治：package.json `nsis.artifactName="${productName}.Setup.${version}.${ext}"`，本地文件/latest.yml/gh 上传名三者一致（此前空格名→latest.yml 用 dash 名→gh 转点名，自动更新 404，需手动修 latest.yml）。
  - 发布流程：gh 凭据经 `/app/agent/bin/agent git-credential-helper get`（protocol=https host=github.com）取 GH_TOKEN，用完 unset；`gh release create v1.5.x` + `gh release upload` 上传 exe/blockmap/latest.yml，latest.yml 的 url 必须与实际上传资产名一致。

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while performing whisper-server 常驻优化与打包验证（v1.5.5）
- Category: Environment Configuration / Build Methods / Testing Methods
- Instructions:
  - Linux 沙箱网络限制：huggingface.co 与 hf-mirror.com 均不可达（SSL/308/000），ggml.ai 可达但路径 404、modelscope.cn 可达（需正确 repo）。GitHub release 资产可下载（whisper-bin-x64.zip 等，缓存于 ~/.cache/daisy-*）。
  - Electron GUI 可在本沙箱真实运行验证：先 `apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libgtk-3-0`，再 `timeout 120 xvfb-run -a npx electron . --no-sandbox`（root 需 --no-sandbox；无音频设备时麦克风初始化报错属预期，其余逻辑可正常验证）。
  - whisper.cpp 源码可在本沙箱编译（cmake 构建，产出 whisper-server/whisper-cli），用于参数行为核对（与 Windows 版同源码，参数一致）。
  - `npm run dist:win` 在已打 NSIS 补丁的沙箱可完整跑通（打包+注入+signtool），产物在 releases/win-unpacked，可本地核查 assets/bin 注入文件是否齐全。
  - whisper-server 常驻转写架构：Windows 打包已注入 whisper-server.exe；macOS 侧 assets/bin 未捆绑 server，依赖 `/opt/homebrew/bin/whisper-server`（brew whisper-cpp 是否含该二进制未在真机确认），缺失时自动回退 whisper-cli，行为不退化。`scripts/self-test.js` 可查本机 server 可用性。

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while analyzing v1.5.5 真机日志（Windows）定位「语音无反应」根因
- Category: Troubleshooting & Debugging
- Instructions:
  - 日志关键证据链：`WhisperAsrSession: stop() called, total audio: 0 bytes` → `Empty transcript, going idle` → 用户无任何反应；`maxLevel=0.0000` 大量出现（436 次 vs 非零 599 次）且 04:47-04:50 从 maxLevel=1.0932 永久跌到 0，说明麦克风进入「数字静音」（不是用户没说话，是管线死了）且无自愈。
  - 蓝牙输入（如 V12 pro）是静音高频诱因：04:36 日志出现 `ensureMic: bluetooth input detected ... retrying without AEC/AGC/NS`，之后仍可再次静音。修复方向：renderer audio.js 增加自愈（track.onmute/onended 重建管线 + 录音中连续 4s 数字静音触发 rebuildMic，10s 冷却）。
  - 唤醒词 whisper-cli 报 `read_audio_data: trying to decode with miniaudio` 多为「采集到的是全零音频」的连带效应（静音管线的结果），非解码器本身故障。
  - 火山 ASR 日志 `ASR configured: false` 表示用户未填 VOLCENGINE 凭证；`shortcutUseWhisper=true` 且出现过一次成功转写（`ASR final: 打開百多`）证明 LLM/TTS/工具链路正常，问题集中在 唤醒词→录音→ASR 采集链路。
  - Windows 下 `open_url` 用 electron shell 打开百度曾失败 → 走 `run_shell_command cmd /c start` 也失败（`Silent tool execution failed`），浏览器打开链路需在真机再验；windows.ts 的 openUrl 走 explorer.exe 数组参数相对可靠。

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while analyzing v1.5.6 真机日志（Windows）定位 whisper 全线崩溃根因
- Category: Troubleshooting & Debugging / Environment Configuration
- Instructions:
  - Windows 打包的 whisper.cpp v1.9.2 只带 CPU 后端 DLL（ggml-cpu-*.dll，无 CUDA 产物），但 whisper-server/whisper-cli 默认 use_gpu=true。日志证据：stderr 停在 `whisper_init_with_params_no_state: use gpu = 1` 后立即 `process exited code=3221225477`（=0xC0000005 访问违规），反复 7+ 次，唤醒词与快捷键本地识别全部失败。修复：启动参数加 `-ng`（仅 Windows，用 `whisperNeedsNoGpu()` 判断；macOS 保留 Metal GPU，强制 CPU 会显著拖慢推理）。
  - v1.5.6 日志 `whisper-server: load_backend: loaded CPU backend ...ggml-cpu-alderlake.dll` 出现说明 CPU 后端加载本身成功，崩溃点在 GPU 初始化——`-ng` 后无需重下模型。
  - 判定「采集没问题、推理挂了」的证据链：`Renderer: AUDIO_LOG: audio flowing ... maxLevel=0.0013-0.0017` 持续非零（麦克风电平正常）+ VAD 出现 `inSpeech=true`（唤醒词有触发到 processing）+ 但 whisper 二进制反复 0xC0000005 → 问题在 ASR 推理段而非采集段。
  - 火山 ASR 日志 `ASR configured: true` + `ASR: WebSocket error: Unexpected server response: 403` = 凭证已填但 AppID/Token/ResourceID 三者与已开通服务不匹配（鉴权失败），非「没触发」；代码侧只做提示，根因在用户火山控制台侧。

[Project Knowledge Summary]
- Date: 2026-08-05
- Context: Discovered by Agent while doing 低配/高配双机适配（用户用低配 Windows 测试，另有高配电脑）
- Category: Environment Configuration / Build Methods / Troubleshooting & Debugging
- Instructions:
  - Windows 打包 whisper-bin-x64.zip 只含 ggml-cpu-*.dll（无 CUDA/Vulkan/HIP 后端），故 Windows 无论高低配统一 `-ng` 强制 CPU 是正确的；高配即使有 NVIDIA 独显也加载不了 GPU 后端，不要为高配 Windows 恢复 use_gpu。macOS 保留默认（Metal GPU 加速，M1-M4 后端库经 GGML_BACKEND_PATH 指定）。
  - 高低配差异只用「线程数 + 模型档位」承载：`getWhisperServerThreads()` 常驻 server 低配(≤4核)用满可用核、高配(8核+)上限 8 线程留余量给 LLM/TTS；CLI 一次性回退仍用 `getWhisperThreads()`（上限 4，避免进程启动争抢）。
  - 模型档位：低配(≤4核)推荐 Tiny/Base 保响应速度，高配可选 Small 提准确率；设置页「语音唤醒→依赖模型」下拉已含三档及建议文案，切换后需重新下载并重启。不要代码强制降档（用户低配跑 Small 是自主选择，只给引导）。
  - 用户测试机是低配 Windows：验证「低配下 -ng 后唤醒词/快捷键恢复」是 v1.5.7 验收主线；高配机器作为第二验证点（确认 server 线程自适应不引入新问题）。

