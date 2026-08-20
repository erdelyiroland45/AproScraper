const fs = require("fs/promises");
const path = require("path");
const cheerio = require("cheerio");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const HARDVERAPRO_BASE = "https://hardverapro.hu";
const COOKIE_TO_FETCH_200_ITEMS = "lstup.d.200.normal";
const STATE_FILE = process.env.STATE_FILE || "state.json";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "api/latest.json";
const MAX_ITEMS = Number.parseInt(process.env.MAX_ITEMS || "100", 10);
const FETCH_RETRIES = Number.isFinite(Number.parseInt(process.env.FETCH_RETRIES || "", 10))
  ? Number.parseInt(process.env.FETCH_RETRIES || "", 10)
  : 3;
const FETCH_RETRY_BASE_DELAY_MS = Number.isFinite(
  Number.parseInt(process.env.FETCH_RETRY_BASE_DELAY_MS || "", 10)
)
  ? Number.parseInt(process.env.FETCH_RETRY_BASE_DELAY_MS || "", 10)
  : 1500;

function parseUrlFilters(pageUrl) {
  const out = {};
  if (!pageUrl) return out;

  const queryIndex = pageUrl.indexOf("?");
  if (queryIndex < 0) return out;

  const query = pageUrl.slice(queryIndex + 1);
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    const rawValue = eq < 0 ? "" : part.slice(eq + 1);

    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch (err) {
      value = rawValue;
    }

    value = String(value || "").trim();
    if (key && value && value !== "0") {
      out[key] = value;
    }
  }

  return out;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--url" || arg === "--page-url") {
      result.pageUrl = args[i + 1] || "";
      i += 1;
    } else if (arg === "--state-file") {
      result.stateFile = args[i + 1] || "";
      i += 1;
    }
  }

  return result;
}

function resolvePageUrl() {
  const args = parseArgs();
  return (
    args.pageUrl ||
    process.env.HARDVERAPRO_URL ||
    ""
  );
}

function resolveStateFile() {
  const args = parseArgs();
  return args.stateFile || STATE_FILE;
}

