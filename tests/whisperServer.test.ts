import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { whisperServer } from "../src/main/asr/whisperServer";

describe("whisperServer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("构造标准 multipart 转写请求并返回清理后的文本", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "  你好 Daisy  ",
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(whisperServer, "ensure").mockResolvedValue(34567);

    const result = await whisperServer.transcribe(Buffer.from([0, 1, 2]), {
      language: "zh",
      prompt: "Daisy, 黛西",
    });

    expect(result).toBe("你好 Daisy");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:34567/inference");
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("response_format")).toBe("text");
    expect(body.get("language")).toBe("zh");
    expect(body.get("prompt")).toBe("Daisy, 黛西");
    const file = body.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
  });

  it("HTTP 非 200 返回 null 触发 CLI 回退", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(whisperServer, "ensure").mockResolvedValue(34567);

    expect(await whisperServer.transcribe(Buffer.alloc(4))).toBeNull();
  });

  it("请求异常返回 null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    vi.spyOn(whisperServer, "ensure").mockResolvedValue(34567);

    expect(await whisperServer.transcribe(Buffer.alloc(4))).toBeNull();
  });

  it("server 启动失败返回 null", async () => {
    vi.spyOn(whisperServer, "ensure").mockResolvedValue(null);

    expect(await whisperServer.transcribe(Buffer.alloc(4))).toBeNull();
  });

  it("dispose 终止子进程并允许重启", async () => {
    const kill = vi.fn();
    (whisperServer as unknown as { child: unknown }).child = { kill };
    (whisperServer as unknown as { port: number | null }).port = 34567;

    await whisperServer.dispose();

    expect(kill).toHaveBeenCalled();
    expect((whisperServer as unknown as { child: unknown }).child).toBeNull();
    expect((whisperServer as unknown as { port: number | null }).port).toBeNull();
  });

  it("启动失败进入冷却期：ensure 直接返回 null 且不再尝试启动", async () => {
    const startSpy = vi
      .spyOn(whisperServer as unknown as { start: () => Promise<number | null> }, "start")
      .mockResolvedValue(null);
    (whisperServer as unknown as { failUntil: number }).failUntil = Date.now() + 30000;
    (whisperServer as unknown as { failed: boolean }).failed = false;

    const port = await whisperServer.ensure();

    expect(port).toBeNull();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("冷却期结束后 ensure 自动重试启动", async () => {
    const startSpy = vi
      .spyOn(whisperServer as unknown as { start: () => Promise<number | null> }, "start")
      .mockResolvedValue(34567);
    (whisperServer as unknown as { failUntil: number }).failUntil = Date.now() - 1000;
    (whisperServer as unknown as { failed: boolean }).failed = false;

    const port = await whisperServer.ensure();

    expect(port).toBe(34567);
    expect(startSpy).toHaveBeenCalled();
  });

  it("dispose 重置失败冷却期，restart 后可立即重试", async () => {
    (whisperServer as unknown as { failUntil: number }).failUntil = Date.now() + 30000;
    await whisperServer.dispose();
    expect((whisperServer as unknown as { failUntil: number }).failUntil).toBe(0);
  });

  it("warmup 幂等且不抛错", async () => {
    const ensureSpy = vi.spyOn(whisperServer, "ensure").mockResolvedValue(34567);
    await expect(whisperServer.warmup()).resolves.toBeUndefined();
    expect(ensureSpy).toHaveBeenCalled();
  });

  it("5xx 响应标记 server 死亡，下次请求重启自愈", async () => {
    const kill = vi.fn();
    (whisperServer as unknown as { child: unknown }).child = { kill };
    (whisperServer as unknown as { port: number | null }).port = 34567;
    vi.spyOn(whisperServer, "ensure")
      .mockResolvedValueOnce(34567)
      .mockResolvedValue(null);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    expect(await whisperServer.transcribe(Buffer.alloc(4))).toBeNull();
    expect(kill).toHaveBeenCalled();
    expect((whisperServer as unknown as { port: number | null }).port).toBeNull();
  });

  it("网络异常标记 server 死亡以便重启", async () => {
    const kill = vi.fn();
    (whisperServer as unknown as { child: unknown }).child = { kill };
    (whisperServer as unknown as { port: number | null }).port = 34567;
    vi.spyOn(whisperServer, "ensure")
      .mockResolvedValueOnce(34567)
      .mockResolvedValue(null);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));

    expect(await whisperServer.transcribe(Buffer.alloc(4))).toBeNull();
    expect(kill).toHaveBeenCalled();
    expect((whisperServer as unknown as { port: number | null }).port).toBeNull();
  });

  it("server 转写中途崩溃后重启一次并重试成功", async () => {
    const kill = vi.fn();
    (whisperServer as unknown as { child: unknown }).child = { kill };
    (whisperServer as unknown as { port: number | null }).port = 34567;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "重试成功" });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(whisperServer, "ensure")
      .mockResolvedValueOnce(34567)
      .mockResolvedValue(45678);

    expect(await whisperServer.transcribe(Buffer.alloc(4))).toBe("重试成功");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("restart 先 dispose 再 warmup", async () => {
    const disposeSpy = vi.spyOn(whisperServer, "dispose").mockResolvedValue();
    const warmupSpy = vi.spyOn(whisperServer, "warmup").mockResolvedValue();

    await whisperServer.restart();

    expect(disposeSpy).toHaveBeenCalled();
    expect(warmupSpy).toHaveBeenCalled();
  });

  it("server 从未成功时网络错误不 kill（避免无谓操作）", async () => {
    const kill = vi.fn();
    (whisperServer as unknown as { child: unknown }).child = { kill };
    (whisperServer as unknown as { port: number | null }).port = null;
    vi.spyOn(whisperServer, "ensure").mockResolvedValue(null);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));

    expect(await whisperServer.transcribe(Buffer.alloc(4))).toBeNull();
    expect(kill).not.toHaveBeenCalled();
  });

  it("killOrphan 清理无效 PID 文件", async () => {
    const fsMock = await import("node:fs");
    const osMock = await import("node:os");
    const pidFile = `${osMock.tmpdir()}/diri-whisper-server.pid`;
    fsMock.writeFileSync(pidFile, "999999");
    const killSpy = vi.spyOn(process, "kill");

    await (whisperServer as unknown as { killOrphan: () => void }).killOrphan();

    expect(fsMock.existsSync(pidFile)).toBe(false);
    killSpy.mockRestore();
  });
});
