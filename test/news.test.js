const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createApp } = require("../server");

const PASSWORD = "news-test-password";

const shared = {
  uuid: "shared-1",
  title: "Memory makers rally",
  publisher: "Reuters",
  link: "https://finance.yahoo.com/news/memory-makers-rally.html",
  providerPublishTime: 1790000000,
};

// Stand-in for Yahoo's search endpoint, keyed by the q parameter.
const NEWS = {
  MU: [
    shared,
    { uuid: "mu-1", title: "Micron beats estimates", publisher: "Bloomberg", link: "https://example.com/micron", providerPublishTime: 1790003600 },
    { uuid: "bad-link", title: "Tricky", publisher: "Nobody", link: "javascript:alert(1)", providerPublishTime: 1790007200 },
    { uuid: "no-title", title: "", publisher: "Nobody", link: "https://example.com/empty", providerPublishTime: 1790007200 },
    null,
  ],
  "RHM.DE": [
    shared,
    {
      id: "rhm-1",
      content: {
        title: "Rheinmetall wins order",
        pubDate: "2026-09-22T08:00:00Z",
        provider: { displayName: "Handelsblatt" },
        canonicalUrl: { url: "https://example.com/rheinmetall" },
      },
    },
  ],
  QUIET: [],
};

async function startApp(t) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const target = new URL(String(url));
    if (!target.hostname.endsWith("finance.yahoo.com")) return realFetch(url, options);
    const symbol = target.searchParams.get("q");
    calls.push(symbol);
    if (!(symbol in NEWS)) return Promise.resolve(Response.json({ error: "down" }, { status: 500 }));
    return Promise.resolve(Response.json({ quotes: [], news: NEWS[symbol] }));
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
  const get = (path, withCookie = true) => fetch(`${base}${path}`, { headers: withCookie ? { Cookie: cookie } : {} });
  return { get, calls };
}

test("merges news for every holding, newest first", async (t) => {
  const { get, calls } = await startApp(t);

  const response = await get("/api/news?symbols=MU,RHM.DE,QUIET,DOWN");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const data = await response.json();

  assert.deepEqual(data.failed, ["DOWN"]);
  assert.deepEqual(data.items.map((item) => item.id), ["rhm-1", "mu-1", "shared-1"]);
  assert.deepEqual(data.items.find((item) => item.id === "shared-1").symbols, ["MU", "RHM.DE"]);
  assert.deepEqual(data.items.find((item) => item.id === "rhm-1"), {
    id: "rhm-1",
    title: "Rheinmetall wins order",
    publisher: "Handelsblatt",
    url: "https://example.com/rheinmetall",
    publishedAt: "2026-09-22T08:00:00.000Z",
    symbols: ["RHM.DE"],
  });
  assert.equal(data.items.find((item) => item.id === "mu-1").publishedAt, new Date(1790003600 * 1000).toISOString());

  // A second request within the cache window doesn't go back to Yahoo for the symbols that worked.
  await get("/api/news?symbols=MU,RHM.DE");
  assert.deepEqual(calls.filter((symbol) => symbol === "MU"), ["MU"]);
});

test("reports an outage when no news source answers", async (t) => {
  const { get } = await startApp(t);

  const response = await get("/api/news?symbols=DOWN,ALSODOWN");
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Could not fetch news/);
});

test("requires symbols and a session", async (t) => {
  const { get } = await startApp(t);

  assert.equal((await get("/api/news")).status, 400);
  assert.equal((await get("/api/news?symbols=MU", false)).status, 401);
});
