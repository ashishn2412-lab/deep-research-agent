/**
 * Web search and page extraction — the agent's tools.
 *
 * Search providers are tried in order of quality, and every one of them is
 * optional except the last: Brave (key) -> Tavily (key) -> DuckDuckGo Lite
 * (keyless, best-effort scrape) -> Wikipedia API (keyless, always available).
 *
 * The Wikipedia fallback exists so a demo never shows zero sources on a flaky
 * network or when a scrape gets blocked.
 */

import { isDemoMode, demoSearchResults, demoPageText } from "./demo";

export type SearchResult = {
  url: string;
  title: string;
  snippet: string;
};

const USER_AGENT =
  "Mozilla/5.0 (compatible; DeepResearchAgent/1.0; +https://developers.cloudflare.com/agents/)";

/** Skip hosts that are never useful as research sources. */
const BLOCKED_HOSTS = [
  "pinterest.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
];

const FETCH_TIMEOUT_MS = 8000;

/**
 * Strip HTML tags and decode the handful of entities that show up in search
 * snippets. Output is only ever used as React text or model input, never as
 * HTML, so this is for readability rather than sanitisation.
 */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a search. Returns up to `limit` results, de-duplicated by URL.
 * Never throws: a provider failure falls through to the next provider.
 */
export async function search(
  env: Env,
  query: string,
  limit = 6,
): Promise<{ results: SearchResult[]; provider: string }> {
  if (isDemoMode(env)) {
    return { results: demoSearchResults(query).slice(0, limit), provider: "demo" };
  }

  const providers: { name: string; run: () => Promise<SearchResult[]> }[] = [];

  if (env.BRAVE_SEARCH_API_KEY) {
    providers.push({ name: "brave", run: () => searchBrave(env, query, limit) });
  }
  if (env.TAVILY_API_KEY) {
    providers.push({ name: "tavily", run: () => searchTavily(env, query, limit) });
  }
  providers.push({ name: "duckduckgo", run: () => searchDuckDuckGo(query, limit) });
  providers.push({ name: "wikipedia", run: () => searchWikipedia(query, limit) });

  for (const provider of providers) {
    try {
      const results = dedupe(await provider.run()).slice(0, limit);
      if (results.length > 0) return { results, provider: provider.name };
    } catch (err) {
      console.warn(`search provider ${provider.name} failed:`, String(err));
    }
  }

  return { results: [], provider: "none" };
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];

  for (const result of results) {
    let host: string;
    try {
      const parsed = new URL(result.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      host = parsed.hostname.replace(/^www\./, "");
    } catch {
      continue;
    }

    if (BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
      continue;
    }

    const key = result.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }

  return out;
}

async function searchBrave(
  env: Env,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(limit, 20)));

  const res = await fetchWithTimeout(url.toString(), {
    headers: {
      accept: "application/json",
      "x-subscription-token": env.BRAVE_SEARCH_API_KEY!,
    },
  });
  if (!res.ok) throw new Error(`brave ${res.status}`);

  const body = (await res.json()) as {
    web?: { results?: { url: string; title: string; description?: string }[] };
  };

  return (body.web?.results ?? []).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: stripTags(r.description ?? ""),
  }));
}

async function searchTavily(
  env: Env,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({ query, max_results: limit, search_depth: "basic" }),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);

  const body = (await res.json()) as {
    results?: { url: string; title: string; content?: string }[];
  };

  return (body.results ?? []).map((r) => ({
    url: r.url,
    title: r.title,
    snippet: (r.content ?? "").slice(0, 400),
  }));
}

/**
 * Keyless fallback: scrape DuckDuckGo's Lite HTML endpoint. Best-effort — DDG
 * may rate-limit a datacentre IP, in which case we fall through to Wikipedia.
 */
async function searchDuckDuckGo(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const res = await fetchWithTimeout("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
  });
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`);

  const html = await res.text();
  const results: SearchResult[] = [];

  // Lite results are <a class="result-link" href="...">title</a> followed by a
  // <td class="result-snippet">snippet</td>.
  const linkPattern =
    /<a[^>]+class="result-link"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern =
    /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const snippets: string[] = [];
  for (const match of html.matchAll(snippetPattern)) {
    snippets.push(stripTags(match[1]));
  }

  let index = 0;
  for (const match of html.matchAll(linkPattern)) {
    const url = decodeDuckDuckGoUrl(match[1]);
    if (!url) continue;
    results.push({
      url,
      title: stripTags(match[2]) || url,
      snippet: snippets[index] ?? "",
    });
    index++;
    if (results.length >= limit * 2) break;
  }

  return results;
}

/** DDG wraps outbound links as /l/?uddg=<encoded>. Unwrap when present. */
function decodeDuckDuckGoUrl(href: string): string | null {
  try {
    const raw = href.startsWith("//") ? `https:${href}` : href;
    const parsed = new URL(raw, "https://lite.duckduckgo.com");
    const wrapped = parsed.searchParams.get("uddg");
    return wrapped ? decodeURIComponent(wrapped) : parsed.toString();
  } catch {
    return null;
  }
}

/** Keyless last resort. The Wikipedia search API needs no auth and no scraping. */
async function searchWikipedia(
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("srlimit", String(limit));
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const res = await fetchWithTimeout(url.toString());
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);

  const body = (await res.json()) as {
    query?: { search?: { title: string; snippet: string }[] };
  };

  return (body.query?.search ?? []).map((r) => ({
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    title: r.title,
    snippet: stripTags(r.snippet),
  }));
}

/**
 * Fetch a page and extract readable text using HTMLRewriter, the streaming
 * parser built into the Workers runtime. Script, style, nav and footer content
 * is dropped so the model sees prose rather than boilerplate.
 */
export async function readPage(
  env: Env,
  url: string,
  maxChars = 6000,
): Promise<{ text: string; title: string }> {
  if (isDemoMode(env)) {
    return { text: demoPageText(url), title: `Demo page for ${url}` };
  }

  const res = await fetchWithTimeout(url, {
    headers: { accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("text/plain")) {
    throw new Error(`unsupported content-type for ${url}: ${contentType}`);
  }

  const chunks: string[] = [];
  let charCount = 0;
  let title = "";
  let inTitle = false;

  const rewriter = new HTMLRewriter()
    .on("title", {
      element() {
        inTitle = true;
      },
      text(text) {
        if (inTitle) title += text.text;
        if (text.lastInTextNode) inTitle = false;
      },
    })
    .on("script, style, noscript, nav, footer, header, aside, form, svg", {
      // Returning nothing but removing the element drops its subtree text.
      element(element) {
        element.remove();
      },
    })
    .on("p, li, h1, h2, h3, h4, td, blockquote, pre, dd", {
      text(text) {
        if (charCount >= maxChars) return;
        const value = text.text.replace(/\s+/g, " ");
        if (!value.trim()) return;
        chunks.push(value);
        charCount += value.length;
        if (text.lastInTextNode) {
          chunks.push("\n");
        }
      },
    });

  // Drain the transformed body so the handlers above actually run.
  await rewriter.transform(res).text();

  const text = chunks
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, maxChars);

  return { text, title: title.replace(/\s+/g, " ").trim() };
}
