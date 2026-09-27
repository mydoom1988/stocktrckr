(() => {
  const BASE_CURRENCY = "EUR";
  const STORAGE_KEY = "stocktrckr.portfolio";
  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  const fileInput = document.querySelector("#portfolioFile");
  const removeButton = document.querySelector("#portfolioRemove");
  const summary = document.querySelector("#portfolioSummary");
  const notice = document.querySelector("#portfolioNotice");
  const holdingsList = document.querySelector("#portfolioHoldings");
  const statusLine = document.querySelector("#portfolioStatus");
  const refreshButton = document.querySelector("#refreshButton");

  let portfolio = loadPortfolio();
  let market = null;
  let marketError = "";
  let loading = false;
  let requestCounter = 0;

  function escapeHtml(value) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
  }

  function loadPortfolio() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return saved && Array.isArray(saved.holdings) ? saved : null;
    } catch (error) {
      return null;
    }
  }

  function savePortfolio() {
    try {
      if (portfolio) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      showNotice("This browser blocked storage, so the portfolio will be gone after a reload.", "error");
    }
  }

  function isMinorUnit(currency) {
    return !/^[A-Z]{3}$/.test(currency) || currency === "GBX" || currency === "ILA";
  }

  function formatMoney(value, currency = BASE_CURRENCY, digits = 2) {
    if (!Number.isFinite(value)) return "—";
    const options = { minimumFractionDigits: digits, maximumFractionDigits: digits };
    if (!isMinorUnit(currency)) {
      try {
        return new Intl.NumberFormat(undefined, { ...options, style: "currency", currency }).format(value);
      } catch (error) {
        // Unknown currency code: fall through to a plain number.
      }
    }
    return `${new Intl.NumberFormat(undefined, options).format(value)} ${currency}`;
  }

  function formatPrice(value, currency) {
    return formatMoney(value, currency, Math.abs(value) < 1 ? 4 : 2);
  }

  function formatSignedMoney(value) {
    if (!Number.isFinite(value)) return "—";
    return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatMoney(Math.abs(value))}`;
  }

  function formatPercent(ratio, signed = true) {
    if (!Number.isFinite(ratio)) return "—";
    const percent = ratio * 100;
    return `${signed && percent > 0 ? "+" : ""}${percent.toFixed(2)}%`;
  }

  function formatQuantity(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
  }

  function tone(value) {
    return value > 0 ? "tone-up" : value < 0 ? "tone-down" : "tone-flat";
  }

  // Revolut-style return badge: arrow plus the unsigned percentage.
  function returnBadge(ratio) {
    const arrow = ratio > 0 ? "▲ " : ratio < 0 ? "▼ " : "";
    return `${arrow}${formatPercent(Math.abs(ratio), false)}`;
  }

  function evaluate(holding) {
    const quote = market?.quotes.get(holding.ticker) || null;
    if (!quote || !(quote.price > 0)) return { holding, quote: null, valueBase: NaN };

    const fx = market.fx;
    const rate = fx[quote.currency];
    const valueNative = holding.quantity * quote.price;
    const valueBase = rate > 0 ? valueNative * rate : NaN;
    const dayChangeBase = rate > 0 && quote.previousClose > 0 ? holding.quantity * (quote.price - quote.previousClose) * rate : NaN;
    let costBase = NaN;
    let returnRatio = NaN;

    if (holding.cost?.amount > 0) {
      if (holding.cost.currency === quote.currency) {
        returnRatio = valueNative / holding.cost.amount - 1;
        costBase = rate > 0 ? holding.cost.amount * rate : NaN;
      } else {
        const costRate = holding.cost.currency === BASE_CURRENCY ? 1 : fx[holding.cost.currency];
        costBase = costRate > 0 ? holding.cost.amount * costRate : NaN;
        returnRatio = valueBase / costBase - 1;
      }
    }

    return { holding, quote, valueNative, valueBase, dayChangeBase, costBase, returnRatio };
  }

  function summarize(rows) {
    const cash = Number.isFinite(portfolio.cash?.amount) ? portfolio.cash.amount : null;
    const totals = { cash, count: rows.length, priced: 0, invested: 0, dayChange: 0, cost: 0, gain: 0, withCost: 0 };

    for (const row of rows) {
      if (!Number.isFinite(row.valueBase)) continue;
      totals.priced += 1;
      totals.invested += row.valueBase;
      if (Number.isFinite(row.dayChangeBase)) totals.dayChange += row.dayChangeBase;
      if (row.costBase > 0) {
        totals.withCost += 1;
        totals.cost += row.costBase;
        totals.gain += row.valueBase - row.costBase;
      }
    }

    const previousValue = totals.invested - totals.dayChange;
    totals.total = totals.priced ? totals.invested + (cash || 0) : NaN;
    totals.dayChangeRatio = previousValue > 0 ? totals.dayChange / previousValue : NaN;
    // Like Revolut's account figure, the return counts cash at face value.
    totals.gainRatio = totals.cost > 0 ? totals.gain / (totals.cost + (cash || 0)) : NaN;
    return totals;
  }

  function renderSummary(totals) {
    const partial = totals.priced < totals.count;
    const noPrices = totals.priced === 0;
    const gainNote = totals.withCost < totals.priced ? ` (${totals.withCost} of ${totals.priced})` : "";

    return `
      <div class="portfolio-total">
        <span class="stat-label">Total value${partial && !noPrices ? " (partial)" : ""}</span>
        <strong class="stat-value">${noPrices ? "—" : formatMoney(totals.total)}</strong>
        ${Number.isFinite(totals.gainRatio) ? `<span class="stat-change ${tone(totals.gain)}">${returnBadge(totals.gainRatio)} all time</span>` : ""}
      </div>
      <dl class="portfolio-stats">
        <div>
          <dt>Today</dt>
          <dd class="${noPrices ? "" : tone(totals.dayChange)}">${noPrices ? "—" : `${formatSignedMoney(totals.dayChange)}<span class="stat-ratio">${formatPercent(totals.dayChangeRatio)}</span>`}</dd>
        </div>
        <div>
          <dt>Total return${gainNote}</dt>
          <dd class="${totals.withCost ? tone(totals.gain) : ""}">${totals.withCost ? `${formatSignedMoney(totals.gain)}<span class="stat-ratio">${formatPercent(totals.gainRatio)}</span>` : "—"}</dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd><button class="link-button" type="button" data-action="edit-cash">${totals.cash === null ? "Add" : formatMoney(totals.cash)}</button></dd>
        </div>
        <div>
          <dt>Holdings</dt>
          <dd>${totals.count}</dd>
        </div>
      </dl>
    `;
  }

  function renderHolding(row, total) {
    const { holding, quote } = row;
    const name = holding.name || quote?.name || holding.ticker;
    const meta = [`${formatQuantity(holding.quantity)} ${holding.ticker}`];
    if (quote) meta.push(formatPrice(quote.price, quote.currency));
    if (row.valueBase > 0 && total > 0) meta.push(`${((row.valueBase / total) * 100).toFixed(1)}%`);

    let value = "—";
    if (Number.isFinite(row.valueBase)) value = formatMoney(row.valueBase);
    else if (quote) value = formatMoney(row.valueNative, quote.currency);

    const day = quote
      ? `<span class="holding-day ${tone(quote.changePercent)}">${formatPercent(quote.changePercent / 100)} today</span>`
      : `<span class="holding-day tone-flat">${loading ? "Loading price…" : "No live price"}</span>`;
    const source = quote ? `${quote.providerSymbol} · ${quote.name} · ${quote.exchange}` : holding.ticker;

    return `
      <article class="holding" title="${escapeHtml(source)}">
        <div class="holding-main">
          <strong class="holding-name">${escapeHtml(name)}</strong>
          <span class="holding-meta">${escapeHtml(meta.join(" · "))}</span>
        </div>
        <div class="holding-figures">
          <strong class="holding-value">${value}</strong>
          ${Number.isFinite(row.returnRatio) ? `<span class="holding-return ${tone(row.returnRatio)}">${returnBadge(row.returnRatio)}</span>` : ""}
          ${day}
        </div>
      </article>
    `;
  }

  function renderStatus() {
    const parts = [portfolio.label, portfolio.fileName, `imported ${new Date(portfolio.importedAt).toLocaleDateString()}`, "saved in this browser only"];
    if (loading) parts.push("loading live prices…");
    else if (marketError) parts.push(marketError);
    else if (market?.updatedAt) parts.push(`prices ${new Date(market.updatedAt).toLocaleTimeString()}`);
    if (market?.missing.length) parts.push(`no price for ${market.missing.join(", ")}`);
    return parts.filter(Boolean).join(" · ");
  }

  // Largest position first; holdings without a price go last.
  function sortedRows() {
    return portfolio.holdings.map(evaluate).sort((a, b) => {
      const aValue = Number.isFinite(a.valueBase) ? a.valueBase : -Infinity;
      const bValue = Number.isFinite(b.valueBase) ? b.valueBase : -Infinity;
      return bValue - aValue || a.holding.ticker.localeCompare(b.holding.ticker);
    });
  }

  // Tells the news panel which holdings to follow, using Yahoo's symbol when a quote resolved one.
  function announceHoldings() {
    const rows = portfolio?.holdings.length ? sortedRows() : [];
    const holdings = rows.map(({ holding, quote }) => ({ ticker: holding.ticker, query: quote?.providerSymbol || holding.ticker }));
    document.dispatchEvent(new CustomEvent("portfolio:holdings", { detail: { holdings } }));
  }

  function render() {
    const hasPortfolio = Boolean(portfolio?.holdings.length);
    removeButton.hidden = !hasPortfolio;
    summary.hidden = !hasPortfolio;

    if (!hasPortfolio) {
      summary.innerHTML = "";
      statusLine.textContent = "";
      holdingsList.innerHTML = `
        <div class="portfolio-empty">
          <strong>No portfolio imported yet</strong>
          <span>In Revolut, export your brokerage account statement as Excel (CSV) and import it here.
          A CSV with Ticker and Quantity columns works too. The file stays in this browser.</span>
        </div>
      `;
      return;
    }

    const rows = sortedRows();
    const totals = summarize(rows);

    summary.innerHTML = renderSummary(totals);
    holdingsList.innerHTML = rows.map((row) => renderHolding(row, totals.total)).join("");
    statusLine.textContent = renderStatus();
  }

  function showNotice(messages, kind) {
    const list = [].concat(messages).filter(Boolean);
    notice.className = `portfolio-notice ${kind}`;
    notice.innerHTML = list.length > 1
      ? `<p>${escapeHtml(list[0])}</p><ul>${list.slice(1).map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>`
      : `<p>${escapeHtml(list[0] || "")}</p>`;
    notice.hidden = false;
  }

  function hideNotice() {
    notice.hidden = true;
    notice.innerHTML = "";
  }

  async function refreshPrices() {
    if (!portfolio?.holdings.length) return;

    const requestId = ++requestCounter;
    loading = true;
    marketError = "";
    render();

    try {
      const symbols = portfolio.holdings.map((holding) => holding.ticker).join(",");
      const response = await fetch(`/api/quotes?base=${BASE_CURRENCY}&symbols=${encodeURIComponent(symbols)}`);
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Quote request failed.");
      if (requestId !== requestCounter) return;

      market = {
        quotes: new Map(data.quotes.map((quote) => [quote.symbol, quote])),
        fx: data.fx || {},
        missing: data.missing || [],
        updatedAt: data.updatedAt,
      };
    } catch (error) {
      if (requestId !== requestCounter) return;
      marketError = error.message || "Live prices are unavailable.";
    }

    loading = false;
    render();
    announceHoldings();
  }

  async function importFile(file) {
    if (file.type.startsWith("image/")) {
      showNotice("Screenshots can't be imported. In Revolut, export the account statement as Excel (CSV) and import that file.", "error");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      showNotice("That file is too large for a portfolio report.", "error");
      return;
    }

    try {
      const result = window.PortfolioImport.parsePortfolioFile(await file.text(), { baseCurrency: BASE_CURRENCY });
      portfolio = {
        version: 1,
        label: result.label,
        fileName: file.name,
        importedAt: new Date().toISOString(),
        holdings: result.holdings,
        // Statements don't carry the cash balance, so keep one entered earlier.
        cash: result.cash || portfolio?.cash || null,
      };
      market = null;
      savePortfolio();
      showNotice([result.summary, ...result.warnings], result.warnings.length ? "warning" : "success");
      refreshPrices();
    } catch (error) {
      showNotice(error.message, "error");
    }
  }

  function editCash() {
    const current = portfolio.cash?.amount;
    const answer = window.prompt(`Cash balance in ${BASE_CURRENCY} (leave empty to clear)`, Number.isFinite(current) ? String(current) : "");
    if (answer === null) return;

    const amount = window.PortfolioImport.parseNumber(answer);
    if (answer.trim() === "") {
      portfolio.cash = null;
    } else if (Number.isFinite(amount) && amount >= 0) {
      portfolio.cash = { amount, currency: BASE_CURRENCY };
    } else {
      showNotice("Enter the cash balance as a number, for example 150.25.", "error");
      return;
    }
    savePortfolio();
    render();
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) importFile(file);
  });

  removeButton.addEventListener("click", () => {
    if (!window.confirm("Remove the imported portfolio from this browser?")) return;
    portfolio = null;
    market = null;
    savePortfolio();
    hideNotice();
    render();
    announceHoldings();
  });

  summary.addEventListener("click", (event) => {
    if (event.target.closest("[data-action='edit-cash']")) editCash();
  });

  refreshButton.addEventListener("click", refreshPrices);

  render();
  refreshPrices();
})();
