import { log, logError } from "../utils/logger";
import { config } from "../config/env";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v2/search";
const FETCH_TIMEOUT_MS = 15000;

/** 带超时的 fetch：防止第三方接口慢响应挂起 LLM 工具循环 */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

interface FirecrawlSearchResult {
  url?: string;
  title?: string;
  description?: string;
}
function simplifyQueryForFirecrawl(query: string): string {
  return query
    .replace(/site:\S+/gi, "")
    .replace(/"/g, "")
    .replace(/\s+OR\s+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function webSearch(query: string): Promise<string> {
  try {
    const firecrawlQuery = simplifyQueryForFirecrawl(query);
    log(`webSearch: attempting Firecrawl search for: "${firecrawlQuery}"${firecrawlQuery !== query ? ` (original: "${query}")` : ""}`);
    const response = await fetchWithTimeout(FIRECRAWL_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.firecrawl.apiKey}`,
      },
      body: JSON.stringify({
        query: firecrawlQuery,
        limit: 5,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Firecrawl HTTP ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      success: boolean;
      data?: {
        web?: FirecrawlSearchResult[];
        news?: Array<{ title?: string; url?: string; snippet?: string; date?: string }>;
      };
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "Firecrawl search failed");
    }

    const webResults = data.data?.web || [];
    const newsResults = data.data?.news || [];

    if (webResults.length === 0 && newsResults.length === 0) {
      return `没有找到关于「${query}」的搜索结果。`;
    }

    let output = "";
    let index = 1;

    for (const r of webResults.slice(0, 5)) {
      if (r.title || r.description) {
        output += `${index}. ${r.title || ""}\n${r.description || ""}${r.url ? "\n链接：" + r.url : ""}\n\n`;
        index++;
      }
    }

    if (newsResults.length > 0) {
      output += "相关新闻：\n";
      for (const n of newsResults.slice(0, 3)) {
        output += `• ${n.title || ""}${n.snippet ? " — " + n.snippet : ""}${n.date ? " (" + n.date + ")" : ""}\n`;
      }
    }

    return output.trim();
  } catch (error) {
    log(`Firecrawl search failed: ${error instanceof Error ? error.message : String(error)}. Falling back to DuckDuckGo search...`);
    try {
      const ddgResult = await ddgSearch(query);

      if (!ddgResult || ddgResult.length === 0) {
        return `没有找到关于「${query}」的搜索结果。`;
      }

      let output = "（已启用备用搜索引擎）\n";
      let index = 1;
      for (const r of ddgResult.slice(0, 5)) {
        output += `${index}. ${r.title || ""}\n${r.description || ""}${r.url ? "\n链接：" + r.url : ""}\n\n`;
        index++;
      }
      return output.trim();
    } catch (ddgError) {
      logError("DuckDuckGo fallback search failed", ddgError);
      return `搜索失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

interface DDGResult {
  title?: string;
  description?: string;
  url?: string;
}

async function ddgSearch(query: string): Promise<DDGResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo HTTP ${response.status}`);
  }

  const html = await response.text();
  const results: DDGResult[] = [];

  const resultRegex = /<a[^>]+class="result__a"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>[\s\S]*?href="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
    const title = match[1].replace(/<[^>]+>/g, "").trim();
    const description = match[2].replace(/<[^>]+>/g, "").trim();
    const link = match[3].trim();
    results.push({ title, description, url: link });
  }

  if (results.length === 0) {
    const fallbackRegex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = fallbackRegex.exec(html)) !== null && results.length < 8) {
      const link = match[1].trim();
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      if (title) results.push({ title, url: link });
    }
  }

  return results;
}

export async function searchWallpapers(query: string): Promise<string> {
  try {
    log(`searchWallpapers: querying Wallhaven for "${query}"`);
    const response = await fetchWithTimeout(`https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      throw new Error(`Wallhaven HTTP ${response.status}`);
    }
    const data = await response.json() as {
      data?: Array<{
        id: string;
        resolution: string;
        path: string;
        url: string;
      }>;
    };

    const wallpapers = data.data || [];
    if (wallpapers.length === 0) {
      return `没有找到关于「${query}」的高清壁纸。`;
    }

    let output = `找到以下关于「${query}」的高清壁纸（您可以直接使用 curl 命令下载其直接图片链接到桌面）：\n\n`;
    for (let i = 0; i < Math.min(wallpapers.length, 5); i++) {
      const w = wallpapers[i];
      output += `${i + 1}. 分辨率: ${w.resolution}\n`;
      output += `   直接图片链接: ${w.path}\n`;
      output += `   壁纸网页: ${w.url}\n\n`;
    }
    return output.trim();
  } catch (error) {
    // Wallhaven 在部分网络下不可达（fetch failed / 超时），自动降级到 DuckDuckGo 图片搜索
    logError("searchWallpapers: Wallhaven failed, falling back to DuckDuckGo images", error);
    try {
      return await searchWallpapersViaDuckDuckGo(query);
    } catch (fallbackError) {
      logError("searchWallpapers: DuckDuckGo fallback failed too", fallbackError);
      return `搜索壁纸失败（Wallhaven 与 DuckDuckGo 图片源均不可达）: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/** DuckDuckGo 图片搜索兜底：Wallhaven 不可达时直接返回可下载的图片直链 */
async function searchWallpapersViaDuckDuckGo(query: string): Promise<string> {
  log(`searchWallpapers: DuckDuckGo images fallback for "${query}"`);
  const response = await fetchWithTimeout(
    `https://duckduckgo.com/i.js?q=${encodeURIComponent(query + " 壁纸")}&o=json&f=,type:wallpaper`,
    { headers: { "Referer": "https://duckduckgo.com/", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
  );
  if (!response.ok) {
    throw new Error(`DuckDuckGo HTTP ${response.status}`);
  }
  const data = await response.json() as {
    results?: Array<{ image: string; thumbnail: string; title: string; width?: number; height?: number }>;
  };

  const results = (data.results || []).filter((r) => r.image && /^https?:\/\//.test(r.image));
  if (results.length === 0) {
    return `没有找到关于「${query}」的高清壁纸。`;
  }

  let output = `找到以下关于「${query}」的壁纸（可直接下载直链图片到桌面）：\n\n`;
  for (let i = 0; i < Math.min(results.length, 5); i++) {
    const r = results[i];
    const dim = r.width && r.height ? `${r.width}x${r.height}` : "未知分辨率";
    output += `${i + 1}. 分辨率: ${dim}\n`;
    output += `   直接图片链接: ${r.image}\n\n`;
  }
  return output.trim();
}

export async function scrapeUrl(url: string): Promise<string> {
  try {
    log(`scrapeUrl: attempting Firecrawl scrape for: "${url}"`);
    const response = await fetchWithTimeout("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.firecrawl.apiKey}`,
      },
      body: JSON.stringify({
        url: url,
        formats: ["markdown"],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Firecrawl HTTP ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      success: boolean;
      data?: {
        markdown?: string;
        metadata?: Record<string, unknown>;
      };
      error?: string;
    };

    if (!data.success) {
      throw new Error(data.error || "Firecrawl scrape failed");
    }

    return data.data?.markdown || "网页抓取成功，但未返回内容。";
  } catch (error) {
    logError(`scrapeUrl failed: ${error instanceof Error ? error.message : String(error)}`);
    return `网页抓取失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
