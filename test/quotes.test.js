const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createApp } = require("../server");

const PASSWORD = "quotes-test-password";

// Minimal stand-ins for Yahoo's chart and search endpoints.
const CHARTS = {
  MU: { currency: "USD", regularMarketPrice: 110, chartPreviousClose: 100, regularMarketDayHigh: 112, regularMarketDayLow: 98, regularMarketVolume: 123456, fiftyTwoWeekHigh: 130, fiftyTwoWeekLow: 60, longName: "Micron Technology, Inc." },
  "RHM.DE": { currency: "EUR", regularMarketPrice: 990, chartPreviousClose: 1000, longName: "Rheinmetall AG" },
  "VOD.L": { currency: "GBp", regularMarketPrice: 70, chartPreviousClose: 70, longName: "Vodafone Group" },
  "285A.T": { currency: "JPY", regularMarketPrice: 12000, chartPreviousClose: 12000, longName: "Kioxia Holdings Corp." },
  KI5: { currency: "EUR", regularMarketPrice: 1, chartPreviousClose: 1, longName: "Unrelated company" },
  "USDEUR=X": { currency: "EUR", regularMarketPrice: 0.875 },
  "JPYEUR=X": { currency: "EUR", regularMarketPrice: 0.006 },
  "GBPEUR=X": { currency: "EUR", regularMarketPrice: 1.2 },
};

function fakeYahoo(url) {
  const { pathname, searchParams } = new URL(url);
  if (pathname.startsWith("/v1/finance/search")) {
    const quotes = searchParams.get("q") === "RHM" ? [{ symbol: "RHM.DE", isYahooFinance: true }] : [];
    return Response.json({ quotes });
  }

  const symbol = decodeURIComponent(pathname.split("/").pop());
  const meta = CHARTS[symbol];
  if (!meta) return Response.json({ chart: { result: null, error: { description: "Not found" } } }, { status: 404 });
  return Response.json({ chart: { result: [{ meta: { symbol, ...meta } }], error: null } });
}

test("adds base-currency FX rates for every quote currency", async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const target = new URL(String(url));
    if (!target.hostname.endsWith("finance.yahoo.com")) return realFetch(url, options);
    if (target.hostname === "query1.finance.yahoo.com") return Promise.resolve(new Response("unavailable", { status: 503 }));
    return Promise.resolve(fakeYahoo(String(url)));
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

  const loginResponse = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: PASSWORD }),
  });
  const cookie = loginResponse.headers.getSetCookie()[0].split(";")[0];

  const response = await fetch(`${base}/api/quotes?symbols=MU,RHM,VOD.L,NOPE&base=eur`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.base, "EUR");
  assert.deepEqual(data.missing, ["NOPE"]);
  assert.deepEqual(data.fx, { USD: 0.875, EUR: 1, GBp: 0.012 });

  const rheinmetall = data.quotes.find((quote) => quote.symbol === "RHM");
  assert.equal(rheinmetall.providerSymbol, "RHM.DE");
  assert.equal(rheinmetall.currency, "EUR");

  const micron = data.quotes.find((quote) => quote.symbol === "MU");
  assert.deepEqual(
    { dayHigh: micron.dayHigh, dayLow: micron.dayLow, yearHigh: micron.yearHigh, yearLow: micron.yearLow, volume: micron.volume },
    { dayHigh: 112, dayLow: 98, yearHigh: 130, yearLow: 60, volume: 123456 }
  );

  const kioxia = await (await fetch(`${base}/api/quotes?symbols=KI5&base=EUR`, { headers: { Cookie: cookie } })).json();
  assert.equal(kioxia.quotes[0].providerSymbol, "285A.T", "Revolut's KI5 resolves to the Tokyo listing first");
  assert.equal(kioxia.fx.JPY, 0.006);

  const withoutBase =await (await fetch(`${base}/api/quotes?symbols=MU`, { headers: { Cookie: cookie } })).json();
  assert.equal(withoutBase.fx, undefined);
});
