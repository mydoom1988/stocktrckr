const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_SYMBOLS = 50;

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
    symbol: meta.symbol || symbol,
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

async function fetchChartQuote(symbol) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}`);
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

  return toQuoteView(symbol, chart);
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
