const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const { createApp } = require("../server");

const PASSWORD = "correct horse battery staple";
const silentLogger = { warn() {} };

async function startServer(authOptions = {}) {
  const app = createApp({ auth: { logger: silentLogger, failureDelayMs: 0, password: PASSWORD, sessionSecret: "test-secret", ...authOptions } });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  return {
    url: (path) => `http://127.0.0.1:${server.address().port}${path}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function get(server, path, cookie) {
  return fetch(server.url(path), { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
}

function login(server, password, { next = "/", headers = {} } = {}) {
  return fetch(server.url("/login"), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ username: "stocktrckr", password, next }),
  });
}

function sessionCookie(response) {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith("stocktrckr_session="));
  return header && header.split(";")[0];
}

describe("password protection", () => {
  test("sends signed-out visitors to the login page", async (t) => {
    const server = await startServer();
    t.after(server.close);

    const page = await get(server, "/");
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login");

    const asset = await get(server, "/app.js");
    assert.equal(asset.status, 302);
    assert.equal(asset.headers.get("location"), "/login?next=%2Fapp.js");

    const api = await get(server, "/api/quotes?symbols=MU");
    assert.equal(api.status, 401);
    assert.deepEqual(await api.json(), { error: "Login required." });
  });

  test("serves only the login page, its stylesheet and robots.txt publicly", async (t) => {
    const server = await startServer();
    t.after(server.close);

    const page = await get(server, "/login");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /type="password"/);
    assert.doesNotMatch(html, /\{\{/);

    const css = await get(server, "/login.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const robots = await get(server, "/robots.txt");
    assert.match(await robots.text(), /Disallow: \//);
  });

  test("rejects a wrong password without setting a session", async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await login(server, "not the password");
    assert.equal(response.status, 401);
    assert.equal(sessionCookie(response), undefined);
    assert.match(await response.text(), /Wrong password/);
  });

  test("signs in with the right password and unlocks pages, assets and the API", async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await login(server, PASSWORD);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    const setCookie = response.headers.getSetCookie().join("\n");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=2592000/);

    const cookie = sessionCookie(response);
    const page = await get(server, "/", cookie);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="portfolioHoldings"/);

    const asset = await get(server, "/portfolio.js", cookie);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "private, no-cache");

    // No symbols: the request reaches the quotes handler (400) instead of being refused (401).
    const api = await get(server, "/api/quotes", cookie);
    assert.equal(api.status, 400);
    assert.equal(api.headers.get("cache-control"), "no-store");

    const loginPage = await get(server, "/login", cookie);
    assert.equal(loginPage.status, 303);
    assert.equal(loginPage.headers.get("location"), "/");
  });

  test("marks the cookie Secure when Render's proxy reports HTTPS", async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await login(server, PASSWORD, { headers: { "X-Forwarded-Proto": "https" } });
    assert.match(response.headers.getSetCookie().join("\n"), /Secure/);
  });

  test("ignores tampered, expired and old-password sessions", async (t) => {
    let now = Date.now();
    const server = await startServer({ now: () => now });
    const otherPassword = await startServer({ password: "a different password" });
    t.after(server.close);
    t.after(otherPassword.close);

    const cookie = sessionCookie(await login(server, PASSWORD));
    const tampered = cookie.replace(/.$/, (char) => (char === "A" ? "B" : "A"));
    assert.equal((await get(server, "/", tampered)).status, 302);

    const extended = cookie.replace(/v1\.(\d+)\./, (match, expiry) => `v1.${Number(expiry) + 1}.`);
    assert.equal((await get(server, "/", extended)).status, 302);

    assert.equal((await get(otherPassword, "/", cookie)).status, 302);

    now += 31 * 24 * 60 * 60 * 1000;
    assert.equal((await get(server, "/", cookie)).status, 302);
  });

  test("only redirects to paths on this site after signing in", async (t) => {
    const server = await startServer();
    t.after(server.close);

    for (const next of ["//evil.example", "https://evil.example", "/\\evil.example", "/login"]) {
      const response = await login(server, PASSWORD, { next });
      assert.equal(response.headers.get("location"), "/", next);
    }

    const response = await login(server, PASSWORD, { next: "/?symbols=MU" });
    assert.equal(response.headers.get("location"), "/?symbols=MU");
  });

  test("locks out a client after repeated wrong passwords", async (t) => {
    const server = await startServer({ maxFailuresPerClient: 3 });
    t.after(server.close);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await login(server, "guess")).status, 401);
    }

    const locked = await login(server, PASSWORD);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get("retry-after")) > 0);
    assert.equal(sessionCookie(locked), undefined);
  });

  test("locks everyone out after too many failures in total", async (t) => {
    const server = await startServer({ maxFailuresPerClient: 100, maxFailuresTotal: 2 });
    t.after(server.close);

    await login(server, "guess");
    await login(server, "guess");
    assert.equal((await login(server, PASSWORD)).status, 429);
  });

  test("signs out by clearing the session cookie", async (t) => {
    const server = await startServer();
    t.after(server.close);

    const cookie = sessionCookie(await login(server, PASSWORD));
    const response = await fetch(server.url("/logout"), { method: "POST", redirect: "manual", headers: { Cookie: cookie } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login");
    assert.match(response.headers.getSetCookie().join("\n"), /stocktrckr_session=;.*Expires=Thu, 01 Jan 1970/);
  });

  test("refuses login and logout posts from other sites", async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await login(server, PASSWORD, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(response.status, 403);
    assert.equal(sessionCookie(response), undefined);

    const logout = await fetch(server.url("/logout"), { method: "POST", redirect: "manual", headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(logout.status, 403);
  });

  test("stays locked when APP_PASSWORD is missing", async (t) => {
    const server = await startServer({ password: "  " });
    t.after(server.close);

    assert.equal((await get(server, "/")).status, 302);

    const page = await get(server, "/login");
    assert.equal(page.status, 503);
    assert.match(await page.text(), /APP_PASSWORD/);

    assert.equal((await login(server, "")).status, 503);
    assert.equal((await login(server, "anything")).status, 503);
  });

  test("keeps sessions valid without SESSION_SECRET across restarts", async (t) => {
    const first = await startServer({ sessionSecret: undefined });
    const second = await startServer({ sessionSecret: undefined });
    t.after(first.close);
    t.after(second.close);

    const cookie = sessionCookie(await login(first, PASSWORD));
    assert.equal((await get(second, "/", cookie)).status, 200);
  });

  test("sends privacy and security headers", async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await get(server, "/login");
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(response.headers.get("x-powered-by"), null);
  });
});
