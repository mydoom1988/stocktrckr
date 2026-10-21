const tickerInput = document.querySelector("#tickerInput");
const tickerFile = document.querySelector("#tickerFile");
const tickerForm = document.querySelector("#tickerForm");
const clearButton = document.querySelector("#clearButton");
const refreshButton = document.querySelector("#refreshButton");
const quoteTiles = document.querySelector("#quoteTiles");
const statusText = document.querySelector("#statusText");
const missingSymbols = document.querySelector("#missingSymbols");
const updatedAt = document.querySelector("#updatedAt");
const marketBrief = document.querySelector("#marketBrief");
const researchPanel = document.querySelector("#researchPanel");
const researchTitle = document.querySelector("#research-title");
const researchStatus = document.querySelector("#researchStatus");
const researchBody = document.querySelector("#researchBody");

let latestQuotes = new Map();
let selectedResearch = "";
let researchRequest = 0;

const savedTickersKey = "stocktrckr.tickers";
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
  VGLA: "ETF",
  NBIS: "Technology",
  SNDK: "Technology",
  KI5: "Technology",
  MEI: "Technology",
  SPCX: "Industrials",
  CDNA: "Healthcare",
  OBIO: "Healthcare",
};

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
}

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

function formatCompact(value, suffix = "") {
  if (!Number.isFinite(value)) return "—";
  return `${new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)}${suffix}`;
}

