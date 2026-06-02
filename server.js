const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^(?:[-*]\s*)?[*_`]*([A-Z][A-Z0-9_]{2,})[*_`]*\s*[:=]\s*(.+)$/);
    if (!match) return;
    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[key] && value) process.env[key] = value;
  });
}

const ROOT = __dirname;
loadEnvFile(path.join(ROOT, ".env"));
loadEnvFile(path.join(ROOT, ".env.local"));

const PUBLIC_DIR = path.join(ROOT, "public");
const APP_VERSION = "1.0.0";
const DEFAULT_PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 9000);
const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_SECONDS || 3600) * 1000;
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS || 8);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 256 * 1024);
const CONTENT_SOURCE_FILE = process.env.CONTENT_SOURCE_FILE || "recipe-urls.md";
const CONTENT_SOURCE_URL_LIMIT = Number(process.env.CONTENT_SOURCE_URL_LIMIT || 80);
const MAX_QUERY_LENGTH = 180;
const searchCache = new Map();
let activeCrawlPromise = null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const blockedHosts = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
]);

function securityHeaders(extra = {}) {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https: http:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    ...extra,
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, securityHeaders({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  }));
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
  res.end(text);
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureDataDir();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function normalizeClientId(value) {
  const candidate = String(value || "").trim();
  if (/^[a-zA-Z0-9_-]{8,80}$/.test(candidate)) return candidate;
  return "";
}

function userStatePath(clientId) {
  return path.join(DATA_DIR, `user-${clientId}.json`);
}

function normalizeUserState(input = {}) {
  const favorites = Array.isArray(input.favorites)
    ? input.favorites.map((item) => String(item).slice(0, 120)).filter(Boolean).slice(0, 2000)
    : [];
  const notes = input.notes && typeof input.notes === "object" && !Array.isArray(input.notes) ? input.notes : {};
  const cleanNotes = {};
  Object.entries(notes).slice(0, 1000).forEach(([key, value]) => {
    cleanNotes[String(key).slice(0, 120)] = String(value || "").slice(0, 4000);
  });
  return {
    favorites: [...new Set(favorites)],
    notes: cleanNotes,
    updatedAt: new Date().toISOString(),
  };
}

function getCached(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  searchCache.set(key, { createdAt: Date.now(), value });
  if (searchCache.size > 200) {
    const oldest = [...searchCache.keys()].slice(0, searchCache.size - 200);
    oldest.forEach((item) => searchCache.delete(item));
  }
}

