const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { createApp } = require("../server");
const { baseTicker, parseEarnings, parseInsiders, parseTargets, pickEntity, toBigdataItem } = require("../providers");

const PASSWORD = "providers-test-password";
const SECRET_KEY = "super-secret-test-key-123";
const silent = { warn() {} };

describe("parsers", () => {
  test("reads analyst targets", () => {
    assert.deepEqual(parseTargets([{ symbol: "X", targetHigh: 300, targetLow: 100, targetConsensus: 210, targetMedian: 200 }]), {
      consensus: 210,
      median: 200,
      high: 300,
      low: 100,
    });
    assert.equal(parseTargets([]), null);
    assert.equal(parseTargets([{ targetConsensus: null }]), null);
  });

  test("counts beats over quarters that have both numbers, newest first", () => {
    const parsed = parseEarnings([
      { date: "2027-01-30", epsActual: null, epsEstimated: 1 },
      { date: "2026-10-30", epsActual: 1.2, epsEstimated: 1.1 },
      { date: "2026-07-30", epsActual: 1.0, epsEstimated: 1.0 },
      { date: "2026-04-30", epsActual: 0.8, epsEstimated: 0.9 },
      { date: "2026-01-30", epsActual: 0.9, epsEstimated: 0.7 },
    ]);
    assert.equal(parsed.reported, 4);
    assert.equal(parsed.beats, 3, "meeting the estimate counts");
    assert.equal(parsed.latest.date, "2026-10-30");
    assert.equal(parseEarnings([]), null);
  });

  test("sums the latest four quarters of insider activity", () => {
    const rows = [
      { year: 2026, quarter: 1, acquiredTransactions: 1, disposedTransactions: 5 },
      { year: 2026, quarter: 3, acquiredTransactions: 4, disposedTransactions: 2 },
      { year: 2026, quarter: 2, acquiredTransactions: 3, disposedTransactions: 3 },
      { year: 2025, quarter: 4, acquiredTransactions: 0, disposedTransactions: 1 },
      { year: 2025, quarter: 3, acquiredTransactions: 99, disposedTransactions: 0 },
    ];
    assert.deepEqual(parseInsiders(rows), { quarters: 4, acquired: 8, disposed: 11, latest: "2026 Q3" });
    assert.equal(parseInsiders([{ foo: 1 }]), null);
  });

  test("only accepts a public company whose listing matches the ticker", () => {
    const body = {
      results: [
        { id: "AAAAAA", type: "PUBLIC", listing_values: ["XNAS:MUU"], ticker: "MUU" },
        { id: "BBBBBB", type: "PRIVATE", listing_values: ["XNAS:MU"] },
        { id: "CCCCCC", type: "PUBLIC", listing_values: ["XMEX:MU", "XNAS:MU"], ticker: "MU" },
      ],
    };
    assert.equal(pickEntity(body, "MU"), "CCCCCC");
    assert.equal(pickEntity({ results: [{ id: "AAAAAA", type: "PUBLIC", listing_values: ["XNAS:MUU"] }] }, "MU"), null);
    assert.equal(baseTicker("285A.T"), "285A");
    assert.equal(baseTicker("RHM.DE"), "RHM");
    assert.equal(baseTicker("BRK-B"), "BRK-B");
  });

  test("turns a Bigdata.com document into a news item with average sentiment", () => {
    const item = toBigdataItem({
      id: "DOC1",
      headline: " Chipmaker raises guidance ",
      timestamp: "2026-10-20T08:00:00",
      source: { id: "S1", name: "Reuters" },
      url: "https://example.com/story",
      chunks: [{ sentiment: 0.4 }, { sentiment: 0.1 }, { sentiment: null }],
    });
    assert.deepEqual(item, {
      id: "bd:DOC1",
      title: "Chipmaker raises guidance",
      publisher: "Reuters",
      url: "https://example.com/story",
      publishedAt: "2026-10-20T08:00:00.000Z",
      sentiment: 0.25,
    });
    assert.equal(toBigdataItem({ headline: "x", url: "javascript:alert(1)" }), null);
  });
});

