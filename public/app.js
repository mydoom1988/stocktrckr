const tickerInput = document.querySelector("#tickerInput");
const tickerFile = document.querySelector("#tickerFile");
const tickerForm = document.querySelector("#tickerForm");
const clearButton = document.querySelector("#clearButton");
const refreshButton = document.querySelector("#refreshButton");
const quoteRows = document.querySelector("#quoteRows");
const statusText = document.querySelector("#statusText");
const missingSymbols = document.querySelector("#missingSymbols");
const updatedAt = document.querySelector("#updatedAt");
const greenCount = document.querySelector("#greenCount");
const redCount = document.querySelector("#redCount");
const flatCount = document.querySelector("#flatCount");

const sampleTickers = "AAPL, MSFT, NVDA, TSLA, AMZN";

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
  quoteRows.innerHTML = `<tr class="empty-row"><td colspan="6">${message}</td></tr>`;
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

  quoteRows.innerHTML = quotes
    .sort((a, b) => b.changePercent - a.changePercent)
    .map((quote) => {
      const changeClass = quote.change > 0 ? "positive" : quote.change < 0 ? "negative" : "";
      const marketTime = quote.marketTime ? new Date(quote.marketTime).toLocaleString() : quote.marketState;

      return `
        <tr>
          <td><span class="signal ${quote.status}">${quote.status}</span></td>
          <td><strong>${quote.symbol}</strong></td>
          <td>${quote.name || quote.symbol}</td>
          <td>${formatMoney(quote.price, quote.currency)}</td>
          <td class="${changeClass}">${formatChange(quote.change, quote.changePercent)}</td>
          <td>${quote.exchange}<br><small>${marketTime}</small></td>
        </tr>
      `;
    })
    .join("");
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
  renderEmpty("Upload or paste ticker symbols to see green and red market moves.");
});

window.addEventListener("DOMContentLoaded", () => {
  tickerInput.value = sampleTickers;
  if (window.lucide) window.lucide.createIcons();
});
