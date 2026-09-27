// Turns a portfolio report into holdings. Understands Revolut brokerage account statements
// (the Excel/CSV export) and simple holdings CSVs with Ticker and Quantity columns.
// Runs in the browser as window.PortfolioImport and in Node for the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.PortfolioImport = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const QUANTITY_EPSILON = 1e-6;
  const CURRENCY_SYMBOLS = [
    ["US$", "USD"],
    ["$", "USD"],
    ["€", "EUR"],
    ["£", "GBP"],
    ["¥", "JPY"],
  ];
  // Header names are compared lowercased with everything but letters and digits removed.
  const COLUMNS = {
    date: ["date", "datetime", "time", "tradedate"],
    ticker: ["ticker", "symbol", "tickersymbol"],
    type: ["type", "transactiontype", "action"],
    quantity: ["quantity", "qty", "shares", "units", "numberofshares"],
    price: ["pricepershare", "price", "shareprice"],
    total: ["totalamount", "total"],
    currency: ["currency", "ccy"],
    fxRate: ["fxrate", "exchangerate"],
    name: ["name", "securityname", "security", "instrument", "company", "description"],
    averagePrice: ["averageprice", "avgprice", "averagecost", "avgcost", "costpershare", "averagebuyprice"],
    costBasis: ["costbasis", "cost", "totalcost", "invested", "bookcost"],
    costCurrency: ["costcurrency", "costbasiscurrency"],
  };
  const PROFIT_AND_LOSS_COLUMNS = ["datesold", "grossproceeds", "grosspnl", "realisedpnl", "realizedpnl"];

  function parseNumber(value, { decimalComma = false } = {}) {
    let text = String(value ?? "").trim();
    let sign = 1;

    if (/^\(.*\)$/.test(text)) {
      sign = -1;
      text = text.slice(1, -1);
    }
    text = text.replace(/[\s  '’]/g, "");
    if (/^[-−]/.test(text)) {
      sign = -sign;
      text = text.slice(1);
    } else if (text.startsWith("+")) {
      text = text.slice(1);
    }
    if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return NaN;

    const lastComma = text.lastIndexOf(",");
    const lastDot = text.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      // Both separators: whichever comes last marks the decimals (1,234.56 or 1.234,56).
      text = lastComma > lastDot ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
    } else if (lastComma >= 0) {
      const thousands = /^[1-9]\d{0,2}(,\d{3})+$/.test(text) && !decimalComma;
      text = thousands ? text.replace(/,/g, "") : text.replace(",", ".");
    } else if (decimalComma && /^[1-9]\d{0,2}(\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, "");
    }

    const number = Number(text);
    return Number.isFinite(number) ? sign * number : NaN;
  }

  // Revolut writes amounts as "USD 1,234.56", "$1,234.56" or plain numbers.
  function parseMoney(value, numberOptions) {
    const text = String(value ?? "").trim();
    let currency = (text.match(/\b[A-Z]{3}\b/) || [])[0] || "";
    if (!currency) {
      const symbol = CURRENCY_SYMBOLS.find(([sign]) => text.includes(sign));
      currency = symbol ? symbol[1] : "";
    }
    return { amount: parseNumber(text.replace(/[A-Za-z$€£¥]/g, ""), numberOptions), currency };
  }

  function parseCsv(text, delimiter = ",") {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inQuotes) {
        if (char === '"' && text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (char === '"') {
          inQuotes = false;
        } else {
          field += char;
        }
      } else if (char === '"' && field === "") {
        inQuotes = true;
      } else if (char === delimiter) {
        row.push(field);
        field = "";
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += char;
      }
    }
    row.push(field);
    rows.push(row);

    return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
  }

  function detectDelimiter(content) {
    const sample = content.slice(0, 4000).replace(/"(?:[^"]|"")*"/g, "");
    const scores = [",", ";", "\t"].map((delimiter) => [delimiter, sample.split(delimiter).length - 1]);
    scores.sort((a, b) => b[1] - a[1]);
    return scores[0][1] > 0 ? scores[0][0] : ",";
  }

  function normalizeHeader(header) {
    return String(header).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function findColumns(headers) {
    const normalized = headers.map(normalizeHeader);
    const columns = {};
    for (const [key, aliases] of Object.entries(COLUMNS)) {
      columns[key] = normalized.findIndex((header) => aliases.includes(header));
    }
    return { columns, normalized };
  }

  function cell(row, index) {
    return index >= 0 ? String(row[index] ?? "").trim() : "";
  }

  function normalizeTicker(value) {
    return String(value).trim().toUpperCase().replace(/\s+/g, "");
  }

  function normalizeCurrency(value) {
    const text = String(value).trim();
    return /^[A-Za-z]{3}$/.test(text) ? text.toUpperCase() : "";
  }

  function parseDate(value) {
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
  }

  function roundTo(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function byTicker(a, b) {
    return a.ticker.localeCompare(b.ticker);
  }

  // Prefer the booked total (it includes fees) when it is in the trade currency.
  function tradeValue(quantity, price, total, currency) {
    if (Number.isFinite(total.amount) && total.amount !== 0 && (!total.currency || total.currency === currency)) {
      return Math.abs(total.amount);
    }
    if (price.amount > 0 && (!price.currency || price.currency === currency)) {
      return quantity * price.amount;
    }
    return NaN;
  }

  // Revolut's "FX Rate" is the price of one unit of the account currency in the trade currency
  // (for example 1.09 USD per EUR), so dividing converts a trade amount to the account currency.
  function toBaseCurrency(amount, currency, fxRate, baseCurrency) {
    if (currency === baseCurrency) return amount;
    if (fxRate > 0 && fxRate !== 1) return amount / fxRate;
    return NaN;
  }

  function addShares(position, quantity, value, fxRate, baseCurrency) {
    position.quantity += quantity;
    if (!Number.isFinite(value)) {
      position.costKnown = false;
      position.baseCostKnown = false;
      return;
    }

    position.cost += value;
    const baseValue = toBaseCurrency(value, position.currency, fxRate, baseCurrency);
    if (Number.isFinite(baseValue)) {
      position.baseCost += baseValue;
    } else {
      position.baseCostKnown = false;
    }
  }

  // Selling keeps the average cost of the shares that remain.
  function removeShares(position, quantity) {
    if (position.quantity > QUANTITY_EPSILON) {
      const soldShare = Math.min(quantity / position.quantity, 1);
      position.cost -= position.cost * soldShare;
      position.baseCost -= position.baseCost * soldShare;
    }
    position.quantity -= quantity;

    if (Math.abs(position.quantity) <= QUANTITY_EPSILON) {
      Object.assign(position, { quantity: 0, cost: 0, baseCost: 0, costKnown: true, baseCostKnown: true });
    }
  }

  function parseStatement(records, columns, baseCurrency, numberOptions) {
    const positions = new Map();
    const unknownTypes = new Set();
    const warnings = [];
    let trades = 0;
    let splits = 0;

    const entries = records.map((row, index) => ({ row, index, time: parseDate(cell(row, columns.date)) }));
    if (entries.every((entry) => Number.isFinite(entry.time))) {
      entries.sort((a, b) => a.time - b.time || a.index - b.index);
    }

    for (const { row } of entries) {
      const ticker = normalizeTicker(cell(row, columns.ticker));
      const type = cell(row, columns.type).toUpperCase();
      const quantity = parseNumber(cell(row, columns.quantity), numberOptions);
      // Cash top-ups, withdrawals, dividends and fees don't change share counts.
      if (!ticker || !quantity || /DIVIDEND|FEE|TAX|CASH|INTEREST/.test(type)) continue;

      const price = parseMoney(cell(row, columns.price), numberOptions);
      const total = parseMoney(cell(row, columns.total), numberOptions);
      const currency = normalizeCurrency(cell(row, columns.currency)) || price.currency || total.currency || baseCurrency;
      const fxRate = parseNumber(cell(row, columns.fxRate), numberOptions);
      const position = positions.get(ticker) || {
        ticker,
        currency,
        quantity: 0,
        cost: 0,
        baseCost: 0,
        costKnown: true,
        baseCostKnown: true,
      };
      positions.set(ticker, position);

      if (/\bSELL\b/.test(type)) {
        trades += 1;
        removeShares(position, Math.abs(quantity));
      } else if (/\bBUY\b/.test(type)) {
        trades += 1;
        addShares(position, Math.abs(quantity), tradeValue(Math.abs(quantity), price, total, currency), fxRate, baseCurrency);
      } else if (/SPLIT/.test(type)) {
        // Revolut books the extra (or, for a reverse split, removed) shares as the quantity.
        splits += 1;
        position.quantity += quantity;
      } else if (/TRANSFER/.test(type)) {
        trades += 1;
        if (quantity > 0) {
          addShares(position, quantity, tradeValue(quantity, price, total, currency), fxRate, baseCurrency);
        } else {
          removeShares(position, -quantity);
        }
      } else {
        unknownTypes.add(type || "(no type)");
      }
    }

    const holdings = [];
    const oversold = [];
    for (const position of positions.values()) {
      if (position.quantity < -QUANTITY_EPSILON) oversold.push(position.ticker);
      if (position.quantity <= QUANTITY_EPSILON) continue;

      let cost = null;
      if (position.baseCostKnown && position.baseCost > 0) {
        cost = { amount: roundTo(position.baseCost, 2), currency: baseCurrency };
      } else if (position.costKnown && position.cost > 0) {
        cost = { amount: roundTo(position.cost, 2), currency: position.currency };
      }
      holdings.push({ ticker: position.ticker, name: "", quantity: roundTo(position.quantity, 8), currency: position.currency, cost });
    }

    if (oversold.length) {
      warnings.push(`More shares sold than bought for ${oversold.join(", ")}. Export the statement from the day the account was opened so every buy is included.`);
    }
    if (splits) {
      warnings.push(`Applied ${splits} stock split ${splits === 1 ? "entry" : "entries"}; double-check those quantities against Revolut.`);
    }
    if (unknownTypes.size) {
      warnings.push(`Ignored rows of type ${[...unknownTypes].join(", ")}.`);
    }

    return {
      format: "revolut-statement",
      label: "Revolut account statement",
      holdings: holdings.sort(byTicker),
      cash: null,
      summary: `${holdings.length} open position${holdings.length === 1 ? "" : "s"} from ${trades} trade${trades === 1 ? "" : "s"}.`,
      warnings,
    };
  }

  function parseHoldings(records, columns, baseCurrency, numberOptions) {
    const holdings = new Map();
    const warnings = [];
    let cash = null;

    for (const row of records) {
      const ticker = normalizeTicker(cell(row, columns.ticker));
      if (!ticker) continue;
      const quantity = parseNumber(cell(row, columns.quantity), numberOptions);
      const currency = normalizeCurrency(cell(row, columns.currency));

      // A CASH row carries the cash balance in its quantity column.
      if (ticker === "CASH") {
        if (Number.isFinite(quantity) && (!currency || currency === baseCurrency)) {
          cash = { amount: roundTo((cash?.amount || 0) + quantity, 2), currency: baseCurrency };
        } else {
          warnings.push(`Skipped a cash row that isn't in ${baseCurrency}.`);
        }
        continue;
      }
      if (!(quantity > 0)) {
        warnings.push(`Skipped ${ticker}: the quantity is missing or zero.`);
        continue;
      }

      const costBasis = parseMoney(cell(row, columns.costBasis), numberOptions);
      const averagePrice = parseMoney(cell(row, columns.averagePrice), numberOptions);
      let cost = null;
      if (costBasis.amount > 0) {
        const costCurrency = normalizeCurrency(cell(row, columns.costCurrency)) || costBasis.currency || currency || baseCurrency;
        cost = { amount: costBasis.amount, currency: costCurrency };
      } else if (averagePrice.amount > 0) {
        cost = { amount: averagePrice.amount * quantity, currency: averagePrice.currency || currency || baseCurrency };
      }

      const existing = holdings.get(ticker);
      if (existing) {
        existing.quantity += quantity;
        existing.cost = existing.cost && cost && existing.cost.currency === cost.currency
          ? { amount: existing.cost.amount + cost.amount, currency: cost.currency }
          : null;
      } else {
        holdings.set(ticker, { ticker, name: cell(row, columns.name), quantity, currency, cost });
      }
    }

    const list = [...holdings.values()].map((holding) => ({
      ...holding,
      quantity: roundTo(holding.quantity, 8),
      cost: holding.cost && { amount: roundTo(holding.cost.amount, 2), currency: holding.cost.currency },
    }));

    return {
      format: "holdings",
      label: "Holdings CSV",
      holdings: list.sort(byTicker),
      cash,
      summary: `${list.length} holding${list.length === 1 ? "" : "s"}${cash ? " and a cash balance" : ""} imported.`,
      warnings,
    };
  }

  function parsePortfolioFile(text, { baseCurrency = "EUR" } = {}) {
    const content = String(text ?? "").replace(/^﻿/, "");
    if (!content.trim()) throw new Error("The file is empty.");
    if (content.startsWith("%PDF")) {
      throw new Error("PDF statements can't be read here. In Revolut, export the account statement as Excel (CSV) and upload that file.");
    }
    if (content.startsWith("PK")) {
      throw new Error("This looks like an Excel workbook (.xlsx). Save it as CSV and upload the CSV file.");
    }

    const delimiter = detectDelimiter(content);
    const numberOptions = { decimalComma: delimiter === ";" };
    const rows = parseCsv(content, delimiter);
    const headerIndex = rows.slice(0, 25).findIndex((row) => findColumns(row).columns.ticker >= 0);
    if (headerIndex < 0) {
      throw new Error("Couldn't find a Ticker or Symbol column. Upload the Revolut account statement (Excel/CSV export) or a CSV with Ticker and Quantity columns.");
    }

    const { columns, normalized } = findColumns(rows[headerIndex]);
    if (normalized.some((header) => PROFIT_AND_LOSS_COLUMNS.includes(header))) {
      throw new Error("This is a profit and loss statement, which only lists closed trades. Upload the account statement instead.");
    }
    if (columns.quantity < 0) throw new Error("Couldn't find a Quantity column in this file.");

    const records = rows.slice(headerIndex + 1);
    const isStatement = columns.type >= 0 && records.some((row) => /\b(BUY|SELL)\b/i.test(cell(row, columns.type)));
    const result = isStatement
      ? parseStatement(records, columns, baseCurrency, numberOptions)
      : parseHoldings(records, columns, baseCurrency, numberOptions);

    if (!result.holdings.length) {
      throw new Error(isStatement ? "No open positions found in this statement." : "No holdings found in this file.");
    }
    return result;
  }

  return { parsePortfolioFile, parseCsv, parseMoney, parseNumber };
});