describe("provider endpoints", () => {
  async function startApp(t, providers, handlers) {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      const target = new URL(String(url));
      if (target.hostname === "financialmodelingprep.com") {
        calls.push({ host: "fmp", path: target.pathname, apikey: target.searchParams.get("apikey") });
        return Promise.resolve(handlers.fmp(target));
      }
      if (target.hostname === "api.bigdata.com") {
        calls.push({ host: "bigdata", path: target.pathname, header: options?.headers?.["X-API-KEY"], body: JSON.parse(options.body) });
        return Promise.resolve(handlers.bigdata(target, JSON.parse(options.body)));
      }
      if (target.hostname.endsWith("finance.yahoo.com")) return Promise.resolve(handlers.yahoo(target));
      return realFetch(url, options);
    };
    t.after(() => {
      globalThis.fetch = realFetch;
    });

    const app = createApp({ providers, auth: { password: PASSWORD, sessionSecret: "secret", logger: silent } });
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
    return { calls, get: (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } }) };
  }

  const chart = (symbol, meta) => Response.json({ chart: { result: [{ meta: { symbol, ...meta } }], error: null } });
  const yahoo = (target) => {
    const symbol = decodeURIComponent(target.pathname.split("/").pop());
    if (symbol === "MU") return chart(symbol, { currency: "USD", regularMarketPrice: 100, instrumentType: "EQUITY", longName: "Micron" });
    if (symbol === "FUND") return chart(symbol, { currency: "EUR", regularMarketPrice: 5, instrumentType: "ETF" });
    if (target.pathname.includes("/news") || target.pathname.startsWith("/v1/finance/search")) {
      return Response.json({ quotes: [], news: [{ uuid: "y1", title: "Yahoo story", publisher: "Yahoo", link: "https://example.com/y", providerPublishTime: 1790000000 }] });
    }
    return Response.json({ chart: { result: null, error: { description: "Not found" } } }, { status: 404 });
  };

  test("returns analyst targets, earnings and insiders, and never exposes the key", async (t) => {
    const fmp = (target) => {
      if (target.pathname.endsWith("price-target-consensus")) return Response.json([{ targetConsensus: 150, targetHigh: 200, targetLow: 90, targetMedian: 140 }]);
      if (target.pathname.endsWith("/earnings")) {
        return Response.json([1, 2, 3, 4].map((n) => ({ date: `2026-0${n}-15`, epsActual: 2, epsEstimated: 1 })));
      }
      return Response.json([{ year: 2026, quarter: 3, acquiredTransactions: 5, disposedTransactions: 1 }]);
    };
    const { get, calls } = await startApp(t, { fmpKey: SECRET_KEY, bigdataKey: "" }, { fmp, yahoo });

    const response = await get("/api/insights?symbol=mu");
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!text.includes(SECRET_KEY), "the key must not appear in the response");

    const data = JSON.parse(text);
    assert.equal(data.configured, true);
    assert.deepEqual(data.targets, { consensus: 150, median: 140, high: 200, low: 90 });
    assert.equal(data.earnings.beats, 4);
    assert.equal(data.insiders.acquired, 5);
    assert.deepEqual(data.status, { targets: "ok", earnings: "ok", insiders: "ok" });
    assert.ok(calls.filter((call) => call.host === "fmp").every((call) => call.apikey === SECRET_KEY));

    await get("/api/insights?symbol=MU");
    assert.equal(calls.filter((call) => call.host === "fmp").length, 3, "second request is served from cache");
  });

  test("reports which parts a plan locks, and retries them later", async (t) => {
    let locked = true;
    const fmp = (target) => {
      if (target.pathname.includes("insider")) {
        return locked
          ? new Response(JSON.stringify({ "Error Message": "Premium Query Parameter: this endpoint requires a higher plan" }), { status: 402 })
          : Response.json([{ year: 2026, quarter: 3, acquiredTransactions: 1, disposedTransactions: 0 }]);
      }
      if (target.pathname.endsWith("price-target-consensus")) return Response.json([{ targetConsensus: 150 }]);
      return Response.json([]);
    };
    const { get } = await startApp(t, { fmpKey: SECRET_KEY, bigdataKey: "" }, { fmp, yahoo });

    const first = await (await get("/api/insights?symbol=MU")).json();
    assert.deepEqual(first.status, { targets: "ok", earnings: "empty", insiders: "locked" });
    assert.equal(first.insiders, null);

    locked = false;
    const second = await (await get("/api/insights?symbol=MU")).json();
    assert.equal(second.status.insiders, "ok");
  });

  test("distinguishes a rejected key, a rate limit and a missing key", async (t) => {
    const { get } = await startApp(t, { fmpKey: SECRET_KEY, bigdataKey: "" }, {
      fmp: (target) =>
        target.pathname.endsWith("earnings")
          ? new Response("Limit Reach . Please upgrade your plan", { status: 429 })
          : new Response(JSON.stringify({ "Error Message": "Invalid API KEY." }), { status: 401 }),
      yahoo,
    });
    const rejected = await (await get("/api/insights?symbol=MU")).json();
    assert.deepEqual(rejected.status, { targets: "rejected", earnings: "limit", insiders: "rejected" });

    const none = await startApp(t, { fmpKey: "", bigdataKey: "" }, { fmp: () => assert.fail("no key, no call"), yahoo });
    const unset = await (await none.get("/api/insights?symbol=MU")).json();
    assert.equal(unset.configured, false);
    assert.equal(none.calls.length, 0);
  });

  test("skips funds and validates input", async (t) => {
    const { get, calls } = await startApp(t, { fmpKey: SECRET_KEY, bigdataKey: "" }, { fmp: () => assert.fail("funds aren't looked up"), yahoo });
    const fund = await (await get("/api/insights?symbol=FUND")).json();
    assert.equal(fund.instrumentType, "ETF");
    assert.equal(calls.length, 0);
    assert.equal((await get("/api/insights")).status, 400);
    assert.equal((await get("/api/insights?symbol=NOPE")).status, 404);
  });

  test("adds Bigdata.com headlines with sentiment to the news feed", async (t) => {
    const bigdata = (target, body) => {
      if (target.pathname === "/v1/knowledge-graph/companies") {
        return Response.json({ results: [{ id: "49BBBC", type: "PUBLIC", listing_values: ["XNAS:MU"], ticker: "MU" }] });
      }
      return Response.json({
        results: [{ id: "D1", headline: "Memory prices climb", timestamp: "2026-10-21T07:00:00", source: { name: "Bigdata Wire" }, url: "https://example.com/bd", chunks: [{ sentiment: 0.5 }] }],
      });
    };
    const { get, calls } = await startApp(t, { fmpKey: "", bigdataKey: SECRET_KEY }, { bigdata, yahoo, fmp: () => assert.fail("not used") });

    const response = await get("/api/news?symbols=MU");
    const text = await response.text();
    assert.ok(!text.includes(SECRET_KEY));
    const { items } = JSON.parse(text);
    const story = items.find((item) => item.id === "bd:D1");
    assert.equal(story.sentiment, 0.5);
    assert.deepEqual(story.symbols, ["MU"]);
    assert.ok(items.some((item) => item.id === "y1"), "Yahoo headlines are still included");

    const search = calls.find((call) => call.path === "/v1/search");
    assert.equal(search.header, SECRET_KEY);
    assert.equal(search.body.search_mode, "fast");
    assert.deepEqual(search.body.query.filters.entity, { any_of: ["49BBBC"] });
  });

  test("still shows Yahoo news when Bigdata.com fails", async (t) => {
    const bigdata = () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    const { get } = await startApp(t, { fmpKey: "", bigdataKey: SECRET_KEY }, { bigdata, yahoo, fmp: () => assert.fail("not used") });

    const data = await (await get("/api/news?symbols=MU")).json();
    assert.deepEqual(data.items.map((item) => item.id), ["y1"]);
    assert.deepEqual(data.failed, []);
  });
});
