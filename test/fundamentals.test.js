const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { createApp } = require("../server");
const { deriveMetrics, parseTimeseries } = require("../fundamentals");

const PASSWORD = "fundamentals-test-password";

function point(date, raw, currencyCode = "EUR") {
  return { dataId: 1, asOfDate: date, periodType: "12M", currencyCode, reportedValue: { raw, fmt: String(raw) } };
}

function series(type, points) {
  return { meta: { symbol: ["TEST"], type: [type] }, timestamp: points.map(() => 0), [type]: points };
}

// Shaped like Yahoo's fundamentals-timeseries response.
const TIMESERIES = {
  timeseries: {
    result: [
      series("annualNetIncome", [point("2021-12-31", 80), point("2022-12-31", 90), point("2023-12-31", 100), point("2024-12-31", 120)]),
      series("annualStockholdersEquity", [point("2023-12-31", 550), point("2024-12-31", 600)]),
      series("annualTotalAssets", [point("2024-12-31", 1200)]),
      series("annualTotalDebt", [point("2024-12-31", 300)]),
      series("annualNetTangibleAssets", [point("2024-12-31", 400)]),
      series("annualOperatingCashFlow", [point("2021-12-31", 100), point("2022-12-31", 110), point("2023-12-31", 105), point("2024-12-31", 130)]),
      series("annualIssuanceOfDebt", [point("2024-12-31", 50)]),
      series("annualRepaymentOfDebt", [point("2024-12-31", -80)]),
      series("annualDilutedEPS", [point("2021-12-31", 2), null, point("2023-12-31", 2.5), point("2024-12-31", 3)]),
      series("trailingPeRatio", [
        { asOfDate: "2025-09-26", periodType: "TTM", reportedValue: { raw: 13.9 } },
        { asOfDate: "2025-06-30", periodType: "TTM", reportedValue: { raw: 12.5 } },
      ]),
      series("trailingMarketCap", [{ asOfDate: "2025-09-26", periodType: "TTM", currencyCode: "EUR", reportedValue: { raw: 2e9 } }]),
      { meta: { symbol: ["TEST"], type: ["annualNetIncomeCommonStockholders"] } },
    ],
    error: null,
  },
};

describe("financial metrics", () => {
  test("parses Yahoo's timeseries, oldest first, skipping gaps", () => {
    const parsed = parseTimeseries(TIMESERIES);
    assert.deepEqual(parsed.annualDilutedEPS.map((item) => item.value), [2, 2.5, 3]);
    assert.deepEqual(parsed.trailingPeRatio.map((item) => item.value), [12.5, 13.9]);
    assert.equal(parsed.annualNetIncomeCommonStockholders, undefined);
    assert.deepEqual(parseTimeseries({}), {});
  });

  test("derives the checklist numbers", () => {
    const metrics = deriveMetrics(parseTimeseries(TIMESERIES), { price: 50, priceCurrency: "EUR" });

    assert.deepEqual(metrics.profitability, { profitableYears: 4, years: 4, firstYear: "2021", lastYear: "2024" });
    assert.equal(metrics.roe, 0.2);
    assert.equal(metrics.roa, 0.1);
    assert.equal(metrics.debtToEquity, 0.5);
    assert.equal(metrics.operatingCashFlow, 130);
    assert.equal(metrics.netBorrowing, -30);
    assert.equal(metrics.netTangibleAssets, 400);
    assert.deepEqual(metrics.cashFlowGrowth, { increases: 2, steps: 3, firstYear: "2021", lastYear: "2024" });
    assert.equal(metrics.epsGrowth.cagr.toFixed(4), "0.1447");
    assert.equal(metrics.pe, 13.9);
    assert.deepEqual(metrics.marketCap, { value: 2e9, currency: "EUR" });
    assert.equal(metrics.negativeEquity, false);
  });

  test("falls back to price over EPS and shares, and flags negative equity", () => {
    const metrics = deriveMetrics(
      {
        annualNetIncome: [{ date: "2024-12-31", value: -5, currency: "USD" }],
        annualStockholdersEquity: [{ date: "2024-12-31", value: -10, currency: "USD" }],
        annualDilutedEPS: [{ date: "2024-12-31", value: 4, currency: "USD" }],
        annualOrdinarySharesNumber: [{ date: "2024-12-31", value: 1e6, currency: "" }],
      },
      { price: 40, priceCurrency: "USD" }
    );

    assert.equal(metrics.pe, 10);
    assert.deepEqual(metrics.marketCap, { value: 4e7, currency: "USD" });
    assert.equal(metrics.negativeEquity, true);
    assert.equal(metrics.roe, null);
    assert.equal(metrics.netBorrowing, null);
  });
});

