const express = require("express");
const path = require("path");
const { createAuth } = require("./auth");
const { deriveMetrics, fetchTimeseries } = require("./fundamentals");

const PORT = process.env.PORT || 3000;
const MAX_SYMBOLS = 50;
const NEWS_PER_SYMBOL = 8;
const MAX_NEWS_ITEMS = 60;
const NEWS_CACHE_MS = 10 * 60 * 1000;
const FUNDAMENTALS_CACHE_MS = 12 * 60 * 60 * 1000;
const SYMBOL_ALIASES = {
  ABB: ["ABBN.SW", "ABBNY"],
  EUNL: ["EUNL.DE"],
  LSMC: ["LSMC.DE"],
};
// Yahoo prices some listings in minor units (pence, agorot, cents); FX pairs are quoted per major unit.
const MINOR_CURRENCIES = {
  GBp: ["GBP", 100],
  GBX: ["GBP", 100],
  ILA: ["ILS", 100],
  ZAc: ["ZAR", 100],
};
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function parseSymbols(input) {
  return [
    ...new Set(
      String(input || "")
        .split(/[,\s;]+/)
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol))
    ),
  ].slice(0, MAX_SYMBOLS);
}

function parseCurrency(input) {
  const currency = String(input || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function yahooSymbol(symbol) {
  if (/^[A-Z0-9.-]+\.[A-Z]{1,4}$/.test(symbol)) return symbol;
  return symbol;
}

function toQuoteView(symbol, chart) {
  const meta = chart.meta || {};
  const price = Number(meta.regularMarketPrice || 0);
  const previousClose = Number(meta.chartPreviousClose || meta.previousClose || 0);
  const change = price && previousClose ? price - previousClose : 0;
  const changePercent = previousClose ? (change / previousClose) * 100 : 0;

  return {
    symbol,
    providerSymbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || meta.symbol || symbol,
    exchange: meta.fullExchangeName || meta.exchangeName || "Market",
    instrumentType: meta.instrumentType || "EQUITY",
    currency: meta.currency || "USD",
    price,
    previousClose,
    change,
    changePercent,
    status: change > 0 ? "green" : change < 0 ? "red" : "flat",
    marketState: meta.marketState || "UNKNOWN",
    marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
  };
}

async function fetchChart(providerSymbol, displaySymbol) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(providerSymbol))}`);
  url.searchParams.set("range", "5d");
  url.searchParams.set("interval", "1d");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "stocktrckr/1.0",
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Quote provider returned ${response.status}`);
  }

  const data = await response.json();
  const chart = data.chart?.result?.[0];

  if (!chart || data.chart?.error) {
    throw new Error(data.chart?.error?.description || "No chart data returned");
  }

  return toQuoteView(displaySymbol, chart);
}

async function findYahooSymbol(symbol) {
  const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", symbol);
  url.searchParams.set("quotesCount", "8");
  url.searchParams.set("newsCount", "0");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "stocktrckr/1.0",
      "Accept": "application/json",
    },
  });

  if (!response.ok) return null;

  const data = await response.json();
  const quotes = data.quotes || [];
  const exact = quotes.find((quote) => quote.symbol?.toUpperCase() === symbol);
  const sameRoot = quotes.find((quote) => quote.symbol?.toUpperCase().startsWith(`${symbol}.`));
  const sameRootDash = quotes.find((quote) => quote.symbol?.toUpperCase().startsWith(`${symbol}-`));
  const firstYahooQuote = quotes.find((quote) => quote.isYahooFinance && quote.symbol);

  return exact?.symbol || sameRoot?.symbol || sameRootDash?.symbol || firstYahooQuote?.symbol || null;
}

