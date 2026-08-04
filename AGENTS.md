# Daisy — Agent Notes

## 项目概述

`Daisy` 是一个 macOS 与 Windows 双平台 AI 语音助手，支持快捷键 and 语音唤醒两种交互方式。

- **快捷键模式**：按住右侧 Option 说话，松手自动发送（带 150ms 防抖）
- **语音唤醒模式**：喊 "嘿 Daisy" 唤醒，唤醒后自动监听，3 秒静音自动发送
- **唤醒词检测**：whisper.cpp 本地识别（ggml-base.bin），零云端费用，安全隐私
- **语音识别**：火山引擎 / 豆包 Seed ASR（流式 WebSocket，仅唤醒后调用）
- **AI 回答**：DeepSeek V4 Flash（流式 SSE + Function Calling + 双通道 JSON 输出）
- **语音播报**：Microsoft Edge TTS（流式断句，边生成边朗读，播放/打断后自动删除临时音频缓存，绝无残留）
- **本地命令路由**：打开/关闭应用、音量控制等固定指令零延迟直接执行，不调大模型。其中“浏览器”关键字能智能锁定并打开系统默认浏览器
- **系统控制**：42 个工具，覆盖高清壁纸搜索/下载、文件操作、备忘录、提醒事项、日历、计时器、闹钟、地图、天气、网页搜索、视频/文档处理、邮件等
- **Windows 支持**：核心循环（录音→ASR→LLM→TTS→UI）单实现跨平台；系统控制层按平台分派——Windows 用 PowerShell/user32 等价实现（开关应用、音量、播放控制、锁屏、剪贴板、计时器/闹钟等），无等价物的 macOS 专属能力（邮件/备忘录/提醒/日历/文档编辑/分屏/音频输出切换等）降级为「当前仅支持 macOS」提示。

## 目录结构

```
src/
├── main/                      # Electron 主进程
│   ├── index.ts               # 入口：生命周期、状态机、IPC、TTS 队列、锁屏电源监听
│   ├── config/env.ts          # dotenv 配置（ASR/LLM/TTS/快捷键/唤醒词）
│   ├── ipc/channels.ts        # IPC 通道常量
│   ├── audio/
│   │   └── recorder.ts        # 麦克风采集状态机（隐藏渲染进程，常驻不释放）
│   ├── asr/
│   │   ├── index.ts           # AsrSession：WebSocket 会话管理
│   │   ├── volcengine.ts      # 火山 ASR 二进制协议封装
│   │   └── whisper.ts         # 本地唤醒词识别封装（whisper.cpp 进程）
│   ├── llm/
│   │   ├── deepseek.ts        # DeepSeek 客户端：流式 SSE + 工具调用 + 双通道 JSON
│   │   ├── tools.ts           # 工具定义（42 个）
│   │   ├── system-prompt.ts   # 系统提示词及意图对齐过滤规则
│   │   └── conversation.ts    # 多轮对话管理（20 条/6000 token 裁剪，5 分钟过期）
│   ├── tts/
│   │   ├── edgeTTS.ts         # Edge TTS 合成（并发信号量 + 音频文件自动清理）
│   │   ├── streamTts.ts       # 流式断句 TTS 队列（generation 代际隔离）
│   │   └── pipeline.ts        # TTS 管道
│   ├── command/
│   │   └── router.ts          # 本地命令路由器（应用索引 + 中英文模糊别名匹配 + 浏览器专属防错，Windows 分支分派）
│   ├── control/
│   │   ├── macos.ts           # AppleScript 系统控制 + 42 工具执行分发（危险命令拦截，含 Windows 分派分支）
│   │   ├── windows.ts         # Windows 系统控制层（PowerShell/user32 等价实现 + 降级提示）
│   │   ├── search.ts          # DuckDuckGo/Firecrawl 搜索 + Wallhaven 壁纸（fetch 超时）
│   │   ├── weather.ts         # wttr.in 天气查询
│   │   ├── sports.ts          # 体育赛程查询
│   │   └── volumeGuard.ts     # 系统音量状态守卫（Windows 跳过）
│   ├── wakeword/
│   │   └── monitor.ts         # 唤醒词监控（whisper.cpp + VAD 语音活动检测）
│   ├── shortcut/
│   │   └── globalShortcut.ts  # 全局快捷键（带防抖 + 自定义按键匹配）
│   ├── windows/
│   │   ├── floatWindow.ts     # 悬浮球窗口（透明、置顶、鼠标穿透）
│   │   └── settingsWindow.ts  # 设置窗口（隐藏预创建，点击零延迟）
│   ├── history.ts             # 对话历史持久化
│   └── utils/
│       ├── logger.ts          # 文件日志
│       ├── appleScript.ts     # AppleScript 统一执行入口（execFile + stdin，无 shell）
│       ├── windowsShell.ts    # PowerShell 统一执行入口（execFile + env 传参，无 shell）
│       ├── audioSwitch.ts     # 音频输出设备切换（execFile 数组参数）
│       └── textClean.ts       # 文本清理工具
├── preload/index.ts           # contextBridge 桥接 diriAPI
├── renderer/                  # 静态前端页面（纯 JS，随 build 复制到 dist）
│   ├── audio.html/js          # 麦克风采集（常驻 AudioContext + 降采样 16kHz + 代际隔离）
│   └── float.html/js          # 悬浮球 Canvas 极光动画（鼠标穿透 + TTS 音量分析）
└── renderer-settings/         # 设置页 React 应用（vite 构建）
    ├── settings.html
    ├── main.tsx
    ├── App.tsx
    ├── components/IdleOrb.tsx
    ├── index.css
    └── types.d.ts
```

