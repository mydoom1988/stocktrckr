const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SYMBOLS = 50;
const SYMBOL_ALIASES = {
  ABB: ["ABBN.SW", "ABBNY"],
  EUNL: ["EUNL.DE"],
  LSMC: ["LSMC.DE"],
};

app.use(express.static(path.join(__dirname, "public")));

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

app.get("/api/quotes", async (req, res) => {
  const symbols = parseSymbols(req.query.symbols);

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

    return res.json({
      quotes,
      missing,
      requested: symbols,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(502).json({
      error: "Could not fetch market data right now. Try again in a moment.",
      detail: process.env.NODE_ENV === "production" ? undefined : error.message,
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`stocktrckr listening on port ${PORT}`);
});