function parseFtPrice(priceText) {
  if (!priceText) return -1;
  const trimmed = String(priceText).trim();
  if (!trimmed) return -1;
  if (/^0\s*Ft$/i.test(trimmed)) return 0;

  const match = trimmed.match(/([\d\s]+)\s*Ft/i);
  if (!match) return -1;

  const digits = match[1].replace(/\s+/g, "");
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

function isFreeOrCsereLike(priceText) {
  if (!priceText) return true;
  const lower = String(priceText).toLowerCase();
  if (lower.includes("csere")) return true;
  if (lower.includes("ingyen")) return true;
  if (lower.includes("adás") || lower.includes("ajándék")) return true;
  if (lower.includes("free") || lower.includes("gift")) return true;
  return parseFtPrice(priceText) === 0;
}

function matchesKeyword(item, keyword) {
  if (!keyword) return true;
  const title = item.title || "";
  const normalizedKeyword = String(keyword).toLowerCase().trim();
  if (!normalizedKeyword) return true;

  const normalizedTitle = title.toLowerCase();
  return normalizedKeyword.split(/\s+/).every((token) => token && normalizedTitle.includes(token));
}

function matchesPriceRange(item, minPrice, maxPrice) {
  if (minPrice == null && maxPrice == null) return true;

  const priceText = item.price;
  if (isFreeOrCsereLike(priceText)) {
    if (minPrice != null && minPrice > 0) return false;
    return maxPrice == null || maxPrice >= 0;
  }

  const ft = parseFtPrice(priceText);
  if (ft < 0) return true;
  if (minPrice != null && ft < minPrice) return false;
  if (maxPrice != null && ft > maxPrice) return false;
  return true;
}

function normalizeHardveraproUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `${HARDVERAPRO_BASE}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function buildHardveraproHeaders() {
  return {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7",
    Connection: "keep-alive",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Referer: HARDVERAPRO_BASE,
    "Upgrade-Insecure-Requests": "1",
    Cookie: `prf_ls_uad=${COOKIE_TO_FETCH_200_ITEMS}`,
  };
}

function createItemObject($, element) {
  try {
    const anchor = $(element).find("h1 > a").first();
    const image = $(element).find(".uad-image > img").first();
    const priceNode = $(element).find(".uad-price").first();
    const locationNode = $(element).find(".uad-cities").first();
    const updatedNode = $(element).find(".uad-time").first();
    const ribbonSpan = $(element).find(".uad-corner-ribbon span").first();

    const ribbonText = (ribbonSpan.text() || "").replace(/\uFEFF/g, "").trim();
    if (ribbonText === "PR") return null;

    const url = normalizeHardveraproUrl(anchor.attr("href"));
    const title = (anchor.text() || "").trim();
    let imageSrc = image.attr("src") || image.attr("data-src") || null;
    if (imageSrc) imageSrc = imageSrc.trim();
    const price = (priceNode.text() || "").trim() || null;
    const location = (locationNode.text() || "").trim() || null;
    const updated = (updatedNode.text() || "").replace(/–/g, "").trim() || null;

    if (!url || !title || !imageSrc || !location || !updated) {
      return null;
    }

    return { url, title, imageSrc, price, location, updated };
  } catch (err) {
    return null;
  }
}

function extractItems(html, pageUrl) {
  const filters = parseUrlFilters(pageUrl);
  const keyword = filters.stext || null;
  const minPrice = filters.minprice ? Number.parseInt(filters.minprice, 10) : null;
  const maxPrice = filters.maxprice ? Number.parseInt(filters.maxprice, 10) : null;

  const $ = cheerio.load(html);
  const items = [];

  $(".uad-list .media").each((_, element) => {
    const item = createItemObject($, element);
    if (!item) return;
    if (item.updated && item.updated.includes("Előresorolva")) return;
    if (item.price && item.price.includes("Csere")) return;
    if (!matchesKeyword(item, keyword)) return;
    if (!matchesPriceRange(item, minPrice, maxPrice)) return;
    items.push(item);
  });

  return items;
}

async function fetchHardveraproPage(pageUrl) {
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, FETCH_RETRIES); attempt += 1) {
    const response = await fetch(pageUrl, {
      headers: buildHardveraproHeaders(),
    });

    if (response.ok) {
      return response.text();
    }

    const body = await response.text().catch(() => "");
    const suffix = body ? `: ${body.slice(0, 200).replace(/\s+/g, " ").trim()}` : "";
    const error = new Error(`Hardverapro request failed with HTTP ${response.status}${suffix}`);
    lastError = error;

    if (!isRetryableStatus(response.status) || attempt >= Math.max(1, FETCH_RETRIES)) {
      throw error;
    }

    const delayMs = FETCH_RETRY_BASE_DELAY_MS * attempt;
    await sleep(delayMs);
  }

  throw lastError || new Error("Hardverapro request failed unexpectedly");
}

async function loadState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

async function saveState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function saveJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function main() {
  const pageUrl = resolvePageUrl();
  if (!pageUrl) {
    throw new Error("Missing Hardverapro URL. Set HARDVERAPRO_URL or pass --url.");
  }

  const stateFile = resolveStateFile();
  const html = await fetchHardveraproPage(pageUrl);
  const allItems = extractItems(html, pageUrl);
  const filters = parseUrlFilters(pageUrl);
  const state = await loadState(stateFile);
  const lastItemUrl = state ? state.lastItemUrl : null;

  let newItems = allItems;
  if (!lastItemUrl) {
    newItems = [];
  } else {
    const lastIndex = allItems.findIndex((item) => item.url === lastItemUrl);
    if (lastIndex >= 0) {
      newItems = allItems.slice(0, lastIndex);
    }
  }

  const nextLastItemUrl = allItems.length > 0 ? allItems[0].url : lastItemUrl || null;
  const visibleItems = allItems.slice(0, MAX_ITEMS);
  const visibleNewItems = newItems.slice(0, MAX_ITEMS);
  const generatedAt = new Date().toISOString();
  const nextState = {
    lastItemUrl: nextLastItemUrl,
    pageUrl,
    updatedAt: generatedAt,
  };

  await saveState(stateFile, nextState);

  const output = {
    ok: true,
    source: {
      name: "hardverapro",
      url: pageUrl,
      generatedAt,
    },
    filters,
    pagination: {
      limit: MAX_ITEMS,
      totalItems: allItems.length,
      returnedItems: visibleItems.length,
      newItems: visibleNewItems.length,
      hasMore: allItems.length > MAX_ITEMS,
    },
    state: {
      lastItemUrl: nextLastItemUrl,
      hasStoredState: Boolean(state),
    },
    items: visibleItems,
    newItems: visibleNewItems,
  };

  await saveJson(OUTPUT_FILE, output);
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  fetchHardveraproPage,
  extractItems,
  parseUrlFilters,
};
