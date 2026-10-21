// Optional data providers (FMP and Bigdata.com). Keys come from the server's environment only: they are
// never logged, never sent to the browser, and never included in an error message.

const FMP_BASE = "https://financialmodelingprep.com/stable";
const BIGDATA_BASE = "https://api.bigdata.com";
const REQUEST_TIMEOUT_MS = 10000;
const BIGDATA_NEWS_DAYS = 14;
const BIGDATA_MAX_CHUNKS = 10;
const EARNINGS_QUARTERS = 8;
const INSIDER_QUARTERS = 4;

// kind: missing (no key) | rejected (bad key) | locked (plan too low) | limit (rate/quota) | error
class ProviderError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const warned = new Set();
function warnOnce(logger, name, error) {
  const key = `${name}:${error.kind}`;
  if (error.kind === "missing" || warned.has(key)) return;
  warned.add(key);
  logger.warn(`${name} is not returning data (${error.kind}): ${error.message}`);
}

function classify(status, body, name) {
  const text = String(typeof body === "string" ? body : body?.["Error Message"] || body?.message || body?.error || "");
  if (status === 429 || /limit reach|rate limit|too many requests|quota/i.test(text)) return new ProviderError("limit", `${name} rate limit reached.`);
  if (status === 402 || /premium|upgrade|not available under your current subscription|special endpoint/i.test(text)) {
    return new ProviderError("locked", `${name} plan doesn't include this data.`);
  }
  if (status === 401 || status === 403 || /invalid api key|unauthori[sz]ed|forbidden/i.test(text)) {
    return new ProviderError("rejected", `${name} rejected the API key.`);
  }
  return new ProviderError("error", `${name} returned an unexpected response (${status}).`);
}

async function request(name, url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new ProviderError("error", `${name} could not be reached.`);
  }

  const raw = await response.text();
  let body = raw;
  try {
    body = JSON.parse(raw);
  } catch (error) {
    // Leave the text as is; classify() reads it.
  }

  if (!response.ok || (body && !Array.isArray(body) && typeof body === "object" && (body["Error Message"] || body.error))) {
    throw classify(response.status, body, name);
  }
  return body;
}

function fmpGet(key, path, params = {}) {
  if (!key) return Promise.reject(new ProviderError("missing", "FMP_API_KEY is not set."));
  const url = new URL(`${FMP_BASE}/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  url.searchParams.set("apikey", key);
  return request("FMP", url, { headers: { Accept: "application/json", "User-Agent": "stocktrckr/1.0" } });
}

function bigdataPost(key, path, payload) {
  if (!key) return Promise.reject(new ProviderError("missing", "BIGDATA_API_KEY is not set."));
  return request("Bigdata.com", `${BIGDATA_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-KEY": key, "User-Agent": "stocktrckr/1.0" },
    body: JSON.stringify(payload),
  });
}

function number(value) {
  const parsed = Number(value);
  return value !== null && value !== "" && Number.isFinite(parsed) ? parsed : null;
}

function first(body) {
  return Array.isArray(body) ? body[0] : body;
}

// --- FMP: analyst targets, earnings history, insider activity -------------------------------------------

function parseTargets(body) {
  const row = first(body);
  const consensus = number(row?.targetConsensus);
  if (consensus === null) return null;
  return { consensus, median: number(row.targetMedian), high: number(row.targetHigh), low: number(row.targetLow) };
}

// Newest first in; only quarters with both an actual and an estimate count.
function parseEarnings(body) {
  const rows = (Array.isArray(body) ? body : [])
    .map((row) => ({ date: String(row?.date || ""), actual: number(row?.epsActual), estimate: number(row?.epsEstimated) }))
    .filter((row) => row.actual !== null && row.estimate !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, EARNINGS_QUARTERS);
  if (!rows.length) return null;
  return { reported: rows.length, beats: rows.filter((row) => row.actual >= row.estimate).length, latest: rows[0] };
}

// "Acquired" includes awards and grants, so it is a rough read of insider buying, not open-market purchases alone.
function parseInsiders(body) {
  const rows = (Array.isArray(body) ? body : [])
    .map((row) => ({
      year: number(row?.year),
      quarter: number(row?.quarter),
      acquired: number(row?.acquiredTransactions ?? row?.totalPurchases),
      disposed: number(row?.disposedTransactions ?? row?.totalSales),
    }))
    .filter((row) => row.year !== null && row.quarter !== null && (row.acquired !== null || row.disposed !== null))
    .sort((a, b) => b.year - a.year || b.quarter - a.quarter)
    .slice(0, INSIDER_QUARTERS);
  if (!rows.length) return null;
  return {
    quarters: rows.length,
    acquired: rows.reduce((sum, row) => sum + (row.acquired || 0), 0),
    disposed: rows.reduce((sum, row) => sum + (row.disposed || 0), 0),
    latest: `${rows[0].year} Q${rows[0].quarter}`,
  };
}

