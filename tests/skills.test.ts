import { describe, it, expect } from "vitest";
import { SKILLS, buildSkillCatalog, getSkill, listSkillsText, activateSkillText } from "../src/main/skills/registry";

describe("skills registry（Skill 生态）", () => {
  it("内置技能数量 >= 13，id 全局唯一且合法", () => {
    const ids = new Set(SKILLS.map((s) => s.id));
    expect(ids.size).toBe(SKILLS.length);
    for (const s of SKILLS) {
      expect(s.id).toMatch(/^[a-z0-9_]+$/);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.instructions.length).toBeGreaterThan(20);
      expect(Array.isArray(s.relatedTools)).toBe(true);
    }
  });

  it("关键技能齐备（全场景感知/操控/技能生态必需）", () => {
    const ids = new Set(SKILLS.map((s) => s.id));
    for (const required of [
      "screen_awareness",
      "gui_automation",
      "window_management",
      "pdf_workflow",
      "excel_analysis",
      "web_research",
      "file_management",
      "media_processing",
      "email_management",
      "scheduling",
      "image_vision",
      "note_taking",
      "system_operations",
    ]) {
      expect(ids.has(required), `缺少技能 ${required}`).toBe(true);
    }
  });

  it("buildSkillCatalog 输出一行一个技能的目录文本", () => {
    const cat = buildSkillCatalog();
    expect(cat.split("\n").length).toBe(SKILLS.length);
    expect(cat).toContain("screen_awareness");
    expect(cat).toContain("gui_automation");
  });

  it("getSkill 按 id 精确命中（忽略大小写与首尾空白）", () => {
    expect(getSkill("Screen_Awareness")?.id).toBe("screen_awareness");
    expect(getSkill("  gui_automation  ")?.id).toBe("gui_automation");
    expect(getSkill("不存在的技能")).toBeNull();
  });

  it("listSkillsText 前缀说明 + 全量目录", () => {
    const text = listSkillsText();
    expect(text).toContain("activate_skill");
    expect(text.split("\n").length).toBe(SKILLS.length + 1);
  });

  it("activateSkillText 注入完整工作流指令", () => {
    const text = activateSkillText("gui_automation");
    expect(text).toContain("已激活技能");
    expect(text).toContain("图形界面自动化");
    expect(text).toContain("感知 → 定位 → 操作 → 验证");
    expect(text).toContain("mouse_click");
  });

  it("activateSkillText 未命中返回 null", () => {
    expect(activateSkillText("no_such_skill")).toBeNull();
  });
});
