import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const electronMockState = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMockState.userDataDir },
}));

import { TaskMemory } from "../src/main/llm/taskMemory";

const snapshotFile = () => path.join(electronMockState.userDataDir, "task-snapshot.json");

describe("TaskMemory（v1.5.16：100 步中断后新会话恢复任务上下文）", () => {
  beforeEach(() => {
    electronMockState.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-taskmem-"));
  });
  afterEach(() => {
    fs.rmSync(electronMockState.userDataDir, { recursive: true, force: true });
  });

  it("save 后 hasPending 为 true 且 getPending 返回快照", () => {
    const tm = new TaskMemory();
    tm.save(
      [
        { role: "user", content: "帮我下载 ffmpeg 并转码视频" },
        { role: "assistant", content: "好的，我来处理" },
      ],
      "帮我下载 ffmpeg 并转码视频"
    );
    expect(tm.hasPending()).toBe(true);
    const p = tm.getPending();
    expect(p?.lastUserText).toBe("帮我下载 ffmpeg 并转码视频");
    expect(p?.context.length).toBe(2);
    expect(fs.existsSync(snapshotFile())).toBe(true);
  });

  it("clear 后快照消失且文件被删除", () => {
    const tm = new TaskMemory();
    tm.save([{ role: "user", content: "任务A" }], "任务A");
    tm.clear();
    expect(tm.hasPending()).toBe(false);
    expect(tm.getPending()).toBeNull();
    expect(fs.existsSync(snapshotFile())).toBe(false);
  });

  it("load 从磁盘恢复上次未完成任务", () => {
    const tm1 = new TaskMemory();
    tm1.save([{ role: "user", content: "继续之前的转码任务" }], "继续之前的转码任务");
    const tm2 = new TaskMemory();
    tm2.load();
    expect(tm2.hasPending()).toBe(true);
    expect(tm2.getPending()?.summary).toBe("继续之前的转码任务");
  });

  it("快照最多保留 12 条消息", () => {
    const tm = new TaskMemory();
    const many: Array<{ role: string; content: string }> = [];
    for (let i = 1; i <= 30; i++) many.push({ role: "user", content: `消息${i}` });
    tm.save(many, "最后一条");
    expect(tm.getPending()?.context.length).toBe(12);
    // 保留的是最新的 12 条
    const contents = tm.getPending()!.context.map((c) => c.content);
    expect(contents[contents.length - 1]).toBe("消息30");
  });

  it("损坏的 JSON 文件 load 时安全回退为无快照", () => {
    fs.writeFileSync(snapshotFile(), "{ not valid json", "utf-8");
    const tm = new TaskMemory();
    tm.load();
    expect(tm.hasPending()).toBe(false);
  });

  it("未调用 load 时无快照", () => {
    const tm = new TaskMemory();
    expect(tm.hasPending()).toBe(false);
  });
});