describe("/api/fundamentals", () => {
  async function startApp(t) {
    const calls = [];
    let timeseriesDown = false;
    const realFetch = globalThis.fetch;
    const chart = (symbol, meta) => Response.json({ chart: { result: [{ meta: { symbol, ...meta } }], error: null } });

    globalThis.fetch = (url, options) => {
      const target = new URL(String(url));
      if (!target.hostname.endsWith("finance.yahoo.com")) return realFetch(url, options);
      calls.push(target.pathname);
      if (target.pathname.includes("fundamentals-timeseries")) {
        return Promise.resolve(timeseriesDown ? new Response("down", { status: 500 }) : Response.json(TIMESERIES));
      }
      const symbol = decodeURIComponent(target.pathname.split("/").pop());
      if (symbol === "TEST") return Promise.resolve(chart(symbol, { currency: "EUR", regularMarketPrice: 50, instrumentType: "EQUITY", longName: "Test AG" }));
      if (symbol === "FUND") return Promise.resolve(chart(symbol, { currency: "EUR", regularMarketPrice: 5, instrumentType: "ETF", longName: "Test ETF" }));
      if (symbol === "EURUSD=X") return Promise.resolve(chart(symbol, { currency: "USD", regularMarketPrice: 1.15 }));
      if (target.pathname.startsWith("/v1/finance/search")) return Promise.resolve(Response.json({ quotes: [] }));
      return Promise.resolve(Response.json({ chart: { result: null, error: { description: "Not found" } } }, { status: 404 }));
    };
    t.after(() => {
      globalThis.fetch = realFetch;
    });

    const app = createApp({ auth: { password: PASSWORD, sessionSecret: "secret", logger: { warn() {} } } });
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    const login = await fetch(`${base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD }),
    });
    const cookie = login.headers.getSetCookie()[0].split(";")[0];
    return {
      calls,
      setTimeseriesDown: (down) => {
        timeseriesDown = down;
      },
      get: (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }),
    };
  }

  test("returns a company's metrics with its market cap in dollars", async (t) => {
    const { get, calls } = await startApp(t);

    const data = await (await get("/api/fundamentals?symbol=test")).json();
    assert.equal(data.symbol, "TEST");
    assert.equal(data.name, "Test AG");
    assert.equal(data.instrumentType, "EQUITY");
    assert.equal(data.error, null);
    assert.equal(data.metrics.roe, 0.2);
    assert.equal(data.metrics.marketCapUsd, 2.3e9);

    await get("/api/fundamentals?symbol=TEST");
    assert.equal(calls.filter((path) => path.includes("fundamentals-timeseries")).length, 1, "cached for the second request");
  });

  test("skips statements for funds", async (t) => {
    const { get, calls } = await startApp(t);

    const data = await (await get("/api/fundamentals?symbol=FUND")).json();
    assert.equal(data.instrumentType, "ETF");
    assert.equal(data.metrics, null);
    assert.equal(calls.some((path) => path.includes("fundamentals-timeseries")), false);
  });

  test("reports unknown tickers and statement outages", async (t) => {
    const { get, calls, setTimeseriesDown } = await startApp(t);

    assert.equal((await get("/api/fundamentals?symbol=NOPE")).status, 404);
    assert.equal((await get("/api/fundamentals")).status, 400);

    setTimeseriesDown(true);
    const failed = await (await get("/api/fundamentals?symbol=TEST")).json();
    assert.equal(failed.metrics, null);
    assert.match(failed.error, /couldn't be loaded/);

    // Failures aren't cached, so the next request tries again.
    setTimeseriesDown(false);
    const recovered = await (await get("/api/fundamentals?symbol=TEST")).json();
    assert.equal(recovered.error, null);
    assert.equal(calls.filter((path) => path.includes("fundamentals-timeseries")).length, 2);
  });
});