function formatRatio(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function renderMarketBrief(quotes) {
  if (!quotes.length) {
    marketBrief.hidden = true;
    marketBrief.innerHTML = "";
    return;
  }
  const advancers = quotes.filter((quote) => quote.changePercent > 0).length;
  const decliners = quotes.filter((quote) => quote.changePercent < 0).length;
  const average = quotes.reduce((sum, quote) => sum + (quote.changePercent || 0), 0) / quotes.length;
  const strongest = quotes.reduce((best, quote) => quote.changePercent > best.changePercent ? quote : best, quotes[0]);
  const weakest = quotes.reduce((worst, quote) => quote.changePercent < worst.changePercent ? quote : worst, quotes[0]);
  marketBrief.hidden = false;
  marketBrief.innerHTML = `
    <div><span>Breadth</span><strong>${advancers} up · ${decliners} down</strong></div>
    <div><span>Average move</span><strong class="${average > 0 ? "tone-up" : average < 0 ? "tone-down" : ""}">${average > 0 ? "+" : ""}${average.toFixed(2)}%</strong></div>
    <div><span>Strongest</span><strong class="tone-up">${escapeHtml(strongest.symbol)} ${strongest.changePercent > 0 ? "+" : ""}${strongest.changePercent.toFixed(2)}%</strong></div>
    <div><span>Weakest</span><strong class="tone-down">${escapeHtml(weakest.symbol)} ${weakest.changePercent > 0 ? "+" : ""}${weakest.changePercent.toFixed(2)}%</strong></div>
  `;
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
  latestQuotes = new Map(quotes.map((quote) => [quote.symbol, quote]));
  renderMarketBrief(quotes);
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

  selectResearch(latestQuotes.has(selectedResearch) ? selectedResearch : quotes[0].symbol);
}

function renderTile(quote) {
  const intensity = Math.min(Math.abs(quote.changePercent || 0), 12);
  const size = Math.max(1, Math.min(6, Math.ceil(intensity / 3) + 1));
  const percentPrefix = quote.changePercent > 0 ? "+" : "";
  const title = `${quote.symbol} ${formatChange(quote.change, quote.changePercent)} ${formatMoney(quote.price, quote.currency)}`;

  const rangePosition = quote.yearHigh > quote.yearLow
    ? Math.max(0, Math.min(100, ((quote.price - quote.yearLow) / (quote.yearHigh - quote.yearLow)) * 100))
    : null;

  return `
    <button class="stock-tile ${quote.status} size-${size}" type="button" data-symbol="${escapeHtml(quote.symbol)}" title="${escapeHtml(`${title}. Open company research.`)}" aria-pressed="${quote.symbol === selectedResearch}">
      <div class="tile-symbol">${escapeHtml(quote.symbol)}</div>
      <div class="tile-percent">${percentPrefix}${quote.changePercent.toFixed(2)}%</div>
      <div class="tile-price">${escapeHtml(formatMoney(quote.price, quote.currency))}</div>
      <div class="tile-name">${escapeHtml(quote.name || quote.symbol)}</div>
      ${rangePosition === null ? "" : `<div class="tile-range" title="Position in 52-week range"><span style="width:${rangePosition.toFixed(1)}%"></span></div>`}
    </button>
  `;
}

function metric(label, value, note = "") {
  return `<div class="research-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`;
}

function providerStatus(value) {
  const labels = { ok: "Available", empty: "No data", locked: "Plan locked", limit: "Rate limited", rejected: "Key rejected", error: "Unavailable" };
  return labels[value] || "Not checked";
}

async function selectResearch(symbol) {
  const quote = latestQuotes.get(symbol);
  if (!quote) return;
  const requestId = ++researchRequest;
  selectedResearch = symbol;
  researchPanel.hidden = false;
  researchTitle.textContent = `${quote.symbol} · ${quote.name || quote.symbol}`;
  researchStatus.textContent = "Loading financials…";
  researchBody.innerHTML = `<div class="research-loading">Loading valuation, financial quality and analyst context…</div>`;
  quoteTiles.querySelectorAll("[data-symbol]").forEach((tile) => tile.setAttribute("aria-pressed", String(tile.dataset.symbol === symbol)));

  try {
    const [fundamentalsResponse, insightsResponse] = await Promise.all([
      fetch(`/api/fundamentals?symbol=${encodeURIComponent(symbol)}`),
      fetch(`/api/insights?symbol=${encodeURIComponent(symbol)}`),
    ]);
    if (fundamentalsResponse.status === 401 || insightsResponse.status === 401) {
      window.location.assign("/login");
      return;
    }
    const [fundamentals, insights] = await Promise.all([fundamentalsResponse.json(), insightsResponse.json()]);
    if (requestId !== researchRequest) return;
    if (!fundamentalsResponse.ok && !insightsResponse.ok) throw new Error(fundamentals.error || insights.error || "Research data is unavailable.");

    const data = fundamentals.metrics || {};
    const targets = insights.targets;
    const targetUpside = targets?.consensus > 0 && quote.price > 0 ? targets.consensus / quote.price - 1 : null;
    const yearPosition = quote.yearHigh > quote.yearLow ? (quote.price - quote.yearLow) / (quote.yearHigh - quote.yearLow) : null;
    const profitability = data.profitability ? `${data.profitability.profitableYears}/${data.profitability.years} years` : "—";
    const cashTrend = data.cashFlowGrowth ? `${data.cashFlowGrowth.increases}/${data.cashFlowGrowth.steps} increases` : "—";

    researchBody.innerHTML = `
      <div class="research-hero">
        <div><span>Price</span><strong>${escapeHtml(formatMoney(quote.price, quote.currency))}</strong><small class="${quote.change >= 0 ? "tone-up" : "tone-down"}">${escapeHtml(formatChange(quote.change, quote.changePercent))} today</small></div>
        <div class="range-card"><span>52-week range</span><strong>${escapeHtml(formatMoney(quote.yearLow, quote.currency))} – ${escapeHtml(formatMoney(quote.yearHigh, quote.currency))}</strong><div class="range-track"><span style="width:${Number.isFinite(yearPosition) ? Math.max(0, Math.min(100, yearPosition * 100)).toFixed(1) : 0}%"></span></div><small>${Number.isFinite(yearPosition) ? `${(yearPosition * 100).toFixed(0)}% through range` : "Range unavailable"}</small></div>
      </div>
      <div class="research-section">
        <h3>Market snapshot</h3>
        <div class="research-grid">
          ${metric("Day range", `${formatMoney(quote.dayLow, quote.currency)} – ${formatMoney(quote.dayHigh, quote.currency)}`)}
          ${metric("Volume", formatCompact(quote.volume))}
          ${metric("Exchange", quote.exchange || "—", quote.providerSymbol || "")}
          ${metric("Market cap", Number.isFinite(data.marketCapUsd) ? formatMoney(data.marketCapUsd, "USD") : data.marketCap ? formatMoney(data.marketCap.value, data.marketCap.currency) : "—")}
        </div>
      </div>
      <div class="research-section">
        <h3>Financial quality</h3>
        <div class="research-grid">
          ${metric("P/E", Number.isFinite(data.pe) ? data.pe.toFixed(1) : "—")}
          ${metric("ROE", formatRatio(data.roe))}
          ${metric("ROA", formatRatio(data.roa))}
          ${metric("Debt / equity", Number.isFinite(data.debtToEquity) ? data.debtToEquity.toFixed(2) : "—")}
          ${metric("Profitable history", profitability)}
          ${metric("EPS growth", formatRatio(data.epsGrowth?.cagr), data.epsGrowth ? `${data.epsGrowth.firstYear}–${data.epsGrowth.lastYear}` : "")}
          ${metric("Cash-flow trend", cashTrend)}
          ${metric("Net tangible assets", Number.isFinite(data.netTangibleAssets) ? formatCompact(data.netTangibleAssets) : "—", data.currency || "")}
        </div>
      </div>
      <div class="research-section">
        <h3>Analyst and ownership signals</h3>
        <div class="research-grid">
          ${metric("Consensus target", targets?.consensus ? formatMoney(targets.consensus, quote.currency) : "—", Number.isFinite(targetUpside) ? `${formatRatio(targetUpside)} vs current` : providerStatus(insights.status?.targets))}
          ${metric("Target range", targets ? `${formatMoney(targets.low, quote.currency)} – ${formatMoney(targets.high, quote.currency)}` : "—")}
          ${metric("Earnings history", insights.earnings ? `${insights.earnings.beats}/${insights.earnings.reported} met or beat` : providerStatus(insights.status?.earnings))}
          ${metric("Insider activity", insights.insiders ? `${insights.insiders.acquired} acquired · ${insights.insiders.disposed} disposed` : providerStatus(insights.status?.insiders), insights.insiders?.latest || "")}
        </div>
      </div>
      ${fundamentals.error ? `<p class="research-note">${escapeHtml(fundamentals.error)}</p>` : ""}
    `;
    researchStatus.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    if (requestId !== researchRequest) return;
    researchStatus.textContent = "Unavailable";
    researchBody.innerHTML = `<div class="research-loading">${escapeHtml(error.message || "Research data could not be loaded.")}</div>`;
  }
}

async function scanTickers() {
  const tickers = parseTickers(tickerInput.value);

  if (!tickers.length) {
    tickerInput.value = sampleTickers;
    saveTickers();
    statusText.textContent = "Loaded sample tickers.";
    return;
  }

  saveTickers();
  setLoading(true);
  missingSymbols.textContent = "";

  try {
    const response = await fetch(`/api/quotes?symbols=${encodeURIComponent(tickers.join(","))}`);
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
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
  }
}

tickerFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  tickerInput.value = await file.text();
  saveTickers();
  statusText.textContent = `${file.name} loaded.`;
});

tickerInput.addEventListener("input", saveTickers);

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
  localStorage.removeItem(savedTickersKey);
  latestQuotes = new Map();
  selectedResearch = "";
  marketBrief.hidden = true;
  researchPanel.hidden = true;
  renderEmpty("Upload or paste ticker symbols to see a green and red market heatmap.");
});

quoteTiles.addEventListener("click", (event) => {
  const tile = event.target.closest("[data-symbol]");
  if (tile) selectResearch(tile.dataset.symbol);
});

function saveTickers() {
  const value = tickerInput.value.trim();
  if (value) {
    localStorage.setItem(savedTickersKey, value);
  } else {
    localStorage.removeItem(savedTickersKey);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const urlSymbols = new URLSearchParams(window.location.search).get("symbols");
  const savedTickers = localStorage.getItem(savedTickersKey);
  tickerInput.value = urlSymbols || savedTickers || sampleTickers;
  if (urlSymbols || savedTickers) scanTickers();
});