function stableId(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function parseCsv(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function contentSourcePath() {
  return path.isAbsolute(CONTENT_SOURCE_FILE)
    ? CONTENT_SOURCE_FILE
    : path.join(ROOT, CONTENT_SOURCE_FILE);
}

function relativeContentSourcePath() {
  const sourcePath = contentSourcePath();
  return path.isAbsolute(CONTENT_SOURCE_FILE)
    ? sourcePath
    : CONTENT_SOURCE_FILE.replace(/\\/g, "/");
}

function ensureContentSourceFile() {
  const sourcePath = contentSourcePath();
  if (fs.existsSync(sourcePath)) return;
  fs.writeFileSync(
    sourcePath,
    [
      "# 食譜來源網址",
      "",
      "把要擷取的食譜網址貼在這個檔案裡，一行一個或使用 Markdown 清單都可以。",
      "按網頁上的「內容更新」後，系統會依照這份清單重新擷取內容。",
      "",
      "```text",
      "https://example.com/your-recipe-page",
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
}

function stripMarkdownCodeBlocks(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function normalizeUrlCandidate(value) {
  return String(value || "")
    .trim()
    .replace(/[)\].,，。;；:：!?！？]+$/g, "");
}

function extractUrlsFromMarkdown(markdown) {
  const text = stripMarkdownCodeBlocks(markdown);
  const urls = [];
  const regex = /https?:\/\/[^\s<>"']+/gi;
  let match;
  while ((match = regex.exec(text))) {
    const normalized = normalizeUrlCandidate(match[0]);
    const target = safeUrl(normalized);
    if (target) urls.push(target.toString());
  }
  return dedupe(urls).slice(0, CONTENT_SOURCE_URL_LIMIT);
}

function readContentSource() {
  ensureContentSourceFile();
  const sourcePath = contentSourcePath();
  const markdown = fs.readFileSync(sourcePath, "utf8");
  const urls = extractUrlsFromMarkdown(markdown);
  return {
    path: sourcePath,
    relativePath: relativeContentSourcePath(),
    urls,
    updatedAt: fs.statSync(sourcePath).mtime.toISOString(),
  };
}

function crawlIndexPath() {
  return path.join(DATA_DIR, "crawl-index.json");
}

function emptyCrawlIndex() {
  const now = new Date().toISOString();
  return {
    version: 1,
    status: "idle",
    items: [],
    queries: [],
    sourceFile: relativeContentSourcePath(),
    sourceUrls: [],
    lastStartedAt: "",
    lastFinishedAt: "",
    nextRunAt: "",
    lastError: "",
    runs: [],
    updatedAt: now,
  };
}

function readCrawlIndex() {
  const index = safeReadJson(crawlIndexPath(), emptyCrawlIndex());
  const hasModernSource = Boolean(index.sourceFile || Array.isArray(index.sourceUrls));
  return {
    ...emptyCrawlIndex(),
    ...index,
    queries: Array.isArray(index.queries) ? index.queries : [],
    sourceFile: index.sourceFile || relativeContentSourcePath(),
    sourceUrls: Array.isArray(index.sourceUrls) ? index.sourceUrls : [],
    items: hasModernSource && Array.isArray(index.items) ? index.items : [],
    runs: hasModernSource && Array.isArray(index.runs) ? index.runs : [],
    lastStartedAt: hasModernSource ? index.lastStartedAt || "" : "",
    lastFinishedAt: hasModernSource ? index.lastFinishedAt || "" : "",
    lastError: hasModernSource ? index.lastError || "" : "",
  };
}

function writeCrawlIndex(index) {
  writeJsonAtomic(crawlIndexPath(), {
    ...index,
    updatedAt: new Date().toISOString(),
  });
}

function recipeKey(recipe) {
  return String(recipe.canonicalUrl || recipe.sourceUrl || recipe.title || "").replace(/[#?].*$/, "").toLowerCase();
}

function mergeCrawledItems(existingItems, newItems, query) {
  const byKey = new Map();
  existingItems.forEach((item) => byKey.set(recipeKey(item), item));
  newItems.forEach((item) => {
    const key = recipeKey(item);
    const current = byKey.get(key) || {};
    byKey.set(key, {
      ...current,
      ...item,
      crawlQuery: item.crawlQuery || query || current.crawlQuery || "",
      crawledAt: new Date().toISOString(),
    });
  });
  return [...byKey.values()]
    .sort((a, b) => Number(b.quality || 0) - Number(a.quality || 0))
    .slice(0, 300);
}

function searchCrawledRecipes(query = "") {
  const index = readCrawlIndex();
  const normalized = query.trim().toLowerCase();
  const items = index.items.length ? index.items : [];
  if (!normalized) return items.slice(0, MAX_SEARCH_RESULTS);
  const terms = normalized.split(/\s+/);
  return items
    .filter((recipe) => {
      const haystack = `${recipe.title} ${recipe.source} ${recipe.description} ${(recipe.tags || []).join(" ")} ${(recipe.ingredients || []).join(" ")}`.toLowerCase();
      return terms.some((term) => haystack.includes(term));
    })
    .slice(0, MAX_SEARCH_RESULTS);
}

function persistCrawledItems(items, query) {
  if (!items.length) return;
  const index = readCrawlIndex();
  writeCrawlIndex({
    ...index,
    status: activeCrawlPromise ? "running" : "idle",
    items: mergeCrawledItems(index.items, items, query),
  });
}

function safeUrl(rawUrl) {
  try {
    const target = new URL(rawUrl);
    if (!["http:", "https:"].includes(target.protocol)) return null;
    const hostname = target.hostname.toLowerCase();
    if (blockedHosts.has(hostname)) return null;
    if (/^(10|127)\./.test(hostname)) return null;
    if (/^192\.168\./.test(hostname)) return null;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return null;
    return target;
  } catch {
    return null;
  }
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function cleanText(value = "") {
  return decodeEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value = "") {
  return cleanText(value).replace(/\s+/g, " ").trim();
}

function dedupe(list) {
  const seen = new Set();
  return list
    .map((item) => String(item || "").trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeCharset(label = "") {
  const compact = String(label || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!compact) return "";
  if (["utf8", "utf-8", "unicode11utf8"].includes(compact)) return "utf-8";
  if (["big5", "big-5", "cp950", "ms950", "windows950", "x-x-big5"].includes(compact)) return "big5";
  if (["gb2312", "gbk", "gb18030", "chinesesimplified"].includes(compact)) return "gb18030";
  if (["shiftjis", "shift_jis", "sjis", "windows31j"].includes(compact)) return "shift_jis";
  return label.trim().toLowerCase();
}

function charsetFromContentType(contentType = "") {
  const match = String(contentType).match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return normalizeCharset(match?.[1] || "");
}

function charsetFromHtmlBytes(bytes) {
  const sample = Buffer.from(bytes).subarray(0, 32768).toString("latin1");
  const match = sample.match(/charset\s*=\s*["']?([^;"'>\s]+)/i);
  return normalizeCharset(match?.[1] || "");
}

function decodeBytes(bytes, encoding) {
  try {
    return new TextDecoder(encoding || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function replacementCount(text) {
  return (String(text).match(/\uFFFD/g) || []).length;
}

function decodeResponseText(bytes, contentType = "") {
  const headerCharset = charsetFromContentType(contentType);
  const metaCharset = charsetFromHtmlBytes(bytes);
  const explicitCharset = headerCharset || metaCharset;
  if (explicitCharset) return decodeBytes(bytes, explicitCharset);

  const utf8 = decodeBytes(bytes, "utf-8");
  if (!replacementCount(utf8)) return utf8;

  const candidates = ["big5", "gb18030"].map((encoding) => ({
    encoding,
    text: decodeBytes(bytes, encoding),
  }));
  const best = candidates.sort((a, b) => replacementCount(a.text) - replacementCount(b.text))[0];
  return best && replacementCount(best.text) < replacementCount(utf8) ? best.text : utf8;
}

async function fetchText(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 RecipeCrawler/1.0",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
        "accept-language": "zh-TW,zh;q=0.9,en;q=0.7",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!/text\/html|application\/xhtml|application\/json|text\/plain/i.test(contentType)) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return decodeResponseText(bytes, contentType);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, headers = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "application/json",
        "accept-language": "zh-TW,zh;q=0.9,en;q=0.7",
        ...headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${stripTags(text).slice(0, 180)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("API did not return valid JSON.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function parseMaybeJson(value) {
  const text = value
    .replace(/^\s*<!--/, "")
    .replace(/-->\s*$/, "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    const fixed = text.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

function flattenJsonLd(node, output = []) {
  if (!node) return output;
  if (Array.isArray(node)) {
    node.forEach((item) => flattenJsonLd(item, output));
    return output;
  }
  if (typeof node !== "object") return output;
  output.push(node);
  if (node["@graph"]) flattenJsonLd(node["@graph"], output);
  if (node.mainEntity) flattenJsonLd(node.mainEntity, output);
  if (node.itemListElement) flattenJsonLd(node.itemListElement, output);
  return output;
}

function isRecipeNode(node) {
  const type = node && node["@type"];
  if (Array.isArray(type)) return type.some((item) => String(item).toLowerCase() === "recipe");
  return String(type || "").toLowerCase() === "recipe";
}

function extractJsonLdRecipes(html) {
  const recipes = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const parsed = parseMaybeJson(decodeEntities(match[1]));
    if (!parsed) continue;
    flattenJsonLd(parsed).forEach((node) => {
      if (isRecipeNode(node)) recipes.push(node);
    });
  }
  return recipes;
}

function normalizeInstruction(step) {
  if (!step) return "";
  if (typeof step === "string") return stripTags(step);
  if (Array.isArray(step)) return step.map(normalizeInstruction).filter(Boolean).join(" ");
  if (typeof step === "object") {
    if (step.text) return stripTags(step.text);
    if (step.name && step.itemListElement) {
      return [step.name, normalizeInstruction(step.itemListElement)].filter(Boolean).join(" ");
    }
    if (step.itemListElement) return normalizeInstruction(step.itemListElement);
    if (step.description) return stripTags(step.description);
  }
  return "";
}

function parseDuration(value = "") {
  const text = String(value || "");
  if (!text) return "";
  const hours = Number((text.match(/(\d+(?:\.\d+)?)H/i) || [0, 0])[1] || 0);
  const minutes = Number((text.match(/(\d+(?:\.\d+)?)M/i) || [0, 0])[1] || 0);
  const total = Math.round(hours * 60 + minutes);
  if (!total) return stripTags(text);
  if (total >= 60) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m ? `${h} 小時 ${m} 分鐘` : `${h} 小時`;
  }
  return `${total} 分鐘`;
}

function getMeta(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]).trim();
  }
  return "";
}

function absolutizeUrl(maybeUrl, baseUrl) {
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return "";
  }
}

function titleFromHtml(html) {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) return stripTags(title[1]).replace(/\s*[-|｜]\s*.*$/, "");
  return "";
}

function listItemsFromSection(html, keywords) {
  const chunks = [];
  const keywordPattern = keywords.join("|");
  const sectionRegex = new RegExp(
    `<(?:section|div|article)[^>]*(?:id|class)=["'][^"']*(?:${keywordPattern})[^"']*["'][^>]*>([\\s\\S]{0,12000}?)<\\/(?:section|div|article)>`,
    "gi",
  );
  let sectionMatch;
  while ((sectionMatch = sectionRegex.exec(html))) {
    chunks.push(sectionMatch[1]);
  }

  const headingRegex = new RegExp(
    `<h[2-4][^>]*>\\s*(?:${keywordPattern})[\\s\\S]*?<\\/h[2-4]>([\\s\\S]{0,10000}?)(?=<h[2-4]|<footer|<aside|$)`,
    "gi",
  );
  let headingMatch;
  while ((headingMatch = headingRegex.exec(html))) {
    chunks.push(headingMatch[1]);
  }

  const items = [];
  for (const chunk of chunks) {
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(chunk))) {
      const text = stripTags(liMatch[1]);
      if (text.length >= 2 && text.length <= 90) items.push(text);
    }
  }
  return dedupe(items).slice(0, 24);
}

function inferIngredientLines(text) {
  const quantityPattern =
    /(匙|匙|大匙|小匙|茶匙|杯|碗|顆|粒|瓣|片|把|支|根|朵|份|包|罐|克|g|kg|ml|毫升|公克|少許|適量|一點|半|兩|斤|\d)/i;
  return dedupe(
    text
      .split(/[\n。；;]+/)
      .map((line) => line.trim().replace(/^[-*•\d.、\s]+/, ""))
      .filter((line) => line.length >= 2 && line.length <= 70 && quantityPattern.test(line))
      .filter((line) => !/(步驟|做法|料理|食譜|留言|收藏|分享|廣告|登入|註冊)/.test(line)),
  ).slice(0, 18);
}

function inferSteps(html, text) {
  const steps = listItemsFromSection(html, ["instruction", "method", "direction", "step", "做法", "步驟", "作法", "料理"]);
  if (steps.length >= 2) return steps.slice(0, 16);

  const orderedItems = [];
  const olRegex = /<ol[^>]*>([\s\S]*?)<\/ol>/gi;
  let olMatch;
  while ((olMatch = olRegex.exec(html))) {
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(olMatch[1]))) {
      const item = stripTags(liMatch[1]);
      if (item.length >= 6 && item.length <= 180) orderedItems.push(item);
    }
  }
  if (orderedItems.length >= 2) return dedupe(orderedItems).slice(0, 16);

  const stepish = text
    .split(/(?=\d+[.、\s])|[。；;]\s*/)
    .map((line) => line.trim().replace(/^\d+[.、\s]*/, ""))
    .filter((line) => line.length >= 8 && line.length <= 160)
    .filter((line) => /(加入|放入|攪拌|煮|炒|烤|蒸|切|備用|調味|拌|倒入|煎|燉|汆|mix|cook|bake|boil|fry)/i.test(line));
  return dedupe(stepish).slice(0, 10);
}

function mapJsonLdRecipe(recipe, url, html) {
  const instructions = Array.isArray(recipe.recipeInstructions)
    ? recipe.recipeInstructions.map(normalizeInstruction).filter(Boolean)
    : normalizeInstruction(recipe.recipeInstructions)
        .split(/\n+|(?<=。)/)
        .map((item) => item.trim())
        .filter(Boolean);

  const image = Array.isArray(recipe.image)
    ? recipe.image[0]?.url || recipe.image[0]
    : recipe.image?.url || recipe.image || getMeta(html, "og:image");

  return {
    title: stripTags(recipe.name || titleFromHtml(html) || new URL(url).hostname),
    source: stripTags(recipe.author?.name || recipe.publisher?.name || new URL(url).hostname.replace(/^www\./, "")),
    sourceUrl: url,
    canonicalUrl: getMeta(html, "og:url") || url,
    description: stripTags(recipe.description || getMeta(html, "description") || ""),
    image: image ? absolutizeUrl(image, url) : "",
    ingredients: dedupe(recipe.recipeIngredient || []).slice(0, 32),
    steps: dedupe(instructions).slice(0, 24),
    servings: stripTags(recipe.recipeYield || recipe.yield || ""),
    time:
      parseDuration(recipe.totalTime) ||
      parseDuration(recipe.cookTime) ||
      parseDuration(recipe.prepTime) ||
      "",
    difficulty: inferDifficulty(recipe.name || "", instructions.join(" ")),
    tags: dedupe([
      ...(Array.isArray(recipe.recipeCategory) ? recipe.recipeCategory : [recipe.recipeCategory]),
      ...(Array.isArray(recipe.recipeCuisine) ? recipe.recipeCuisine : [recipe.recipeCuisine]),
    ]).slice(0, 6),
    quality: 0,
    extractedFrom: "json-ld",
  };
}

function inferDifficulty(title, body) {
  const text = `${title} ${body}`;
  if (/(新手|簡單|easy|quick|零失敗|懶人|快速)/i.test(text)) return "簡單";
  if (/(進階|困難|發酵|舒肥|低溫|千層|酥皮)/i.test(text)) return "困難";
  return "普通";
}

function scoreRecipe(recipe) {
  let score = 35;
  if (recipe.extractedFrom === "json-ld") score += 25;
  score += Math.min(recipe.ingredients.length * 4, 20);
  score += Math.min(recipe.steps.length * 4, 20);
  if (recipe.time) score += 5;
  if (recipe.image) score += 5;
  if (recipe.description) score += 3;
  return Math.max(35, Math.min(98, score));
}

function inferTimeFromText(text) {
  const match = text.match(/(\d{1,3})\s*(?:分鐘|分|min|minutes?)/i);
  if (match) return `${match[1]} 分鐘`;
  const hour = text.match(/(\d(?:\.\d)?)\s*(?:小時|hour|hr)/i);
  if (hour) return `${hour[1]} 小時`;
  return "";
}

function extractRecipeFromHtml(html, url) {
  const jsonLdRecipes = extractJsonLdRecipes(html);
  if (jsonLdRecipes.length) {
    const mapped = mapJsonLdRecipe(jsonLdRecipes[0], url, html);
    mapped.quality = scoreRecipe(mapped);
    return mapped;
  }

  const plainText = cleanText(html.replace(/<\/(p|li|h[1-6]|div|section|article|br)>/gi, "\n"));
  const ingredients =
    listItemsFromSection(html, ["ingredient", "recipeIngredient", "材料", "食材", "配料"]) ||
    [];
  const fallbackIngredients = ingredients.length ? ingredients : inferIngredientLines(plainText);
  const steps = inferSteps(html, plainText);
  const title = titleFromHtml(html) || getMeta(html, "og:title") || new URL(url).hostname;
  const description = getMeta(html, "description") || getMeta(html, "og:description") || "";
  const image = getMeta(html, "og:image");
  const recipe = {
    title,
    source: new URL(url).hostname.replace(/^www\./, ""),
    sourceUrl: url,
    canonicalUrl: getMeta(html, "og:url") || url,
    description: stripTags(description),
    image: image ? absolutizeUrl(image, url) : "",
    ingredients: fallbackIngredients,
    steps,
    servings: "",
    time: inferTimeFromText(`${title} ${description} ${plainText.slice(0, 2500)}`),
    difficulty: inferDifficulty(title, plainText.slice(0, 2500)),
    tags: [],
    quality: 0,
    extractedFrom: "heuristic",
  };
  recipe.quality = scoreRecipe(recipe) - 10;
  return recipe;
}

async function extractFromUrl(rawUrl) {
  const target = safeUrl(rawUrl);
  if (!target) {
    throw new Error("網址格式不支援，或指向本機/私有網段。");
  }
  const html = await fetchText(target.toString());
  const recipe = extractRecipeFromHtml(html, target.toString());
  if (!recipe.ingredients.length && !recipe.steps.length) {
    recipe.warning = "沒有找到明確的材料或步驟，可能需要打開原文確認。";
  }
  return recipe;
}

async function enrichSearchResults(results) {
  const queue = results.slice(0, 6);
  const enriched = [];
  for (const result of queue) {
    try {
      const recipe = await extractFromUrl(result.url);
      enriched.push({
        ...recipe,
        searchTitle: result.title,
        source: recipe.source || result.source,
      });
    } catch (error) {
      enriched.push({
        title: result.title,
        source: result.source,
        sourceUrl: result.url,
        canonicalUrl: result.url,
        description: "可打開來源查看完整內容；這個頁面未能自動抽取結構化食譜。",
        image: "",
        ingredients: [],
        steps: [],
        servings: "",
        time: "",
        difficulty: "普通",
        tags: [],
        quality: 45,
        extractedFrom: "link-only",
        warning: error.message,
      });
    }
  }
  return enriched.sort((a, b) => b.quality - a.quality);
}

async function runContentUpdate(reason = "manual") {
  if (activeCrawlPromise) return activeCrawlPromise;

  activeCrawlPromise = (async () => {
    const startedAt = new Date().toISOString();
    const index = readCrawlIndex();
    const source = readContentSource();
    writeCrawlIndex({
      ...index,
      status: "running",
      lastStartedAt: startedAt,
      lastError: "",
      queries: source.urls,
      sourceFile: source.relativePath,
      sourceUrls: source.urls,
      nextRunAt: "",
    });

    const errors = [];
    let collected = [];

    if (!source.urls.length) {
      errors.push(`${source.relativePath} 沒有可用網址。請把食譜頁面網址貼進 MD 檔後再更新。`);
    }

    for (const sourceUrl of source.urls) {
      try {
        const recipe = await extractFromUrl(sourceUrl);
        const sourceItem = {
          ...recipe,
          crawlQuery: "MD 網址清單",
          sourceListUrl: sourceUrl,
        };
        collected = mergeCrawledItems(collected, [sourceItem], "MD 網址清單");
        writeCrawlIndex({
          ...readCrawlIndex(),
          status: "running",
          items: collected,
          lastStartedAt: startedAt,
          queries: source.urls,
          sourceFile: source.relativePath,
          sourceUrls: source.urls,
          nextRunAt: "",
        });
      } catch (error) {
        errors.push(`${sourceUrl}: ${error.message}`);
      }
    }

    const finishedAt = new Date().toISOString();
    const finalItems = collected.length ? collected : (source.urls.length ? index.items || [] : []);
    const completedIndex = {
      ...readCrawlIndex(),
      status: errors.length && !collected.length ? "error" : "idle",
      items: finalItems,
      queries: source.urls,
      sourceFile: source.relativePath,
      sourceUrls: source.urls,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      nextRunAt: "",
      lastError: errors.join("；"),
      runs: [
        {
          reason,
          startedAt,
          finishedAt,
          sourceFile: source.relativePath,
          sourceUrlCount: source.urls.length,
          updatedItemCount: collected.length,
          itemCount: finalItems.length,
          errorCount: errors.length,
        },
        ...readCrawlIndex().runs,
      ].slice(0, 20),
    };
    writeCrawlIndex(completedIndex);
    searchCache.clear();
    return completedIndex;
  })();

  try {
    return await activeCrawlPromise;
  } finally {
    activeCrawlPromise = null;
  }
}

async function runDailyCrawl(reason = "manual") {
  return runContentUpdate(reason);
}

function publicCrawlStatus() {
  const index = readCrawlIndex();
  const source = readContentSource();
  return {
    status: activeCrawlPromise ? "running" : index.status,
    queries: source.urls,
    sourceFile: source.relativePath,
    sourceUrlCount: source.urls.length,
    sourceUrls: source.urls,
    itemCount: index.items.length,
    lastStartedAt: index.lastStartedAt,
    lastFinishedAt: index.lastFinishedAt,
    nextRunAt: "",
    lastError: index.lastError,
    runs: index.runs.slice(0, 5),
  };
}

const sampleRecipes = [
  {
    title: "番茄炒蛋",
    source: "示範資料",
    sourceUrl: "https://example.com/tomato-egg",
    canonicalUrl: "https://example.com/tomato-egg",
    description: "酸甜番茄與滑嫩蛋花，適合 15 分鐘晚餐。",
    image: "",
    ingredients: ["番茄 2 顆", "雞蛋 3 顆", "蔥 1 支", "蒜頭 2 瓣", "番茄醬 1 小匙", "鹽 1/4 小匙", "糖 1/2 小匙", "食用油 2 大匙"],
    steps: [
      "番茄洗淨切塊，蔥切段，蒜頭切末，雞蛋打散備用。",
      "熱鍋加入 1 大匙油，倒入蛋液炒至半熟後盛起。",
      "原鍋補少許油，爆香蒜末與蔥白。",
      "放入番茄塊翻炒至出汁，加入番茄醬、鹽與糖調味。",
      "倒回炒好的蛋，輕拌均勻，撒上蔥綠即可。",
    ],
    servings: "2-3 人份",
    time: "15 分鐘",
    difficulty: "簡單",
    tags: ["家常菜", "下飯菜"],
    quality: 95,
    extractedFrom: "sample",
  },
  {
    title: "日式咖哩雞",
    source: "示範資料",
    sourceUrl: "https://example.com/japanese-curry",
    canonicalUrl: "https://example.com/japanese-curry",
    description: "濃厚咖哩與軟嫩雞腿，適合一次煮多份。",
    image: "",
    ingredients: ["去骨雞腿 2 片", "洋蔥 1 顆", "馬鈴薯 2 顆", "紅蘿蔔 1 根", "咖哩塊 4 小塊", "水 700 ml", "蘋果泥 2 大匙"],
    steps: [
      "雞腿切塊並擦乾，蔬菜切成入口大小。",
      "鍋中煎香雞腿，加入洋蔥炒至透明。",
      "放入馬鈴薯與紅蘿蔔，倒水煮滾後轉小火。",
      "蔬菜變軟後關火，放入咖哩塊攪拌溶解。",
      "重新小火煮 8 分鐘，加入蘋果泥調整甜度。",
    ],
    servings: "4 人份",
    time: "45 分鐘",
    difficulty: "普通",
    tags: ["日式", "便當"],
    quality: 91,
    extractedFrom: "sample",
  },
  {
    title: "清燉牛肉麵",
    source: "示範資料",
    sourceUrl: "https://example.com/beef-noodle",
    canonicalUrl: "https://example.com/beef-noodle",
    description: "湯頭清爽，牛腱慢燉到軟嫩。",
    image: "",
    ingredients: ["牛腱 600 g", "白蘿蔔 1/2 條", "薑片 5 片", "蔥 2 支", "米酒 2 大匙", "鹽 適量", "麵條 2 份", "青菜 適量"],
    steps: [
      "牛腱汆燙後洗淨浮沫。",
      "鍋中加入牛腱、薑片、蔥段、米酒與足量清水。",
      "小火燉煮約 90 分鐘，加入白蘿蔔續煮至透明。",
      "以鹽調味，牛腱切片。",
      "麵條煮熟後盛碗，加入湯、牛肉、蘿蔔與青菜。",
    ],
    servings: "2 人份",
    time: "2 小時",
    difficulty: "普通",
    tags: ["台式", "麵食", "湯類"],
    quality: 88,
    extractedFrom: "sample",
  },
  {
    title: "免烤提拉米蘇",
    source: "示範資料",
    sourceUrl: "https://example.com/tiramisu",
    canonicalUrl: "https://example.com/tiramisu",
    description: "不需烤箱，冷藏後風味更融合。",
    image: "",
    ingredients: ["馬斯卡彭 250 g", "鮮奶油 200 ml", "糖 40 g", "手指餅乾 12 根", "濃縮咖啡 120 ml", "可可粉 適量"],
    steps: [
      "鮮奶油與糖打至有紋路，拌入馬斯卡彭。",
      "手指餅乾快速沾咖啡，鋪入容器底部。",
      "抹上一層乳酪糊，再重複餅乾與乳酪糊。",
      "冷藏至少 4 小時。",
      "食用前撒上可可粉。",
    ],
    servings: "4 人份",
    time: "30 分鐘 + 冷藏",
    difficulty: "簡單",
    tags: ["甜點", "免烤"],
    quality: 86,
    extractedFrom: "sample",
  },
];

const fallbackRecipeCatalog = [
  ...sampleRecipes,
  {
    title: "滷肉飯",
    source: "備援資料",
    sourceUrl: "",
    canonicalUrl: "fallback://lu-rou-fan",
    description: "鹹香滷肉淋在白飯上，適合一次滷一鍋分裝。",
    image: "",
    ingredients: ["豬五花絞肉 500 g", "紅蔥頭 6 顆", "蒜頭 3 瓣", "醬油 4 大匙", "冰糖 1 大匙", "米酒 2 大匙", "五香粉 1/4 小匙", "白飯 4 碗"],
    steps: [
      "紅蔥頭切片、蒜頭切末，豬肉備用。",
      "鍋中放少許油，炒香紅蔥頭與蒜末。",
      "加入豬肉炒到變色並逼出油脂。",
      "加入醬油、米酒、冰糖與五香粉拌炒上色。",
      "加水蓋過肉，小火滷 35 分鐘至濃稠。",
      "淋在白飯上，可搭配滷蛋與青菜。",
    ],
    servings: "4 人份",
    time: "50 分鐘",
    difficulty: "普通",
    tags: ["台式", "下飯菜"],
    quality: 84,
    extractedFrom: "fallback",
    crawlQuery: "滷肉飯",
  },
  {
    title: "麻婆豆腐",
    source: "備援資料",
    sourceUrl: "",
    canonicalUrl: "fallback://mapo-tofu",
    description: "麻、辣、鹹、香都到位的下飯豆腐料理。",
    image: "",
    ingredients: ["板豆腐 1 盒", "豬絞肉 120 g", "豆瓣醬 1.5 大匙", "蒜末 2 瓣", "薑末 1 小匙", "醬油 1 大匙", "花椒粉 少許", "太白粉水 2 大匙"],
    steps: [
      "豆腐切塊，以熱水加少許鹽汆燙後瀝乾。",
      "鍋中炒香蒜末、薑末與豆瓣醬。",
      "加入豬絞肉炒散至變色。",
      "加入醬油與半碗水，放入豆腐小火煮 5 分鐘。",
      "倒入太白粉水勾薄芡，撒上花椒粉即可。",
    ],
    servings: "2-3 人份",
    time: "25 分鐘",
    difficulty: "普通",
    tags: ["中式", "下飯菜"],
    quality: 87,
    extractedFrom: "fallback",
    crawlQuery: "麻婆豆腐",
  },
  {
    title: "蔥油雞",
    source: "備援資料",
    sourceUrl: "",
    canonicalUrl: "fallback://scallion-oil-chicken",
    description: "雞肉鮮嫩、蔥油香氣明顯，冷熱吃都適合。",
    image: "",
    ingredients: ["去骨雞腿 2 片", "蔥 4 支", "薑片 4 片", "鹽 1 小匙", "白胡椒 少許", "米酒 1 大匙", "食用油 3 大匙"],
    steps: [
      "雞腿抹鹽、白胡椒與米酒，靜置 10 分鐘。",
      "雞腿蒸 15 分鐘後悶 5 分鐘，保留雞汁。",
      "蔥切末，薑切細末，放入耐熱碗。",
      "熱油淋入蔥薑中，加入少許雞汁拌成蔥油。",
      "雞腿切片，淋上蔥油即可。",
    ],
    servings: "2 人份",
    time: "30 分鐘",
    difficulty: "簡單",
    tags: ["台式", "家常菜"],
    quality: 86,
    extractedFrom: "fallback",
    crawlQuery: "蔥油雞",
  },
  {
    title: "韓式泡菜鍋",
    source: "備援資料",
    sourceUrl: "",
    canonicalUrl: "fallback://kimchi-jjigae",
    description: "酸辣泡菜湯底，適合加入豆腐、豬肉與菇類。",
    image: "",
    ingredients: ["韓式泡菜 250 g", "豬五花片 150 g", "豆腐 1 盒", "洋蔥 1/2 顆", "蒜末 2 瓣", "韓式辣醬 1 大匙", "高湯 700 ml", "蔥 1 支"],
    steps: [
      "洋蔥切絲、豆腐切塊、蔥切段。",
      "鍋中炒香豬五花片，加入蒜末與泡菜拌炒。",
      "加入韓式辣醬與高湯煮滾。",
      "放入豆腐與洋蔥，小火煮 10 分鐘。",
      "起鍋前撒上蔥段，可搭配白飯。",
    ],
    servings: "2-3 人份",
    time: "30 分鐘",
    difficulty: "簡單",
    tags: ["韓式", "湯類"],
    quality: 85,
    extractedFrom: "fallback",
    crawlQuery: "韓式泡菜鍋",
  },
];

function fallbackRecipesForQueries(queries) {
  const catalog = new Map(fallbackRecipeCatalog.map((recipe) => [recipe.title, recipe]));
  return queries.map((query) => {
    const recipe = catalog.get(query) || fallbackRecipeCatalog.find((item) => item.title.includes(query) || query.includes(item.title));
    if (recipe) return { ...recipe, source: recipe.source || "備援資料", crawlQuery: query };
    return {
      title: query,
      source: "備援資料",
      sourceUrl: "",
      canonicalUrl: `fallback://${stableId(query)}`,
      description: "外部來源暫時無法爬取，先建立可搜尋的料理占位資料。",
      image: "",
      ingredients: ["主要食材 適量", "調味料 適量"],
      steps: ["等待 MD 網址清單更新補齊來源。", "可先用這筆資料建立搜尋與分類索引。"],
      servings: "",
      time: "",
      difficulty: "普通",
      tags: [],
      quality: 45,
      extractedFrom: "fallback",
      crawlQuery: query,
    };
  });
}

function searchSamples(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return fallbackRecipeCatalog;
  const terms = normalized.split(/\s+/);
  return fallbackRecipeCatalog
    .filter((recipe) => {
      const haystack = `${recipe.title} ${recipe.description} ${recipe.tags.join(" ")} ${recipe.ingredients.join(" ")}`.toLowerCase();
      return terms.some((term) => haystack.includes(term)) || recipe.title.includes(query);
    })
    .map((recipe) => ({ ...recipe }));
}

async function handleSearch(req, res, url) {
  const query = (url.searchParams.get("q") || "").trim();
  if (query.length > MAX_QUERY_LENGTH) {
    sendJson(res, 400, { query: "", items: [], error: "Search query is too long." });
    return;
  }
  if (!query) {
    const crawled = searchCrawledRecipes("");
    sendJson(res, 200, {
      query,
      items: crawled,
      mode: crawled.length ? "content" : "empty",
      crawl: publicCrawlStatus(),
      warning: crawled.length ? "" : "尚未從 MD 網址清單建立內容索引。請在 recipe-urls.md 貼上網址後按內容更新。",
    });
    return;
  }

  const cacheKey = `search:${stableId(query.toLowerCase())}`;
  const cached = getCached(cacheKey);
  if (cached) {
    sendJson(res, 200, { ...cached, cached: true });
    return;
  }

  const crawledMatches = searchCrawledRecipes(query);
  if (crawledMatches.length) {
    const payload = {
      query,
      items: crawledMatches,
      mode: "content",
      crawl: publicCrawlStatus(),
    };
    setCached(cacheKey, payload);
    sendJson(res, 200, payload);
    return;
  }

  const indexedItems = searchCrawledRecipes("");
  const payload = indexedItems.length
    ? {
        query,
        items: [],
        mode: "empty",
        crawl: publicCrawlStatus(),
        warning: "已更新的 MD 網址清單中沒有符合這個關鍵字的食譜。",
      }
    : {
        query,
        items: [],
        mode: "empty",
        crawl: publicCrawlStatus(),
        warning: "尚未從 MD 網址清單建立內容索引。請在 recipe-urls.md 貼上網址後按內容更新。",
      };
  setCached(cacheKey, payload);
  sendJson(res, 200, payload);
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

async function handleUserStateGet(res, url) {
  const clientId = normalizeClientId(url.searchParams.get("clientId"));
  if (!clientId) {
    sendJson(res, 400, { error: "Missing or invalid clientId." });
    return;
  }
  const state = safeReadJson(userStatePath(clientId), normalizeUserState());
  sendJson(res, 200, { clientId, state });
}

async function handleUserStatePut(req, res) {
  const body = await readRequestBody(req);
  const clientId = normalizeClientId(body.clientId);
  if (!clientId) {
    sendJson(res, 400, { error: "Missing or invalid clientId." });
    return;
  }
  const state = normalizeUserState(body.state || body);
  writeJsonAtomic(userStatePath(clientId), state);
  sendJson(res, 200, { clientId, state });
}

function handleHealth(res) {
  const source = readContentSource();
  sendJson(res, 200, {
    ok: true,
    name: "recipe-crawler-web",
    version: APP_VERSION,
    environment: process.env.NODE_ENV || "development",
    contentSource: {
      file: source.relativePath,
      urlCount: source.urls.length,
      autoUpdate: false,
    },
    cacheEntries: searchCache.size,
    dataPersistence: true,
    time: new Date().toISOString(),
  });
}

function handleCrawlStatus(res) {
  sendJson(res, 200, { crawl: publicCrawlStatus() });
}

function handleCrawlRun(res) {
  runContentUpdate("manual").catch((error) => {
    const index = readCrawlIndex();
    writeCrawlIndex({
      ...index,
      status: "error",
      lastError: error.message,
      nextRunAt: "",
    });
  });
  sendJson(res, 202, { accepted: true, crawl: publicCrawlStatus() });
}

function serveStatic(req, res, pathname) {
  const rawPath = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const noStore = [".html", ".js", ".css"].includes(ext);
    res.writeHead(200, securityHeaders({
      "content-type": MIME_TYPES[ext] || "application/octet-stream",
      "cache-control": noStore ? "no-store" : "public, max-age=3600",
    }));
    res.end(data);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && parsedUrl.pathname === "/api/health") {
        handleHealth(res);
        return;
      }
      if (req.method === "GET" && parsedUrl.pathname === "/api/crawl/status") {
        handleCrawlStatus(res);
        return;
      }
      if (req.method === "GET" && parsedUrl.pathname === "/api/content/status") {
        handleCrawlStatus(res);
        return;
      }
      if (req.method === "POST" && parsedUrl.pathname === "/api/crawl/run") {
        handleCrawlRun(res);
        return;
      }
      if (req.method === "POST" && parsedUrl.pathname === "/api/content/update") {
        handleCrawlRun(res);
        return;
      }
      if (req.method === "GET" && parsedUrl.pathname === "/api/user-state") {
        await handleUserStateGet(res, parsedUrl);
        return;
      }
      if (req.method === "PUT" && parsedUrl.pathname === "/api/user-state") {
        await handleUserStatePut(req, res);
        return;
      }
      if (req.method === "GET" && parsedUrl.pathname === "/api/search") {
        await handleSearch(req, res, parsedUrl);
        return;
      }
      if (req.method === "GET" && parsedUrl.pathname === "/api/extract") {
        const rawUrl = parsedUrl.searchParams.get("url") || "";
        const item = await extractFromUrl(rawUrl);
        sendJson(res, 200, { item });
        return;
      }
      if (req.method !== "GET") {
        sendText(res, 405, "Method not allowed");
        return;
      }
      serveStatic(req, res, decodeURIComponent(parsedUrl.pathname));
    } catch (error) {
      const statusCode = error.statusCode && Number(error.statusCode) < 500 ? error.statusCode : 500;
      sendJson(res, statusCode, { error: error.message || "Internal server error" });
    }
  });
}

function listenWithFallback(port, attempts = 10) {
  ensureDataDir();
  const server = createServer();
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && attempts > 0) {
      listenWithFallback(port + 1, attempts - 1);
      return;
    }
    console.error(error);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
    console.log(`料理快搜 ${APP_VERSION} running at http://${displayHost}:${port}`);
  });
}

listenWithFallback(DEFAULT_PORT);
