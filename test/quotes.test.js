const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createApp } = require("../server");

const PASSWORD = "quotes-test-password";

// Minimal stand-ins for Yahoo's chart and search endpoints.
const CHARTS = {
  MU: { currency: "USD", regularMarketPrice: 110, chartPreviousClose: 100, longName: "Micron Technology, Inc." },
  "RHM.DE": { currency: "EUR", regularMarketPrice: 990, chartPreviousClose: 1000, longName: "Rheinmetall AG" },
  "VOD.L": { currency: "GBp", regularMarketPrice: 70, chartPreviousClose: 70, longName: "Vodafone Group" },
  "USDEUR=X": { currency: "EUR", regularMarketPrice: 0.875 },
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
  globalThis.fetch = (url, options) => (String(url).includes("finance.yahoo.com") ? Promise.resolve(fakeYahoo(String(url))) : realFetch(url, options));
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

  const withoutBase = await (await fetch(`${base}/api/quotes?symbols=MU`, { headers: { Cookie: cookie } })).json();
  assert.equal(withoutBase.fx, undefined);
});
