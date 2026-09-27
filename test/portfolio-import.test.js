const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { parseCsv, parseMoney, parseNumber, parsePortfolioFile } = require("../public/portfolio-import");

const HEADER = "Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate";

function statement(...rows) {
  return [HEADER, ...rows].join("\r\n");
}

function holding(result, ticker) {
  return result.holdings.find((item) => item.ticker === ticker);
}

describe("Revolut account statements", () => {
  test("rebuilds open positions with an average cost in the account currency", () => {
    const result = parsePortfolioFile(statement(
      "2024-01-02T10:00:00.000Z,,CASH TOP-UP,,,EUR 1000,EUR,1.0000",
      "2024-01-03T14:30:00.123456Z,MU,BUY - MARKET,2,USD 85.00,USD 170.00,USD,1.0950",
      "2024-01-04T15:00:00.000Z,RHM,BUY - LIMIT,1,EUR 280.00,EUR 280.00,EUR,1.0000",
      "2024-02-01T14:30:00.000Z,MU,BUY - MARKET,1,USD 88.00,USD 88.00,USD,1.1000",
      "2024-03-01T14:30:00.000Z,MU,SELL - MARKET,1.5,USD 100.00,USD 150.00,USD,1.0800",
      "2024-03-15T00:00:00.000Z,MU,DIVIDEND,,,USD 0.35,USD,1.0850",
      "2024-04-01T00:00:00.000Z,,CUSTODY FEE,,,EUR -0.50,EUR,1.0000",
      "2024-05-01T14:30:00.000Z,AAPL,BUY - MARKET,0.5,USD 170.00,USD 85.00,USD,1.0700",
      "2024-06-01T14:30:00.000Z,AAPL,SELL - MARKET,0.5,USD 190.00,USD 95.00,USD,1.0750",
      '2024-06-10T00:00:00.000Z,NVDA,BUY - MARKET,0.1,"USD 1,200.00",USD 120.00,USD,1.0800',
      "2024-06-11T00:00:00.000Z,NVDA,STOCK SPLIT,0.9,,,USD,1.0800"
    ));

    assert.equal(result.format, "revolut-statement");
    assert.deepEqual(result.holdings.map((item) => item.ticker), ["MU", "NVDA", "RHM"]);
    // 3 MU bought for 170/1.095 + 88/1.1 EUR, half sold: the remaining 1.5 keep half the cost.
    assert.deepEqual(holding(result, "MU"), { ticker: "MU", name: "", quantity: 1.5, currency: "USD", cost: { amount: 117.63, currency: "EUR" } });
    assert.deepEqual(holding(result, "RHM").cost, { amount: 280, currency: "EUR" });
    assert.equal(holding(result, "NVDA").quantity, 1);
    assert.deepEqual(holding(result, "NVDA").cost, { amount: 111.11, currency: "EUR" });
    assert.equal(result.summary, "3 open positions from 7 trades.");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /stock split/);
  });

  test("reads the older export with plain numbers", () => {
    const result = parsePortfolioFile(statement(
      "2021-03-01T14:36:09.823Z,TSLA,BUY - MARKET,0.1,690.45,69.05,USD,1.21",
      "2021-03-02T08:00:00.000Z,,CASH TOP-UP,,,100,USD,1.21"
    ));

    assert.deepEqual(result.holdings, [{ ticker: "TSLA", name: "", quantity: 0.1, currency: "USD", cost: { amount: 57.07, currency: "EUR" } }]);
  });

  test("replays trades in date order even when the file is newest first", () => {
    const result = parsePortfolioFile(statement(
      "2024-03-01T14:30:00Z,MU,SELL - MARKET,1,USD 100,USD 100,USD,1.1",
      "2024-01-01T14:30:00Z,MU,BUY - MARKET,2,USD 50,USD 100,USD,1.1"
    ));

    assert.equal(holding(result, "MU").quantity, 1);
    assert.deepEqual(holding(result, "MU").cost, { amount: 45.45, currency: "EUR" });
  });

  test("keeps the cost in the trade currency when the FX rate is missing", () => {
    const result = parsePortfolioFile(statement("2024-01-01T14:30:00Z,MU,BUY - MARKET,2,USD 50,USD 100,USD,"));
    assert.deepEqual(holding(result, "MU").cost, { amount: 100, currency: "USD" });
  });

  test("warns when a statement starts after shares were bought", () => {
    const result = parsePortfolioFile(statement(
      "2024-01-01T14:30:00Z,MU,SELL - MARKET,1,USD 100,USD 100,USD,1.1",
      "2024-01-02T14:30:00Z,RHM,BUY - MARKET,1,EUR 500,EUR 500,EUR,1"
    ));

    assert.deepEqual(result.holdings.map((item) => item.ticker), ["RHM"]);
    assert.match(result.warnings.join(" "), /More shares sold than bought for MU/);
  });

  test("reports a statement where everything was sold", () => {
    assert.throws(
      () => parsePortfolioFile(statement(
        "2024-01-01T14:30:00Z,MU,BUY - MARKET,1,USD 100,USD 100,USD,1.1",
        "2024-02-01T14:30:00Z,MU,SELL - MARKET,1,USD 120,USD 120,USD,1.1"
      )),
      /No open positions/
    );
  });
});

