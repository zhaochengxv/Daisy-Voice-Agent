# Windows 适配冒烟测试清单

> 本清单面向真机验证。Daisy 在 Linux 沙箱完成开发与编译级验证，macOS/Windows 运行行为需按下表逐项冒烟。

## 环境准备（Windows）

1. 执行 `npm run dist:win` 生成 NSIS 安装包，安装后启动 Daisy。
2. 准备 `daisy.env`（火山 ASR + DeepSeek + Edge TTS 配置），与 macOS 同款。
3. 可选：将 `whisper-cli.exe` + `ggml-base.bin` 放入 `assets/bin` 随包分发，或加入 PATH 以启用唤醒词。

## 界面与 LLM 提示适配

| 场景 | 预期 | 通过 |
|------|------|------|
| 设置窗口标题栏 | Windows 显示原生标题栏（可拖动/关闭/最小化），无 40px 顶部留白遮挡 | ☐ |
| LLM 工具描述 | 邮件/备忘录/日历/文档/PDF 编辑等工具描述带「当前仅支持 macOS」标注，LLM 不误用 | ☐ |
| 系统提示词 | 排除进程列表显示 explorer 而非 Finder，无 AppleScript 指引 | ☐ |
| TTS 音频播放 | `file:///C:/...` URL 正确加载 MP3（Windows 反斜杠路径已转换） | ☐ |

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
| send_email / read_unread_emails / get_recent_emails / search_emails | 提示「当前仅支持 macOS」 | ☐ |
| create_note / search_notes / create_reminder / create_calendar_event / get_calendar_events | 提示「当前仅支持 macOS」 | ☐ |
| convert_document / edit_document / edit_pdf | 提示「当前仅支持 macOS」 | ☐ |
| switch_audio_output | 提示「当前仅支持 macOS」 | ☐ |

## 降级与边界

| 场景 | 预期 | 通过 |
|------|------|------|
| 勿扰/专注模式 | 提示「当前仅支持 macOS」（Windows 无原生 API） | ☐ |
| 左右分屏 | 提示「当前仅支持 macOS」 | ☐ |
| 最小化窗口 | PowerShell ShowWindow minimize | ☐ |
| 最小化除XX外所有窗口 | 按 MainWindowHandle 过滤，排除 explorer/daisy | ☐ |

## 注意事项

- **无真机验证项**：PowerShell/user32 的真实输出格式（如 Get-Clipboard 返回）、SendKeys 焦点行为、锁屏事件、whisper-cli.exe 调用。这些是 Windows 特有的运行时行为，必须真机确认。
- **音量守卫**：Windows 直接跳过（无 Chrome AppleScript 等价物），录音期间系统音量不受影响，这是已知差异。
- 若 `npm run dist:win` 在本地失败，优先检查 electron-builder 的 wine/NSIS 依赖是否就绪。