async function fetchChartQuote(symbol) {
  const candidates = [symbol, ...(SYMBOL_ALIASES[symbol] || [])];

  for (const candidate of candidates) {
    try {
      return await fetchChart(candidate, symbol);
    } catch (error) {
      // Try the next known venue-specific symbol.
    }
  }

  const searchedSymbol = await findYahooSymbol(symbol);
  if (searchedSymbol && !candidates.includes(searchedSymbol)) {
    return fetchChart(searchedSymbol, symbol);
  }

  throw new Error(`No data found for ${symbol}`);
}

// Returns how much one unit of each quote currency is worth in the base currency.
async function fetchFxRates(currencies, base) {
  const rates = {};

  await Promise.all(
    [...new Set(currencies)].map(async (currency) => {
      const [major, divisor] = MINOR_CURRENCIES[currency] || [currency.toUpperCase(), 1];
      if (major === base) {
        rates[currency] = 1 / divisor;
        return;
      }

      try {
        const pair = await fetchChart(`${major}${base}=X`, `${major}${base}`);
        if (pair.price > 0) rates[currency] = pair.price / divisor;
      } catch (error) {
        // Leave the rate out; the page shows those holdings in their own currency.
      }
    })
  );

  return rates;
}

// Accepts Yahoo's search-result stories and the newer { content } shape; drops anything without a web link.
function toNewsItem(entry) {
  const story = entry || {};
  const content = story.content || story;
  const title = String(content.title || "").trim();
  let url;
  try {
    url = new URL(story.link || content.canonicalUrl?.url || content.clickThroughUrl?.url);
  } catch (error) {
    return null;
  }
  if (!title || !["https:", "http:"].includes(url.protocol)) return null;

  const seconds = Number(story.providerPublishTime);
  const published = seconds > 0 ? new Date(seconds * 1000) : new Date(content.pubDate || NaN);

  return {
    id: String(story.uuid || story.id || url.href),
    title: title.slice(0, 300),
    publisher: String(story.publisher || content.provider?.displayName || "").slice(0, 100),
    url: url.href,
    publishedAt: Number.isNaN(published.getTime()) ? null : published.toISOString(),
  };
}

async function fetchNews(symbol) {
  const url = new URL("https://query1.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", symbol);
  url.searchParams.set("quotesCount", "0");
  url.searchParams.set("newsCount", String(NEWS_PER_SYMBOL));

  const response = await fetch(url, {
    headers: {
      "User-Agent": "stocktrckr/1.0",
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`News provider returned ${response.status}`);
  }

  const data = await response.json();
  return (data.news || []).map(toNewsItem).filter(Boolean);
}

function createNewsHandler({ cacheMs = NEWS_CACHE_MS } = {}) {
  const cache = new Map();

  async function newsFor(symbol) {
    const cached = cache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return cached.items;

    const items = await fetchNews(symbol);
    if (cache.size > 500) cache.clear();
    cache.set(symbol, { items, expiresAt: Date.now() + cacheMs });
    return items;
  }

  return async function handleNews(req, res) {
    const symbols = parseSymbols(req.query.symbols);

    if (!symbols.length) {
      return res.status(400).json({ error: "Add at least one valid ticker symbol." });
    }

    const settled = await Promise.allSettled(symbols.map(newsFor));
    const stories = new Map();
    const failed = [];

    settled.forEach((result, index) => {
      const symbol = symbols[index];
      if (result.status === "rejected") {
        failed.push(symbol);
        return;
      }
      for (const item of result.value) {
        const story = stories.get(item.id) || { ...item, symbols: [] };
        if (!story.symbols.includes(symbol)) story.symbols.push(symbol);
        stories.set(item.id, story);
      }
    });

    if (failed.length === symbols.length) {
      return res.status(502).json({ error: "Could not fetch news right now. Try again in a moment." });
    }

    const items = [...stories.values()]
      .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
      .slice(0, MAX_NEWS_ITEMS);

    return res.json({ items, failed, updatedAt: new Date().toISOString() });
  };
}

function createFundamentalsHandler({ cacheMs = FUNDAMENTALS_CACHE_MS } = {}) {
  const cache = new Map();

  return async function handleFundamentals(req, res) {
    const [symbol] = parseSymbols(req.query.symbol);

    if (!symbol) {
      return res.status(400).json({ error: "Add a valid ticker symbol." });
    }

    const cached = cache.get(symbol);
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);

    let quote;
    try {
      quote = await fetchChartQuote(symbol);
    } catch (error) {
      return res.status(404).json({ error: `No market data found for ${symbol}.` });
    }

    const data = {
      symbol,
      providerSymbol: quote.providerSymbol,
      name: quote.name,
      exchange: quote.exchange,
      instrumentType: quote.instrumentType,
      currency: quote.currency,
      price: quote.price,
      metrics: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };

    // The checklist is about companies; funds and ETFs have no statements to check.
    if (quote.instrumentType === "EQUITY") {
      try {
        const series = await fetchTimeseries(quote.providerSymbol);
        data.metrics = deriveMetrics(series, { price: quote.price, priceCurrency: quote.currency });
        const cap = data.metrics.marketCap;
        if (cap) {
          const rate = cap.currency === "USD" ? 1 : (await fetchFxRates([cap.currency], "USD"))[cap.currency];
          data.metrics.marketCapUsd = rate > 0 ? cap.value * rate : null;
        }
        if (!Object.keys(series).length) data.error = `Yahoo has no financial statements for ${quote.providerSymbol}.`;
      } catch (error) {
        data.error = "Financial statements couldn't be loaded right now.";
      }
    }

    if (!data.error) {
      if (cache.size > 500) cache.clear();
      cache.set(symbol, { data, expiresAt: Date.now() + cacheMs });
    }
    return res.json(data);
  };
}