describe("holdings CSV", () => {
  test("reads quantities, cost basis and a cash row", () => {
    const result = parsePortfolioFile([
      "Ticker,Name,Quantity,Currency,Cost basis,Cost currency",
      "AAPL,Apple Inc.,2.5,USD,410.00,EUR",
      "VWCE,Vanguard FTSE All-World,3.5,EUR,,",
      "SAP,SAP SE,1.25,EUR,200.00,EUR",
      "CASH,Cash balance,150.25,EUR,,",
    ].join("\n"));

    assert.equal(result.format, "holdings");
    assert.deepEqual(result.cash, { amount: 150.25, currency: "EUR" });
    assert.deepEqual(result.holdings, [
      { ticker: "AAPL", name: "Apple Inc.", quantity: 2.5, currency: "USD", cost: { amount: 410, currency: "EUR" } },
      { ticker: "SAP", name: "SAP SE", quantity: 1.25, currency: "EUR", cost: { amount: 200, currency: "EUR" } },
      { ticker: "VWCE", name: "Vanguard FTSE All-World", quantity: 3.5, currency: "EUR", cost: null },
    ]);
    assert.equal(result.summary, "3 holdings and a cash balance imported.");
  });

  test("handles semicolons, decimal commas and average prices", () => {
    const result = parsePortfolioFile("﻿Symbol;Shares;Average price;Currency\nmu;1,5;85,20;USD\nRHM;2;\"1.234,50\";EUR\n");

    assert.deepEqual(holding(result, "MU"), { ticker: "MU", name: "", quantity: 1.5, currency: "USD", cost: { amount: 127.8, currency: "USD" } });
    assert.deepEqual(holding(result, "RHM").cost, { amount: 2469, currency: "EUR" });
  });

  test("merges repeated tickers", () => {
    const result = parsePortfolioFile("Ticker,Quantity,Average price,Currency\nMU,1,100,USD\nMU,2,130,USD\n");
    assert.deepEqual(result.holdings, [{ ticker: "MU", name: "", quantity: 3, currency: "USD", cost: { amount: 360, currency: "USD" } }]);
  });
});

describe("files that aren't portfolio reports", () => {
  const cases = [
    ["an empty file", "  \n", /empty/],
    ["a PDF", "%PDF-1.7 ...", /PDF statements/],
    ["an Excel workbook", "PK\u0003\u0004 ...", /\.xlsx/],
    ["a profit and loss statement", "Date acquired,Date sold,Symbol,Security name,ISIN,Country,Quantity,Cost basis,Gross proceeds,Gross PnL,Currency\n2024-01-01,2024-02-01,MU,Micron,US5951121038,US,1,100,120,20,USD", /profit and loss/],
    ["a file without tickers", "foo,bar\n1,2", /Ticker or Symbol/],
    ["a file without quantities", "Ticker,Price\nMU,100", /Quantity/],
  ];

  for (const [name, content, message] of cases) {
    test(`rejects ${name}`, () => {
      assert.throws(() => parsePortfolioFile(content), message);
    });
  }
});

describe("number parsing", () => {
  test("understands common number formats", () => {
    assert.equal(parseNumber("1,234.56"), 1234.56);
    assert.equal(parseNumber("1.234,56"), 1234.56);
    assert.equal(parseNumber("1 234,56"), 1234.56);
    assert.equal(parseNumber("0,5"), 0.5);
    assert.equal(parseNumber("1,234"), 1234);
    assert.equal(parseNumber("1,234", { decimalComma: true }), 1.234);
    assert.equal(parseNumber("1.234", { decimalComma: true }), 1234);
    assert.equal(parseNumber("0.125", { decimalComma: true }), 0.125);
    assert.equal(parseNumber("(12.50)"), -12.5);
    assert.equal(parseNumber("- 5.00"), -5);
    assert.equal(parseNumber("−3"), -3);
    assert.ok(Number.isNaN(parseNumber("")));
    assert.ok(Number.isNaN(parseNumber("n/a")));
  });

  test("splits amounts from their currency", () => {
    assert.deepEqual(parseMoney("USD 1,234.56"), { amount: 1234.56, currency: "USD" });
    assert.deepEqual(parseMoney("-USD 5.00"), { amount: -5, currency: "USD" });
    assert.deepEqual(parseMoney("$172.50"), { amount: 172.5, currency: "USD" });
    assert.deepEqual(parseMoney("€117.64"), { amount: 117.64, currency: "EUR" });
    assert.deepEqual(parseMoney("172.50"), { amount: 172.5, currency: "" });
  });

  test("parses quoted CSV fields", () => {
    assert.deepEqual(parseCsv('a,"b, with comma","say ""hi"""\r\n\r\n1,2,3'), [["a", "b, with comma", 'say "hi"'], ["1", "2", "3"]]);
  });
});
