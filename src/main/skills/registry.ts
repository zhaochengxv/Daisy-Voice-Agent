/**
 * Daisy 技能注册表（Skill Registry）。
 *
 * 对标 Claude Code Skills / OpenAI Codex Plugins 的「按场景发现 → 按需激活」模式：
 * - 系统提示词内置精简「技能目录」（id + 一句话适用场景），让 LLM 知道有哪些技能可用；
 * - 用户请求命中某技能场景时，LLM 调用 activate_skill(id) 注入该技能的完整工作流指令，
 *   随后按指令组合已有工具（含本版本新增的截屏/鼠标/窗口等全场景工具）完成任务；
 * - list_skills 返回目录，供 LLM 不确定时自行检索。
 *
 * 新增技能 = 在 SKILLS 数组中追加一条 { id, name, description, instructions, relatedTools }。
 */
export interface Skill {
  id: string;
  /** 技能显示名 */
  name: string;
  /** 触发场景描述（给 LLM 判断「何时该激活本技能」） */
  description: string;
  /** 激活后注入的完整工作流指令 */
  instructions: string;
  /** 本技能依赖/常用工具 */
  relatedTools: string[];
}

/** 技能目录（按场景路由）。description 必须写清「什么请求该激活」，供 LLM 自行匹配。 */
export const SKILLS: Skill[] = [
  {
    id: "screen_awareness",
    name: "屏幕感知",
    description: "用户问「屏幕上是什么/我在干什么」、需理解当前界面内容时激活。",
    instructions: `【屏幕感知技能】
1. 先调用 get_active_window 获取当前活动应用与窗口标题，作为上下文；
2. 调用 capture_screen 截取当前屏幕，得到截图文件路径；
3. 调用 analyze_screen（内部自动完成截屏+视觉模型分析）描述屏幕内容，重点关注：界面元素类型、按钮/输入框/链接上的文字、以及它们的大致屏幕坐标；
4. 结合用户问题回答；如需点击/输入，转交 gui_automation 技能。`,
    relatedTools: ["get_active_window", "capture_screen", "analyze_screen"],
  },
  {
    id: "gui_automation",
    name: "图形界面自动化",
    description: "需在应用界面点击/输入/滚动/拖拽时激活（操控电脑）。",
    instructions: `【图形界面自动化技能】
核心循环：感知 → 定位 → 操作 → 验证。
1. 感知：调用 analyze_screen 或 get_active_window 确定当前界面布局，得到目标元素的屏幕坐标 (x,y)；
2. 定位：若视觉模型未返回坐标，可结合界面文字推理，或先用 get_mouse_position + mouse_move 试探位置；
3. 操作：
   - 点击：mouse_click(x, y)（可选 button=right/double）；
   - 输入：先 mouse_click 定位光标，再 type_text 输入内容；回车用 press_keys("enter")；
   - 滚动：mouse_scroll(delta)；
   - 快捷键：press_keys("cmd+c") 等；
4. 验证：操作后调用 capture_screen + analyze_screen 检查界面是否变化到位；未到位则修正坐标重试；
5. 最多重试 3 次，仍失败则如实告知用户并说明已完成的步骤。`,
    relatedTools: ["analyze_screen", "mouse_click", "mouse_move", "mouse_scroll", "get_mouse_position", "type_text", "press_keys", "read_selected_text"],
  },
  {
    id: "window_management",
    name: "窗口管理",
    description: "需打开/最小化/分屏/切换/关闭窗口、列出窗口时激活。",
    instructions: `【窗口管理技能】
1. 列出窗口：get_window_list 查看所有可见窗口（应用、标题、位置、大小）；
2. 聚焦某窗口：open_application 激活应用，再结合 get_window_list 返回的窗口标题确认；
3. 最小化/关闭/分屏：按用户意图调用现有工具（quit_application / 本地命令路由的窗口操作）；
4. 完成后用 get_active_window 确认窗口状态。`,
    relatedTools: ["get_window_list", "get_active_window", "open_application", "quit_application"],
  },
  {
    id: "pdf_workflow",
    name: "PDF 工作流",
    description: "涉及 PDF 提取表格/正文、编辑、格式转换或数据分析时激活。",
    instructions: `【PDF 工作流技能】
1. 提取表格 → Excel：pdf_to_excel(source, target)；
2. 提取/查看正文：read_file 无法读 PDF 时用 run_python + pymupdf 抽取文本；
3. 编辑：edit_pdf（find/fill/delete/replace），编辑后必须回读验证；
4. 转换：convert_document（PDF→docx 用 pdf2docx，PDF→txt 用 pymupdf，扫描版需 OCR）；
5. 数据分析：先 pdf_to_excel 或 run_python 提取数据，再用 read_excel 读取分析。`,
    relatedTools: ["pdf_to_excel", "edit_pdf", "convert_document", "read_excel", "run_python"],
  },
  {
    id: "excel_analysis",
    name: "表格数据分析",
    description: "需对 Excel/CSV/表格做汇总、统计、筛选、透视、绘图、报表时激活。",
    instructions: `【表格数据分析技能】
1. 读取：read_excel(path) 获取结构化 JSON（默认前 200 行）；
2. 复杂分析：run_python + pandas 处理（求和/均值/透视/筛选/多表关联）；
3. 结果呈现：给出关键数字的结论，需要时可导出为 .xlsx/.csv 到用户目录并告知路径；
4. 数据量大时先告知行数再分析，避免一次性读入过多。`,
    relatedTools: ["read_excel", "run_python", "write_file"],
  },
  {
    id: "web_research",
    name: "联网调研",
    description: "需查找最新信息、多方对比、事实核查、搜集资料时激活。",
    instructions: `【联网调研技能】
1. 多关键词：web_search 用 2~3 个不同关键词覆盖信息面；
2. 精读原文：对关键结果用 scrape_url 抓取正文，确认事实而非仅看摘要；
3. 交叉验证：同一事实至少两个独立来源一致才下结论；
4. 时效提示：注明信息时效；涉及时效性强的（价格/新闻）建议用户确认；
5. 汇总输出：要点化呈现，标注来源。`,
    relatedTools: ["web_search", "scrape_url", "open_url"],
  },
  {
    id: "file_management",
    name: "文件与目录管理",
    description: "需批量整理、重命名、归类、查找、移动文件时激活。",
    instructions: `【文件管理技能】
1. 盘点：list_directory(path) 查看目录结构；
2. 批量处理：文件多时用 run_python + os/shutil 批量重命名、移动、归类（比逐条工具调用可靠）；
3. 读写：write_file/read_file 处理文本；create_file/delete_file 增删；
4. 危险操作（删除/覆盖）前先列出将被操作的文件清单并确认，再做；
5. 完成后 list_directory 验证结果。`,
    relatedTools: ["list_directory", "read_file", "write_file", "create_file", "delete_file", "run_python"],
  },
  {
    id: "media_processing",
    name: "音视频处理",
    description: "需下载音视频、截取、转格式、提取音频时激活。",
    instructions: `【音视频处理技能】
1. 下载：download_media(url, type)（视频/音频）；
2. 剪辑：trim_video(source, start, end) 截取片段；convert_video 转格式；extract_audio 提取音频；
3. 校验：处理完成后必须确认产物文件存在且大小合理，再告知用户；
4. 失败排查：报错时把 ffmpeg 错误信息带回来，根据错误调整参数（如帧率/编码）。`,
    relatedTools: ["download_media", "trim_video", "convert_video", "extract_audio"],
  },
  {
    id: "email_management",
    name: "邮件处理",
    description: "需发邮件、查看未读、搜索或整理邮件时激活。",
    instructions: `【邮件处理技能】
1. 发送：send_email(to, subject, body)，正文用纯文本；
2. 查看：read_unread_emails / get_recent_emails 获取列表；
3. 搜索：search_emails(query) 按关键词/发件人筛选；
4. 敏感操作（群发/删除）前先跟用户确认收件人与内容。`,
    relatedTools: ["send_email", "read_unread_emails", "get_recent_emails", "search_emails"],
  },
  {
    id: "scheduling",
    name: "日程与提醒",
    description: "需设定时器/闹钟、提醒事项、日历事件、查日程时激活。",
    instructions: `【日程与提醒技能】
1. 计时：set_timer(seconds) 倒计时；set_alarm(time) 闹钟；
2. 提醒：create_reminder(title, due_date, notes)；
3. 日历：create_calendar_event / get_calendar_events 管理日程；
4. 时间格式：一律用 YYYY-MM-DD HH:MM 24 小时制；用户只给了模糊时间（如「明早 9 点」）时先换算好再调用。`,
    relatedTools: ["set_timer", "set_alarm", "create_reminder", "create_calendar_event", "get_calendar_events", "get_current_time"],
  },
  {
    id: "image_vision",
    name: "图片与视觉理解",
    description: "需分析图片/截图/视频内容、识别图中文字时激活。",
    instructions: `【图片与视觉理解技能】
1. 本地图片：analyze_image(path, question) 分析单张；
2. 视频：analyze_video(path, question) 抽帧理解；
3. 截图：analyze_screen 理解当前屏幕；
4. 识别文字/表格：直接给视觉模型明确指令（如「提取图中所有文字并整理成列表」）；
5. 视觉模型未配置时，如实转述配置引导，不要编造图片内容。`,
    relatedTools: ["analyze_image", "analyze_video", "analyze_screen", "capture_screen"],
  },
  {
    id: "note_taking",
    name: "备忘与记录",
    description: "需快速记录灵感/纪要/待办、查找历史笔记时激活。",
    instructions: `【备忘与记录技能】
1. 新建：create_note(title, body) 记录要点；
2. 查找：search_notes(query) 检索历史笔记；
3. 整理：内容多时先用要点化整理再写入，方便后续检索。`,
    relatedTools: ["create_note", "search_notes", "create_reminder"],
  },
  {
    id: "system_operations",
    name: "系统操作",
    description: "需控制音量/媒体播放/勿扰/锁屏/音频输出/开关应用时激活。",
    instructions: `【系统操作技能】
1. 明确用户意图后直接调用对应工具，不要绕弯；
2. 音量/播放：优先走本地命令（无需大模型确认），若已到 LLM 则用对应工具；
3. 开关应用：open_application / quit_application；
4. 操作不可逆或影响面大（关闭多应用、改系统设置）前先跟用户确认；
5. Windows 上部分能力有降级，按工具返回如实告知。`,
    relatedTools: ["switch_audio_output", "open_application", "quit_application", "quit_all_applications"],
  },
];

/** 返回精简目录文本：id + 一句适用场景（注入系统提示词用，控制 token 预算） */
export function buildSkillCatalog(): string {
  return SKILLS.map((s) => `- ${s.id}：${s.name} —— ${s.description}`).join("\n");
}

/** 按 id 取技能，未命中返回 null */
export function getSkill(id: string): Skill | null {
  return SKILLS.find((s) => s.id.toLowerCase() === id.trim().toLowerCase()) ?? null;
}

/** list_skills 工具的返回文本 */
export function listSkillsText(): string {
  return (
    "可用技能目录（调用 activate_skill 可激活对应技能获得详细工作流指令）：\n" +
    SKILLS.map((s) => `- ${s.id}：${s.name} —— ${s.description}`).join("\n")
  );
}

/** activate_skill 成功时注入的完整指令文本 */
export function activateSkillText(id: string): string | null {
  const skill = getSkill(id);
  if (!skill) return null;
  return [
    `已激活技能【${skill.name}】（${skill.id}）。请严格按照以下工作流执行本次任务：`,
    skill.instructions,
    "（技能指令执行完毕并输出结果后，本次任务才算完成。）",
  ].join("\n");
}