// Every part is fetched separately so one locked endpoint doesn't hide the rest.
async function fetchInsights(key, symbol, logger = console) {
  const parts = {
    targets: () => fmpGet(key, "price-target-consensus", { symbol }).then(parseTargets),
    earnings: () => fmpGet(key, "earnings", { symbol, limit: EARNINGS_QUARTERS + 4 }).then(parseEarnings),
    insiders: () => fmpGet(key, "insider-trading/statistics", { symbol }).then(parseInsiders),
  };
  const names = Object.keys(parts);
  const settled = await Promise.allSettled(names.map((name) => parts[name]()));

  const data = {};
  const status = {};
  settled.forEach((result, index) => {
    const name = names[index];
    if (result.status === "fulfilled") {
      data[name] = result.value;
      status[name] = result.value ? "ok" : "empty";
    } else {
      data[name] = null;
      status[name] = result.reason?.kind || "error";
      if (result.reason instanceof ProviderError) warnOnce(logger, `FMP ${name}`, result.reason);
    }
  });
  return { ...data, status };
}

// --- Bigdata.com: news with sentiment -------------------------------------------------------------------

// "285A.T" -> "285A", "RHM.DE" -> "RHM", "BRK-B" stays.
function baseTicker(symbol) {
  return String(symbol).replace(/\.[A-Z]{1,4}$/, "").toUpperCase();
}

// Only accept a public company whose listing matches the ticker, so a look-alike can't be picked.
function pickEntity(body, ticker) {
  const results = Array.isArray(body?.results) ? body.results : [];
  const match = results.find(
    (company) =>
      company?.id &&
      (!company.type || company.type === "PUBLIC") &&
      ((company.listing_values || []).some((listing) => String(listing).toUpperCase().endsWith(`:${ticker}`)) ||
        String(company.ticker || "").toUpperCase() === ticker)
  );
  return match ? String(match.id) : null;
}

function toBigdataItem(document) {
  const title = String(document?.headline || "").trim();
  let url;
  try {
    url = new URL(document?.url);
  } catch (error) {
    return null;
  }
  if (!title || !["https:", "http:"].includes(url.protocol)) return null;

  const scores = (document.chunks || []).map((chunk) => number(chunk?.sentiment)).filter((score) => score !== null);
  const published = new Date(document.timestamp && !/[zZ]|[+-]\d\d:?\d\d$/.test(document.timestamp) ? `${document.timestamp}Z` : document.timestamp || NaN);
  return {
    id: `bd:${document.id || url.href}`,
    title: title.slice(0, 300),
    publisher: String(document.source?.name || "").slice(0, 100),
    url: url.href,
    publishedAt: Number.isNaN(published.getTime()) ? null : published.toISOString(),
    sentiment: scores.length ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100 : null,
  };
}

function createBigdataNews({ key, logger = console, cacheMs = 24 * 60 * 60 * 1000 }) {
  const entities = new Map();

  async function entityFor(symbol) {
    const cached = entities.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.id;

    const ticker = baseTicker(symbol);
    const body = await bigdataPost(key, "/v1/knowledge-graph/companies", { query: ticker, types: ["PUBLIC"] });
    const id = pickEntity(body, ticker);
    entities.set(symbol, { id, expiresAt: Date.now() + cacheMs });
    return id;
  }

  return async function fetchBigdataNews(symbol) {
    if (!key) return [];
    try {
      const id = await entityFor(symbol);
      if (!id) return [];

      const start = new Date(Date.now() - BIGDATA_NEWS_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const body = await bigdataPost(key, "/v1/search", {
        search_mode: "fast",
        query: {
          filters: {
            timestamp: { start },
            entity: { any_of: [id] },
            category: { mode: "INCLUDE", values: ["news"] },
          },
          max_chunks: BIGDATA_MAX_CHUNKS,
        },
      });
      return (Array.isArray(body?.results) ? body.results : []).map(toBigdataItem).filter(Boolean);
    } catch (error) {
      if (error instanceof ProviderError) warnOnce(logger, "Bigdata.com news", error);
      throw error;
    }
  };
}

module.exports = {
  ProviderError,
  baseTicker,
  createBigdataNews,
  fetchInsights,
  parseEarnings,
  parseInsiders,
  parseTargets,
  pickEntity,
  toBigdataItem,
};
