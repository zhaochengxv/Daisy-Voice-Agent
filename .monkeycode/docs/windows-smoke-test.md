# Windows 适配冒烟测试清单

> 本清单面向真机验证。Daisy 在 Linux 沙箱完成开发与编译级验证，macOS/Windows 运行行为需按下表逐项冒烟。

## 环境准备（Windows）

1. 执行 `npm run dist:win` 生成 NSIS 安装包，安装后启动 Daisy。
2. 准备 `daisy.env`（火山 ASR + DeepSeek + Edge TTS 配置），与 macOS 同款。
3. 唤醒词所需 `whisper-cli.exe` + `ggml-base.bin` 已由安装包注入/设置页下载（v1.5.6 起同时注入 `whisper-server.exe`）。

## 界面与 LLM 提示适配

| 场景 | 预期 | 通过 |
|------|------|------|
| 设置窗口标题栏 | Windows 显示原生标题栏（可拖动/关闭/最小化），无 40px 顶部留白遮挡 | ☐ |
| LLM 工具描述 | 仅 edit_pdf 带「仅支持 macOS」标注；邮件/备忘录/日历/文档等已实现工具带 Outlook/Word 依赖说明 | ☐ |
| 系统提示词 | 排除进程列表显示 explorer 而非 Finder，无 AppleScript 指引 | ☐ |
| TTS 音频播放 | `file:///C:/...` URL 正确加载 MP3（Windows 反斜杠路径已转换） | ☐ |
| 无黑色控制台窗口 | 每次命令（开关应用/音量/剪贴板/计时器等）执行时不弹出 cmd/PowerShell 黑窗（windowsHide 已全局处理） | ☐ |

## 核心循环（优先级高）

| 场景 | 预期 | 通过 |
|------|------|------|
| 按住快捷键说话，松手发送 | ASR 文本出现在悬浮球，LLM 开始回答 | ☐ |
| 快捷键模式防抖（<150ms 松手不触发） | 无误发 | ☐ |
| TTS 播报 | 每句边生成边朗读，播完物理删除临时 MP3 | ☐ |
| TTS 打断 | 快捷键/唤醒词打断后立即停止并清理 | ☐ |
| 锁屏后环境音不触发 | 屏幕锁定期间静默（Windows 无 lock-screen 事件时此路径跳过，需手动验证） | ☐ |

## 本地命令路由

| 命令 | 预期 | 通过 |
|------|------|------|
| "打开 Chrome" | Start-Process 拉起 Chrome（模糊别名应命中） | ☐ |
| "打开浏览器" | 读取注册表 UserChoice 的 ProgId，拉起默认浏览器 | ☐ |
| "关闭 Chrome" | CloseMainWindow 优雅关闭，500ms 后强制兜底 | ☐ |
| "关闭浏览器" | 关闭默认浏览器 | ☐ |
| "调高/调低音量" | user32 keybd_event 发送音量键 | ☐ |
| "静音" | 发送静音键 | ☐ |
| "暂停/下一首/上一首" | 虚拟媒体键控制当前播放器 | ☐ |
| "打开百度/抖音" | 网页跳转用 explorer.exe 打开 | ☐ |
| "复制XXX" / 剪贴板读取 | Get-Clipboard 正常 | ☐ |
| "锁屏" | rundll32 LockWorkStation | ☐ |
| "打开地图/导航到XX" | `bingmaps:?` 协议 | ☐ |

## whisper-server 常驻转写专项（v1.5.6 新增）

> 背景：v1.5.6 起转写改走常驻 whisper-server（`POST /inference`，模型只加载一次），根治低配机器每次转写 40s+ 超时。转写同时被快捷键本地 ASR（`SHORTCUT_USE_WHISPER=true`）与唤醒词识别共享。任何失败自动回退 whisper-cli，行为不退化。日志关键词：`WhisperServer: listening on 127.0.0.1:<port>`、`WhisperServer: warmup ok`、`mark dead, will restart on next transcribe`。

