const tickerInput = document.querySelector("#tickerInput");
const tickerFile = document.querySelector("#tickerFile");
const tickerForm = document.querySelector("#tickerForm");
const clearButton = document.querySelector("#clearButton");
const refreshButton = document.querySelector("#refreshButton");
const quoteTiles = document.querySelector("#quoteTiles");
const statusText = document.querySelector("#statusText");
const missingSymbols = document.querySelector("#missingSymbols");
const updatedAt = document.querySelector("#updatedAt");
const greenCount = document.querySelector("#greenCount");
const redCount = document.querySelector("#redCount");
const flatCount = document.querySelector("#flatCount");

const sampleTickers = "AAPL, MSFT, NVDA, TSLA, AMZN, META, GOOGL, JPM, XOM, PFE, JNJ, WMT, DIS, NFLX, BABA, VZ, T";
const sectorMap = {
  AAPL: "Technology",
  MSFT: "Technology",
  NVDA: "Technology",
  AMD: "Technology",
  INTC: "Technology",
  AVGO: "Technology",
  ORCL: "Technology",
  CRM: "Technology",
  LSMC: "Technology",
  MU: "Technology",
  WDC: "Technology",
  ICHR: "Technology",
  AAOI: "Technology",
  SHMD: "Technology",
  TSLA: "Auto & Manufacturing",
  F: "Auto & Manufacturing",
  GM: "Auto & Manufacturing",
  TM: "Auto & Manufacturing",
  GNRC: "Auto & Manufacturing",
  ABB: "Industrials",
  RHM: "Industrials",
  AMZN: "Consumer",
  WMT: "Consumer",
  COST: "Consumer",
  HD: "Consumer",
  MCD: "Consumer",
  NKE: "Consumer",
  META: "Communication",
  GOOGL: "Communication",
  GOOG: "Communication",
  NFLX: "Communication",
  DIS: "Communication",
  VZ: "Communication",
  T: "Communication",
  JPM: "Financial",
  BAC: "Financial",
  GS: "Financial",
  MS: "Financial",
  V: "Financial",
  MA: "Financial",
  BRK_B: "Financial",
  "BRK-B": "Financial",
  XOM: "Energy",
  CVX: "Energy",
  COP: "Energy",
  SLB: "Energy",
  JNJ: "Healthcare",
  PFE: "Healthcare",
  MRK: "Healthcare",
  ABBV: "Healthcare",
  LLY: "Healthcare",
  UNH: "Healthcare",
  BABA: "International",
  JD: "International",
  PDD: "International",
  TSM: "International",
  EUNL: "ETF",
  NBIS: "Technology",
};

function parseTickers(text) {
  return [...new Set(
    String(text || "")
      .split(/[,\s;]+/)
      .map((ticker) => ticker.trim().toUpperCase())
      .filter(Boolean)
  )];
}

function formatMoney(value, currency) {
  if (!Number.isFinite(value) || value === 0) return "-";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD",
    maximumFractionDigits: value >= 100 ? 2 : 4,
  }).format(value);
}

function formatChange(value, percent) {
  const prefix = value > 0 ? "+" : "";
  const pct = Number.isFinite(percent) ? `${prefix}${percent.toFixed(2)}%` : "-";
  const amount = Number.isFinite(value) ? `${prefix}${value.toFixed(2)}` : "-";
  return `${amount} (${pct})`;
}

function renderEmpty(message) {
  quoteTiles.innerHTML = `<div class="empty-state">${message}</div>`;
}

function setLoading(isLoading) {
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = isLoading;
  });
  statusText.textContent = isLoading ? "Fetching quotes..." : statusText.textContent;
}

function renderQuotes(data) {
  const quotes = data.quotes || [];
  const counts = quotes.reduce((total, quote) => {
    total[quote.status] = (total[quote.status] || 0) + 1;
    return total;
  }, { green: 0, red: 0, flat: 0 });

  greenCount.textContent = counts.green || 0;
  redCount.textContent = counts.red || 0;
  flatCount.textContent = counts.flat || 0;
  updatedAt.textContent = data.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleString()}` : "Updated now";
  statusText.textContent = quotes.length ? `${quotes.length} ticker${quotes.length === 1 ? "" : "s"} scanned` : "No quotes returned.";
  missingSymbols.textContent = data.missing?.length ? `Not found: ${data.missing.join(", ")}` : "";

  if (!quotes.length) {
    renderEmpty("No matching market data came back for those tickers.");
    return;
  }

  const grouped = quotes
    .slice()
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))
    .reduce((groups, quote) => {
      const sector = sectorMap[quote.symbol] || "Watchlist";
      groups[sector] = groups[sector] || [];
      groups[sector].push(quote);
      return groups;
    }, {});

  quoteTiles.innerHTML = Object.entries(grouped)
    .map(([sector, sectorQuotes]) => `
      <div class="sector-label">${sector}</div>
      ${sectorQuotes.map(renderTile).join("")}
    `)
    .join("");
}

function renderTile(quote) {
  const intensity = Math.min(Math.abs(quote.changePercent || 0), 12);
  const size = Math.max(1, Math.min(6, Math.ceil(intensity / 3) + 1));
  const percentPrefix = quote.changePercent > 0 ? "+" : "";
  const title = `${quote.symbol} ${formatChange(quote.change, quote.changePercent)} ${formatMoney(quote.price, quote.currency)}`;

  return `
    <article class="stock-tile ${quote.status} size-${size}" title="${title}">
      <div class="tile-symbol">${quote.symbol}</div>
      <div class="tile-percent">${percentPrefix}${quote.changePercent.toFixed(2)}%</div>
      <div class="tile-price">${formatMoney(quote.price, quote.currency)}</div>
      <div class="tile-name">${quote.name || quote.symbol}</div>
    </article>
  `;
}

async function scanTickers() {
  const tickers = parseTickers(tickerInput.value);

  if (!tickers.length) {
    tickerInput.value = sampleTickers;
    statusText.textContent = "Loaded sample tickers.";
    return;
  }

  setLoading(true);
  missingSymbols.textContent = "";

  try {
    const response = await fetch(`/api/quotes?symbols=${encodeURIComponent(tickers.join(","))}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Quote request failed.");
    }

    renderQuotes(data);
  } catch (error) {
    statusText.textContent = error.message;
    renderEmpty("Market data could not be loaded.");
  } finally {
    setLoading(false);
    if (window.lucide) window.lucide.createIcons();
  }
}

tickerFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  tickerInput.value = await file.text();
  statusText.textContent = `${file.name} loaded.`;
});

tickerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  scanTickers();
});

refreshButton.addEventListener("click", scanTickers);

clearButton.addEventListener("click", () => {
  tickerInput.value = "";
  tickerFile.value = "";
  missingSymbols.textContent = "";
  statusText.textContent = "Add tickers to begin.";
  updatedAt.textContent = "No scan yet";
  greenCount.textContent = "0";
  redCount.textContent = "0";
  flatCount.textContent = "0";
  renderEmpty("Upload or paste ticker symbols to see a green and red market heatmap.");
});

window.addEventListener("DOMContentLoaded", () => {
  const urlSymbols = new URLSearchParams(window.location.search).get("symbols");
  tickerInput.value = urlSymbols || sampleTickers;
  if (window.lucide) window.lucide.createIcons();
  if (urlSymbols) scanTickers();
});