function securityHeaders(req, res, next) {
  res.set({
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
  });
  next();
}

async function handleQuotes(req, res) {
  const symbols = parseSymbols(req.query.symbols);
  const base = parseCurrency(req.query.base);

  if (!symbols.length) {
    return res.status(400).json({ error: "Add at least one valid ticker symbol." });
  }

  try {
    const settled = await Promise.allSettled(symbols.map(fetchChartQuote));
    const quotes = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const found = new Set(quotes.map((quote) => quote.symbol.toUpperCase()));
    const missing = symbols.filter((symbol) => !found.has(symbol.toUpperCase()));
    const fx = base ? await fetchFxRates(quotes.map((quote) => quote.currency), base) : undefined;

    return res.json({
      quotes,
      missing,
      requested: symbols,
      base: base || undefined,
      fx,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(502).json({
      error: "Could not fetch market data right now. Try again in a moment.",
      detail: process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
}

function createApp(options = {}) {
  const app = express();
  const auth = createAuth({
    password: process.env.APP_PASSWORD,
    sessionSecret: process.env.SESSION_SECRET,
    ...options.auth,
  });

  app.disable("x-powered-by");
  // Render terminates HTTPS at its proxy: trust one hop so req.secure and req.ip are the visitor's.
  app.set("trust proxy", 1);
  app.use(securityHeaders);

  // Public: only the sign-in page and what it needs.
  app.get("/robots.txt", (req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  });
  app.get("/login.css", (req, res) => {
    res.sendFile(path.join(__dirname, "views", "login.css"));
  });
  app.use(auth.router);

  // Everything below requires a signed-in session.
  app.use(auth.requireAuth);
  app.use(
    express.static(path.join(__dirname, "public"), {
      cacheControl: false,
      setHeaders: (res) => res.setHeader("Cache-Control", "private, no-cache"),
    })
  );
  app.get("/api/quotes", handleQuotes);
  app.get("/api/news", createNewsHandler(options.news));
  app.get("/api/fundamentals", createFundamentalsHandler(options.fundamentals));
  app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"), { cacheControl: false });
  });

  return app;
}

if (require.main === module) {
  createApp().listen(PORT, () => {
    console.log(`stocktrckr listening on port ${PORT}`);
  });
}

module.exports = { createApp };