## 常用命令

```bash
npm install          # 安装依赖
npm run build        # 编译 TypeScript + 构建悬浮球 + 复制静态渲染文件
npm run dev          # 构建并启动（开发模式）
npm run pack         # 打包 .app（不签名）
npm run dist:mac     # 打包 macOS .app + .dmg
npm run dist:win     # 打包 Windows NSIS 安装包（x64，需在 Windows 环境执行）
npm test             # vitest 单测（核心纯逻辑 + Windows 分派逻辑）
npx tsc --noEmit     # 类型检查（不产出）

# 安装并覆盖到 /Applications
npm run pack && rm -rf /Applications/Daisy.app && cp -R releases/mac-arm64/Daisy.app /Applications/Daisy.app && open /Applications/Daisy.app
```

## CI

- `.github/workflows/ci.yml`：push main / PR 触发，macOS + Windows + Ubuntu 三平台跑 `npm ci` → `tsc --noEmit` → `npm test` → `npm run build`，预防双平台回归。
- Windows 真机冒烟步骤见 `.monkeycode/docs/windows-smoke-test.md`。

## Windows 适配说明

- **平台分派点**：`src/main/control/macos.ts` 每个导出的工具函数都以 `if (isWindows()) return win.xxx(...)` 开头分派到 `src/main/control/windows.ts`；本地命令路由 `src/main/command/router.ts` 同样按平台分派。
- **Windows 等价能力**：开关应用（Start-Process / CloseMainWindow）、音量（user32 keybd_event）、媒体播放（虚拟媒体键）、锁屏（rundll32 LockWorkStation）、剪贴板、计时器/闹钟/提醒（派生独立 powershell + console.beep）、备忘录（~/Documents/Daisy备忘录/*.md）、网页/地图跳转（explorer.exe / bingmaps:）、左右分屏（AppActivate + Win+方向键 Snap）、勿扰（注册表静音通知）、音频输出切换（Core Audio API）。
- **降级提示**：邮件/日历/文档编辑/转换在 Windows 已实现 Outlook/Word COM（未安装 Office 时返回引导提示）；PDF 编辑（Windows 无免费内置方案）返回「仅支持 macOS」。
- **安全模型**：PowerShell 统一入口 `runPowerShell` 用 execFile + 数组参数 + 无 shell，用户输入经 `DAISY_ARG0..n` 环境变量传入，杜绝拼接注入；15s 默认超时。
- **音量守卫**：`VolumeGuard` 在 Windows 直接跳过（无 Chrome AppleScript 等价物）。
- **唤醒词**：Windows 上 whisper-cli 需以 `whisper-cli.exe` 形式随包分发或加入 PATH（`getBundledBin` 自动补 `.exe` 后缀）。
- **Windows 打包**：electron-builder `win` 目标已配置（NSIS x64）；`scripts/adhoc-sign.js` 仅在 macOS 构建时执行 codesign。

## 配置

项目根目录 `daisy.env`：

```env
VOLCENGINE_APP_ID=...
VOLCENGINE_ACCESS_TOKEN=...
VOLCENGINE_RESOURCE_ID=volc.seedasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
EDGE_TTS_VOICE=zh-CN-XiaoxiaoNeural
GLOBAL_SHORTCUT=RightOption
WAKE_WORD_ENABLED=true
WAKE_WORD=嘿 Daisy
```

## 外部依赖

- **whisper.cpp**：`brew install whisper-cpp`，模型 `ggml-base.bin` 放在 `~/Models/whisper/`
- **全局快捷键**：`uiohook-napi` 提供 Apple Silicon 原生键盘事件监听，无需 Rosetta

## macOS 权限

- **麦克风权限**：音频采集
- **辅助功能权限**：AppleScript 控制键盘、读取选中文本（**注意**：应用更名为 Daisy 后，需在 `系统设置` -> `隐私与安全性` -> `辅助功能` 中重新授予 `Daisy.app` 权限）
- **输入监控权限**：全局快捷键捕获

## 工具列表（42 个）

| 工具 | 说明 | 实现方式 |
|------|------|----------|
| get_current_time | 获取当前日期和时间 | JS Date |
| weather_forecast | 查询指定城市的天气 | wttr.in 接口 |
| web_search | 使用 DuckDuckGo / Firecrawl 联网搜索 | 网页文本抓取 |
| scrape_url | 抓取网页纯净正文文本 | 网页文本抓取 |
| search_wallpapers | 搜索 Wallhaven 库高清壁纸直连下载链接 | Wallhaven API (支持自然风光负向过滤) |
| open_application | 打开指定应用程序 (支持默认浏览器和模糊别名) | AppleScript / open |
| quit_application | 关闭指定的单张应用 (支持英文进程精准匹配) | AppleScript / pkill |
| quit_all_applications | 关闭所有正在运行的桌面应用 (排除 Terminal 等) | AppleScript 进程迭代 |
| open_url | 浏览器打开网址 | `open` 命令 |
| type_text | 模拟键盘输入文字 | AppleScript keystroke |
| press_keys | 模拟组合快捷键 | AppleScript key code |
| get_frontmost_application | 获取当前处于最前台的应用名称 | AppleScript |
| read_selected_text | 读取用户当前选中的文本内容 | 剪贴板读取 |
| get_clipboard_text | 读取系统剪贴板纯文本 | AppleScript / pbpaste |
| write_clipboard_text | 写入系统剪贴板 | AppleScript / pbcopy |
| read_file / write_file / create_file / delete_file | 本地文件读写、创建与删除 | Node fs 模块 |
| list_directory | 列出指定目录下的文件列表 | Node fs.readdirSync |
| run_shell_command | 执行终端 Shell 命令 (高危命令拦截) | child_process |
| create_note / search_notes | 新建/搜索 macOS 备忘录 | AppleScript → Notes.app |
| create_reminder | 新建 macOS 提醒事项 | AppleScript → Reminders.app |
| create_calendar_event / get_calendar_events | 创建/查看 macOS 日历事件 | AppleScript → Calendar.app |
| set_timer | 设定倒计时通知 (以 Daisy 计时器为通知源) | 后台 sleep + afplay |
| set_alarm | 设定闹钟 (以 Daisy 闹钟为通知源) | 后台 sleep + afplay |
| search_maps | 在 macOS 地图应用中搜索地点 | `maps://` 协议跳转 |
| sports_schedule | 查询指定体育联赛日程表 | 接口解析 |
| download_media | 使用 yt-dlp 自动下载网络音视频文件 | yt-dlp 后台 spawn |
| trim_video / convert_video | 截取/转换视频 (流拷贝 `-c copy` 提速) | ffmpeg |
| extract_audio | 从视频/音频提取音频 | ffmpeg |
| convert_document | 任意文档格式互转 | 工具链自动分发 |
| edit_document | 编辑 .docx 文档 (保留样式) | docx 解析库 |
| edit_pdf | PDF 原地编辑 (find/fill/delete/replace) | PDF 解析库 |
| switch_audio_output | 切换系统音频输出设备 | SwitchAudioSource |
| send_email / read_unread_emails / get_recent_emails / search_emails | 邮件发送与读取 | AppleScript → Mail.app |

## 本地命令路由器

固定指令不调大模型，直接执行 + 音效确认（Tink）：

- **应用启停**：模糊中英文别名映射，如 `“飞书”` 自动判定并操作真实进程 `“Feishu”`。
- **默认浏览器拦截**：识别到 `"浏览器"` 指令时，自动查找并拉起系统的默认浏览器（如 Chrome），防止被类似于“豆包浏览器”等子匹配抢占。
- **系统音量**：调高/调低/静音。
- **播放控制**：媒体播放暂停/继续/上一首/下一首。
- **网页导航**：带"官网/网站/网页"后缀的指令走浏览器直接打开。

未命中本地命令才调用 DeepSeek 大模型。

## 双通道 JSON 输出

LLM 回复格式：`{"display":"Markdown文本","speech":"纯文本"}`

- `display`：可含 Markdown，用于悬浮球窗口前端渲染并存入历史。
- `speech`：纯文本无符号，专门喂给 Edge TTS 进行朗读。
- 解析失败时有 fallback 清理器，自动剥离残余的 JSON 键值、Markdown 符号及特殊度数单位。

## 流式 TTS 队列与内存安全

- LLM 流式输出 → 标点符号断句 → 每句送入 Edge TTS 生成临时 MP3 缓存。
- **TTS 阅后即焚**：每段音频播放完毕（或被用户快捷键/唤醒词打断）后，立即执行物理删除，内存与磁盘绝不堆积缓存。
- **冷启动清理**：冷启动时自动扫描并清空整个 `/var/folders/.../T/diri-tts/` 临时文件夹，彻底防漏。

## 状态机与锁屏电源安全

```
idle → listening → processing → thinking → speaking → idle
                ↑                                    ↓
                └────────── auto-hide 15s ──────────┘
```

- **锁屏静默防误触发**：集成 Electron 的 `powerMonitor`。当 Mac 屏幕锁定（`lock-screen`）时，**强制关闭麦克风和唤醒词监听**，彻底杜绝环境音（如狗叫、旁人聊天）误识别唤醒；当 Mac 屏幕解锁（`unlock-screen`）后，自动安全恢复。
- **球体颜色表征**：
  - 🔵 蓝色：聆听中 (`listening`)
  - 🟠 橙色：思考中 (`thinking`)
  - 🟢 绿色：说话中 (`speaking`)
  - 🔴 红色：错误状态 (`error`)
