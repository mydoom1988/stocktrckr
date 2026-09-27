(() => {
  const STORAGE_KEY = "stocktrckr.checklists";
  const WATCHLIST_KEY = "stocktrckr.tickers";
  const REVIEW_YEARS = 3;
  const PARALLEL_CHECKS = 3;
  const VERDICTS = { strong: "Fits your rules", partial: "Partly fits", weak: "Doesn't fit" };
  const STATUS_SYMBOLS = { pass: "✓", fail: "✕", unknown: "?" };
  const STATUS_WORDS = { pass: "met", fail: "not met", unknown: "not checked" };
  const NOTE_FIELDS = [
    ["thesis", "Why I'd buy (thesis)", "textarea"],
    ["buyZone", "Buy zone", "input"],
    ["sellRule", "Sell rule", "input"],
    ["risks", "Risks", "textarea"],
  ];
  const { evaluate, summarize, nextAnswer } = window.ChecklistRules;

  const form = document.querySelector("#checkForm");
  const tickerInput = document.querySelector("#checkTicker");
  const suggestions = document.querySelector("#checkSuggestions");
  const message = document.querySelector("#checkMessage");
  const rankingList = document.querySelector("#rankingList");
  const checkHoldingsButton = document.querySelector("#checkHoldings");
  const title = document.querySelector("#selectedTitle");
  const scorePill = document.querySelector("#selectedScore");
  const body = document.querySelector("#thesisBody");

  let entries = loadEntries();
  let holdings = [];
  let selected = "";
  const pending = new Set();

  function escapeHtml(value) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
  }

  function loadEntries() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return saved?.items && typeof saved.items === "object" ? saved.items : {};
    } catch (error) {
      return {};
    }
  }

  function saveEntries() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, items: entries }));
    } catch (error) {
      showMessage("This browser blocked storage, so checklists will be gone after a reload.");
    }
  }

  function showMessage(text) {
    message.textContent = text;
  }

  function normalizeTicker(value) {
    return String(value || "").trim().toUpperCase();
  }

  function isCompany(entry) {
    return entry.instrumentType === "EQUITY";
  }

  function scoreOf(entry) {
    const results = evaluate(entry.metrics, entry.answers);
    return { results, summary: summarize(results) };
  }

  function reviewDate(entry) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.boughtOn || "")) return null;
    const date = new Date(`${entry.boughtOn}T00:00:00`);
    date.setFullYear(date.getFullYear() + REVIEW_YEARS);
    return date;
  }

  function isReviewDue(entry) {
    const date = reviewDate(entry);
    return Boolean(date && date <= new Date());
  }

  function rankedEntries() {
    return Object.values(entries)
      .map((entry) => ({ entry, score: isCompany(entry) ? scoreOf(entry).summary : null }))
      .sort((a, b) => {
        if (!a.score || !b.score) return (a.score ? -1 : 1) - (b.score ? -1 : 1) || a.entry.ticker.localeCompare(b.entry.ticker);
        return b.score.met - a.score.met || a.score.unknown - b.score.unknown || a.entry.ticker.localeCompare(b.entry.ticker);
      });
  }

  function renderSuggestions() {
    let watchlist = [];
    try {
      watchlist = String(localStorage.getItem(WATCHLIST_KEY) || "").split(/[,\s;]+/);
    } catch (error) {
      // Suggestions are a convenience; carry on without the watchlist.
    }
    const tickers = [...new Set([...holdings.map((holding) => holding.ticker), ...watchlist].map(normalizeTicker).filter(Boolean))];
    suggestions.innerHTML = tickers.map((ticker) => `<option value="${escapeHtml(ticker)}"></option>`).join("");
    checkHoldingsButton.hidden = !holdings.length;
  }

  function renderRanking() {
    const ranked = rankedEntries();
    if (!ranked.length && !pending.size) {
      rankingList.innerHTML = `<li class="ranking-empty">Check a ticker, or all your holdings, to rank them against your buying rules.</li>`;
      return;
    }

    const rows = ranked.map(({ entry, score }) => {
      const badges = [];
      if (score) {
        if (score.verdict) badges.push(`<span class="verdict ${score.verdict}">${VERDICTS[score.verdict]}</span>`);
        if (score.unknown) badges.push(`<span class="verdict neutral">${score.unknown} to check</span>`);
      } else {
        badges.push(`<span class="verdict neutral">Fund, not scored</span>`);
      }
      if (isReviewDue(entry)) badges.push(`<span class="verdict partial">Review due</span>`);

      return `
        <li>
          <button class="rank-row" type="button" data-ticker="${escapeHtml(entry.ticker)}" aria-pressed="${entry.ticker === selected}">
            <span class="rank-name"><strong>${escapeHtml(entry.ticker)}</strong><span>${escapeHtml(entry.name || "")}</span></span>
            <span class="rank-score">${score ? `<strong>${score.met}</strong>/${score.total}` : "—"}</span>
            <span class="rank-badges">${badges.join("")}</span>
          </button>
        </li>
      `;
    });
    const waiting = [...pending].filter((ticker) => !entries[ticker]);
    rows.push(...waiting.map((ticker) => `<li class="ranking-empty">Checking ${escapeHtml(ticker)}…</li>`));
    rankingList.innerHTML = rows.join("");
  }

  function renderCriterion(item) {
    const detail = [item.detail, item.source === "you" ? "Set by you." : ""].filter(Boolean).join(" ");
    return `
      <li class="check-row">
        <button class="check-status ${item.status}" type="button" data-criterion="${item.id}"
          aria-label="${escapeHtml(`${item.label}: ${STATUS_WORDS[item.status]}. Tap to change.`)}">${STATUS_SYMBOLS[item.status]}</button>
        <span class="check-text">
          <span class="check-label">${escapeHtml(item.label)}</span>
          ${detail ? `<span class="check-detail">${escapeHtml(detail)}</span>` : ""}
        </span>
      </li>
    `;
  }

  function renderScore(entry) {
    const summaryBox = body.querySelector("#checkSummary");
    const criteriaBox = body.querySelector("#checkCriteria");
    if (!summaryBox || !criteriaBox) return;

    if (!isCompany(entry)) {
      scorePill.textContent = "Fund";
      summaryBox.innerHTML = `<p class="section-note">This is a fund, not a company. The checklist is for individual companies, because a fund holds many of them.</p>`;
      criteriaBox.innerHTML = "";
      return;
    }

    const { results, summary } = scoreOf(entry);
    scorePill.textContent = `${summary.met}/${summary.total}`;
    const source = entry.metrics
      ? `Financials from Yahoo Finance (${entry.providerSymbol}), fetched ${new Date(entry.fetchedAt).toLocaleDateString()}.`
      : "No financial data, so answer every rule yourself.";
    summaryBox.innerHTML = `
      <p class="check-summary">
        ${summary.verdict ? `<span class="verdict ${summary.verdict}">${VERDICTS[summary.verdict]}</span>` : ""}
        ${summary.met} met · ${summary.notMet} not met · ${summary.unknown} to check
      </p>
      <p class="section-note">${escapeHtml(entry.error ? `${entry.error} Answer those rules yourself.` : source)}
        <button class="link-button" type="button" data-action="refresh">Refresh</button></p>
    `;
    criteriaBox.innerHTML = `
      <h3 class="check-group">From the financials</h3>
      <ul class="check-list">${results.filter((item) => item.group === "data").map(renderCriterion).join("")}</ul>
      <h3 class="check-group">Your judgement</h3>
      <ul class="check-list">${results.filter((item) => item.group === "judgement").map(renderCriterion).join("")}</ul>
    `;
  }

  function renderReview(entry) {
    const note = body.querySelector("#reviewNote");
    if (!note) return;
    const date = reviewDate(entry);
    note.hidden = !date;
    if (!date) return;
    note.classList.toggle("due", isReviewDue(entry));
    note.textContent = isReviewDue(entry)
      ? `3-year rule: review is due (since ${date.toLocaleDateString()}). Has the market seen what you saw? If not, weigh what the money could earn elsewhere.`
      : `3-year rule: review by ${date.toLocaleDateString()}. Has the market seen what you saw? If not, weigh what the money could earn elsewhere.`;
  }

  function renderSelected() {
    const entry = entries[selected];
    if (!entry) {
      title.textContent = "Select a ticker";
      scorePill.textContent = "--";
      body.innerHTML = `<p class="section-note">Pick a stock from the ranking to see which of your rules it meets, then write down your thesis, buy zone, sell rule and risks. Everything is saved in this browser.</p>`;
      return;
    }

    title.textContent = entry.name ? `${entry.ticker} · ${entry.name}` : entry.ticker;
    const notes = NOTE_FIELDS.map(([key, label, element]) => {
      const value = escapeHtml(entry.notes?.[key] || "");
      const field = element === "textarea"
        ? `<textarea data-note="${key}" rows="3">${value}</textarea>`
        : `<input type="text" data-note="${key}" value="${value}" />`;
      return `<label>${label}${field}</label>`;
    }).join("");

    body.innerHTML = `
      <div id="checkSummary"></div>
      <div id="checkCriteria"></div>
      <div class="thesis-notes">
        ${notes}
        <label>Bought on<input type="date" data-field="boughtOn" value="${escapeHtml(entry.boughtOn || "")}" /></label>
        <p class="review-note" id="reviewNote" hidden></p>
      </div>
      <button class="secondary" type="button" data-action="remove">Remove from list</button>
    `;
    renderScore(entry);
    renderReview(entry);
  }

  function select(ticker) {
    selected = ticker;
    renderRanking();
    renderSelected();
  }

  async function check(ticker) {
    if (pending.has(ticker)) return false;
    pending.add(ticker);
    renderRanking();

    try {
      const response = await fetch(`/api/fundamentals?symbol=${encodeURIComponent(ticker)}`);
      if (response.status === 401) {
        window.location.assign("/login");
        return false;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Couldn't check that ticker.");

      const entry = entries[ticker] || { ticker, answers: {}, notes: {}, boughtOn: "" };
      Object.assign(entry, {
        name: data.name,
        providerSymbol: data.providerSymbol,
        instrumentType: data.instrumentType,
        metrics: data.metrics,
        error: data.error,
        fetchedAt: data.updatedAt,
      });
      entries[ticker] = entry;
      saveEntries();
      return true;
    } catch (error) {
      showMessage(error.message);
      return false;
    } finally {
      pending.delete(ticker);
      renderRanking();
      if (ticker === selected) renderSelected();
    }
  }

  async function checkAll(tickers) {
    const queue = [...tickers];
    let checked = 0;
    showMessage(`Checking ${queue.length} holdings…`);
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL_CHECKS, queue.length) }, async () => {
        while (queue.length) {
          if (await check(queue.shift())) checked += 1;
        }
      })
    );
    showMessage(`Checked ${checked} of ${tickers.length} holdings.`);
    if (!entries[selected]) select(rankedEntries()[0]?.entry.ticker || "");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const ticker = normalizeTicker(tickerInput.value);
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) {
      showMessage("Enter a ticker such as MU, or a Yahoo symbol such as RHM.DE.");
      return;
    }
    showMessage("");
    tickerInput.value = "";
    if (await check(ticker)) select(ticker);
  });

  checkHoldingsButton.addEventListener("click", () => {
    checkAll(holdings.map((holding) => holding.ticker));
  });

  rankingList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-ticker]");
    if (row) select(row.dataset.ticker);
  });

  body.addEventListener("click", (event) => {
    const entry = entries[selected];
    if (!entry) return;

    const criterion = event.target.closest("[data-criterion]");
    if (criterion) {
      const item = scoreOf(entry).results.find((result) => result.id === criterion.dataset.criterion);
      const answer = nextAnswer(item);
      if (answer) entry.answers[item.id] = answer;
      else delete entry.answers[item.id];
      saveEntries();
      renderScore(entry);
      renderRanking();
      body.querySelector(`[data-criterion="${item.id}"]`)?.focus();
      return;
    }

    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "refresh") {
      check(entry.ticker);
    } else if (action === "remove" && window.confirm(`Remove ${entry.ticker} and its notes from the list?`)) {
      delete entries[entry.ticker];
      saveEntries();
      select(rankedEntries()[0]?.entry.ticker || "");
    }
  });

  body.addEventListener("input", (event) => {
    const entry = entries[selected];
    if (!entry) return;
    const { note, field } = event.target.dataset;
    if (note) {
      entry.notes = { ...entry.notes, [note]: event.target.value };
    } else if (field === "boughtOn") {
      entry.boughtOn = event.target.value;
      renderReview(entry);
      renderRanking();
    } else {
      return;
    }
    saveEntries();
  });

  // portfolio.js announces the holdings whenever prices load or the portfolio changes.
  document.addEventListener("portfolio:holdings", (event) => {
    holdings = event.detail.holdings;
    renderSuggestions();
  });

  renderSuggestions();
  selected = rankedEntries()[0]?.entry.ticker || "";
  renderRanking();
  renderSelected();
})();