| 场景 | 预期 | 通过 |
|------|------|------|
| 安装包注入完整 | `%LOCALAPPDATA%\Programs\Daisy\resources\app.asar.unpacked\assets\bin\` 含 `whisper-server.exe` + 13 个 whisper/ggml 文件 | ☐ |
| 首次转写速度 | 冷启动后首次「按住快捷键说话」：转写在 1-3 秒内返回（此前 CLI 路径 40s+） | ☐ |
| 模型只加载一次 | 连续多次快捷键转写，全程无二次「加载模型」长等待；任务管理器 whisper-server.exe 内存稳定 | ☐ |
| 唤醒词识别 | 喊「嘿 Daisy」唤醒 → 自动监听 → 命令转写走 server（秒级） | ☐ |
| 预热日志 | 启动后日志出现 `WhisperServer: warmup ok`（启用 shortcutUseWhisper 或唤醒词时） | ☐ |
| 崩溃自愈 | 手动 kill whisper-server.exe 后再说话：下一次转写自动重启 server 并成功（日志出现 `mark dead` + 重新 `listening`） | ☐ |
| 模型切换 | 设置页从 base 切到 tiny（重新下载）：下载完成后 server 自动重启并加载新模型（日志出现 `WhisperServer: listening ... ggml-tiny.bin`），无需重启应用 | ☐ |
| 退出清理 | 退出 Daisy 后 whisper-server.exe 进程消失（dispose 正常），无残留 | ☐ |

## 系统工具（42 个）

| 工具 | Windows 行为 | 通过 |
|------|-------------|------|
| weather_forecast / web_search / scrape_url / search_wallpapers / sports_schedule | 纯网络，应正常 | ☐ |
| read_file / write_file / create_file / delete_file / list_directory | fs 模块，应正常 | ☐ |
| run_shell_command | PowerShell 执行，危险命令拦截生效 | ☐ |
| type_text / press_keys | SendKeys 输入与快捷键 | ☐ |
| type_text 输入中文/Unicode | 剪贴板+Ctrl+V 方案，中文正常输入且剪贴板还原 | ☐ |
| press_keys 含 Win 键（win+d） | user32 keybd_event 正确发 Win 组合（非 Alt） | ☐ |
| get_frontmost_application | user32 GetForegroundWindow | ☐ |
| read_selected_text | 剪贴板备份 + ^c 读取还原 | ☐ |
| set_timer / set_alarm | 派生独立 powershell + console.beep | ☐ |
| download_media | yt-dlp.exe（需 .exe 随包/在 PATH） | ☐ |
| trim_video / convert_video / extract_audio | ffmpeg-static 跨平台，应正常 | ☐ |
| send_email / read_unread_emails / get_recent_emails / search_emails | 未检测到 Outlook 时提示需安装（已实现 Outlook COM） | ☐ |
| create_calendar_event / get_calendar_events | 未检测到 Outlook 时提示需安装（已实现 Outlook COM） | ☐ |
| create_note / search_notes | 写入 ~/Documents/Daisy备忘录/*.md，按关键词检索 | ☐ |
| create_reminder | 到期派生 powershell 蜂鸣提醒 | ☐ |
| convert_document / edit_document | 已实现 Word COM（需安装 Office） | ☐ |
| edit_pdf | 提示「当前仅支持 macOS」（Windows 无免费内置方案） | ☐ |
| switch_audio_output | Core Audio API 枚举/切换默认输出设备，设备名模糊匹配 | ☐ |

## 降级与边界

| 场景 | 预期 | 通过 |
|------|------|------|
| 勿扰/专注模式 | 注册表 NOC_GLOBAL_SETTING_TOASTS_ENABLED 静音所有通知 | ☐ |
| 左右分屏 | AppActivate 激活窗口 + Win+Left/Right（Snap 布局），应用未运行提示 | ☐ |
| 最小化窗口 | PowerShell ShowWindow minimize | ☐ |
| 最小化除XX外所有窗口 | 按 MainWindowHandle 过滤，排除 explorer/daisy | ☐ |
| 邮件/日历/文档（未装 Office） | 返回「未检测到 Outlook/Word，请安装 Microsoft 365」提示 | ☐ |

## 高风险验证项（真机必须重点确认）

这些实现依赖未公开 COM 接口或平台时序行为，沙箱无法验证，冒烟时优先：

| 场景 | 风险点 | 通过 |
|------|--------|------|
| switch_audio_output | IPolicyConfig 是未公开 COM 接口，vtable 顺序靠社区定义，部分 Win 版本可能调用失败；失败时核对返回的错误信息 | ☐ |
| get_calendar_events | 已改 [datetime] 强类型遍历（绕开 Restrict 日期区域差异），确认非美区 Windows 正常返回 | ☐ |
| read_unread_emails 等 | SenderName/Subject 为 null 时兜底为「(未知)/(无主题)」，确认格式稳定 | ☐ |
| 左右分屏 | WScript.Shell.AppActivate 对中文窗口标题匹配可能偏差，确认能激活 | ☐ |
| send_email | Outlook 可能弹「程序正在尝试发送邮件」安全提示，确认自动发送或记录提示 | ☐ |
| 剪贴板操作 | Get/Set-Clipboard + -STA 时序，确认 type_text / read_selected_text 中文与还原正常 | ☐ |

## 注意事项

- **无真机验证项**：PowerShell/user32 的真实输出格式（如 Get-Clipboard 返回）、SendKeys 焦点行为、锁屏事件、whisper-server 端到端转写（HTTP multipart 上传 WAV → 返回文本）。这些是 Windows 特有的运行时行为，必须真机确认。
- **音量守卫**：Windows 直接跳过（无 Chrome AppleScript 等价物），录音期间系统音量不受影响，这是已知差异。
- 若 `npm run dist:win` 在本地失败，优先检查 electron-builder 的 wine/NSIS 依赖是否就绪。
