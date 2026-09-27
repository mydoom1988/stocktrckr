(() => {
  const MAX_ITEMS = 40;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  const list = document.querySelector("#newsList");
  const filters = document.querySelector("#newsFilters");
  const status = document.querySelector("#newsStatus");

  let holdings = [];
  let items = [];
  let activeTicker = "";
  let loading = false;
  let error = "";
  let updatedAt = "";
  let requestCounter = 0;

  function escapeHtml(value) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
  }

  function relativeTime(iso) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return "";
    const age = Date.now() - time;
    if (age > WEEK_MS) return new Date(time).toLocaleDateString();

    const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
    for (const [unit, size] of [["day", 86400000], ["hour", 3600000], ["minute", 60000]]) {
      if (age >= size) return format.format(-Math.floor(age / size), unit);
    }
    return format.format(0, "minute");
  }

  function renderItem(item) {
    const when = relativeTime(item.publishedAt);
    return `
      <li class="news-item">
        <a class="news-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
        <div class="news-meta">
          <span class="news-tickers">${escapeHtml(item.tickers.join(" · "))}</span>
          ${item.publisher ? `<span>${escapeHtml(item.publisher)}</span>` : ""}
          ${when ? `<time datetime="${escapeHtml(item.publishedAt)}">${escapeHtml(when)}</time>` : ""}
        </div>
      </li>
    `;
  }

  function render() {
    if (!holdings.length) {
      filters.hidden = true;
      status.textContent = "";
      list.innerHTML = `<li class="news-empty">Import your portfolio to see news for your holdings.</li>`;
      return;
    }

    const counts = new Map();
    for (const item of items) {
      for (const ticker of item.tickers) counts.set(ticker, (counts.get(ticker) || 0) + 1);
    }
    if (!counts.has(activeTicker)) activeTicker = "";

    // Holdings arrive largest position first, so the chips follow that order.
    const chips = holdings.map((holding) => holding.ticker).filter((ticker) => counts.has(ticker));
    filters.hidden = !chips.length;
    filters.innerHTML = ["", ...chips]
      .map((ticker) => `
        <button class="news-filter" type="button" data-ticker="${escapeHtml(ticker)}" aria-pressed="${ticker === activeTicker}">
          ${ticker ? `${escapeHtml(ticker)} <span>${counts.get(ticker)}</span>` : "All"}
        </button>
      `)
      .join("");

    const visible = (activeTicker ? items.filter((item) => item.tickers.includes(activeTicker)) : items).slice(0, MAX_ITEMS);
    if (visible.length) {
      list.innerHTML = visible.map(renderItem).join("");
    } else {
      const message = loading ? "Loading news…" : error || "No recent news found for your holdings.";
      list.innerHTML = `<li class="news-empty">${escapeHtml(message)}</li>`;
    }

    if (loading) status.textContent = "Loading…";
    else if (error && items.length) status.textContent = error;
    else status.textContent = updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  }

  async function load() {
    const requestId = ++requestCounter;
    error = "";

    if (!holdings.length) {
      items = [];
      loading = false;
      render();
      return;
    }

    loading = true;
    render();

    try {
      const queries = [...new Set(holdings.map((holding) => holding.query))];
      const response = await fetch(`/api/news?symbols=${encodeURIComponent(queries.join(","))}`);
      if (response.status === 401) {
        window.location.assign("/login");
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "News request failed.");
      if (requestId !== requestCounter) return;

      // News is looked up by the quote symbol (e.g. RHM.DE); label it with the portfolio's tickers.
      const tickersByQuery = new Map();
      for (const holding of holdings) {
        tickersByQuery.set(holding.query, [...(tickersByQuery.get(holding.query) || []), holding.ticker]);
      }
      items = data.items
        .map((item) => ({ ...item, tickers: [...new Set(item.symbols.flatMap((symbol) => tickersByQuery.get(symbol) || []))] }))
        .filter((item) => item.tickers.length);
      updatedAt = data.updatedAt;
    } catch (requestError) {
      if (requestId !== requestCounter) return;
      error = requestError.message || "News is unavailable right now.";
    }

    loading = false;
    render();
  }

  filters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-ticker]");
    if (!button) return;
    activeTicker = button.dataset.ticker;
    render();
  });

  // portfolio.js announces the holdings (largest first) whenever prices load or the portfolio changes.
  document.addEventListener("portfolio:holdings", (event) => {
    holdings = event.detail.holdings;
    load();
  });

  render();
})();
