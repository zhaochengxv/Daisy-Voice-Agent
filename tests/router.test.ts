import { describe, it, expect } from "vitest";
import {
  parseKnownSiteSearch,
  findKnownSiteHome,
  isSaveClipboardImageToDesktopCommand,
} from "../src/main/command/router";

describe("parseKnownSiteSearch", () => {
  it("打开抖音搜索世界杯", () => {
    const r = parseKnownSiteSearch("打开抖音搜索世界杯");
    expect(r).not.toBeNull();
    expect(r!.siteName).toBe("抖音");
    expect(r!.query).toBe("世界杯");
    expect(r!.url).toContain("douyin.com");
  });

  it("浏览器前缀 + 打开 b 站搜索深度学习", () => {
    const r = parseKnownSiteSearch("在浏览器里打开b站搜索 深度学习");
    expect(r?.siteName).toBe("哔哩哔哩");
    expect(r?.query).toBe("深度学习");
    expect(r?.url).toContain("bilibili.com");
  });

  it("帮我百度搜索 房价", () => {
    const r = parseKnownSiteSearch("帮我百度搜索 房价");
    expect(r?.siteName).toBe("百度");
    expect(r?.query).toBe("房价");
  });

  it("查询含 & 与中文均正确编码", () => {
    const r = parseKnownSiteSearch("打开B站搜索 a&b 测试");
    expect(r?.url).toContain("a%26b");
    expect(r?.url).toContain("%E6%B5%8B%E8%AF%95");
  });

  it("无站点名返回 null", () => {
    expect(parseKnownSiteSearch("搜索电影")).toBeNull();
  });

  it("无搜索动词返回 null", () => {
    expect(parseKnownSiteSearch("打开百度")).toBeNull();
  });
});

describe("findKnownSiteHome", () => {
  it("豆包 → doubao 首页", () => {
    expect(findKnownSiteHome("豆包")?.url).toBe("https://www.doubao.com/");
  });

  it("视频号 → channels 首页", () => {
    expect(findKnownSiteHome("视频号")?.url).toBe("https://channels.weixin.qq.com/");
  });

  it("未知站点返回 null", () => {
    expect(findKnownSiteHome("不存在的站点xyz")).toBeNull();
  });
});

describe("isSaveClipboardImageToDesktopCommand", () => {
  it("识别保存截图到桌面", () => {
    expect(isSaveClipboardImageToDesktopCommand("把截图保存到桌面")).toBe(true);
  });

  it("识别复制的图片存到桌面", () => {
    expect(isSaveClipboardImageToDesktopCommand("把刚才复制的图片存到桌面")).toBe(true);
  });

  it("普通命令不误判", () => {
    expect(isSaveClipboardImageToDesktopCommand("打开微信")).toBe(false);
  });
});
