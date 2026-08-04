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
