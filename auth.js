const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

const COOKIE_NAME = "stocktrckr_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
// Fixed public salt for deriving the cookie-signing key when SESSION_SECRET is unset.
const SESSION_SALT = "stocktrckr-session-v1";
const NOT_CONFIGURED_MESSAGE = "Sign-in is disabled until the APP_PASSWORD environment variable is set on the server.";
const LOGIN_TEMPLATE = fs.readFileSync(path.join(__dirname, "views", "login.html"), "utf8");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function escapeHtml(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/g, (char) => entities[char]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The signing key depends on the password, so changing APP_PASSWORD signs every device out.
function deriveSigningKey(password, sessionSecret) {
  if (sessionSecret) {
    return crypto.createHmac("sha256", String(sessionSecret)).update(password).digest();
  }
  return crypto.scryptSync(password, SESSION_SALT, 32);
}

function signPayload(key, payload) {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function createSessionToken(key, expiresAt) {
  const payload = `v1.${expiresAt}`;
  return `${payload}.${signPayload(key, payload)}`;
}

function verifySessionToken(key, token, now) {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || parts[0] !== "v1" || !/^\d{1,16}$/.test(parts[1])) return false;
  if (Number(parts[1]) <= now) return false;

  const expected = Buffer.from(signPayload(key, `v1.${parts[1]}`));
  const actual = Buffer.from(parts[2]);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readCookie(req, name) {
  for (const pair of String(req.headers.cookie || "").split(";")) {
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index).trim() === name) {
      return pair.slice(index + 1).trim();
    }
  }
  return null;
}

// After signing in, only ever redirect to a path on this site.
function safeNextPath(value) {
  if (typeof value !== "string" || value.length > 512) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/";
  if (/^\/log(in|out)(?:[/?#]|$)/.test(value)) return "/";
  return value;
}

// Browsers tag requests with Sec-Fetch-Site; refuse form posts that come from other sites.
function rejectCrossSite(req, res, next) {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return res.status(403).type("text").send("Cross-site request refused.");
  }
  return next();
}

function renderLoginPage({ next, error, configured }) {
  const values = {
    error: error ? `<p class="login-error" role="alert">${escapeHtml(error)}</p>` : "",
    next: escapeHtml(next),
    disabled: configured ? "" : "disabled",
  };
  return LOGIN_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? "");
}

function createAuth(options = {}) {
  const {
    password,
    sessionSecret,
    logger = console,
    now = Date.now,
    failureDelayMs = 400,
    maxFailuresPerClient = 10,
    maxFailuresTotal = 100,
  } = options;
  const appPassword = String(password || "").trim();
  const configured = appPassword.length > 0;
  const passwordDigest = sha256(appPassword);
  const signingKey = configured ? deriveSigningKey(appPassword, sessionSecret) : null;
  const failures = new Map();
  const totalFailures = { count: 0, resetAt: 0 };

  if (!configured) {
    logger.warn("APP_PASSWORD is not set: every page stays locked until it is configured.");
  } else if (!sessionSecret) {
    logger.warn("SESSION_SECRET is not set: sessions are signed with a key derived from APP_PASSWORD. Set SESSION_SECRET to a long random value.");
  }

  function isAuthenticated(req) {
    return configured && verifySessionToken(signingKey, readCookie(req, COOKIE_NAME), now());
  }

  function cookieOptions(req) {
    return { httpOnly: true, sameSite: "lax", secure: req.secure, path: "/" };
  }

  function lockedForMs(client, time) {
    const entry = failures.get(client);
    const clientWait = entry && entry.resetAt > time && entry.count >= maxFailuresPerClient ? entry.resetAt - time : 0;
    const totalWait = totalFailures.resetAt > time && totalFailures.count >= maxFailuresTotal ? totalFailures.resetAt - time : 0;
    return Math.max(clientWait, totalWait);
  }

  function recordFailure(client, time) {
    for (const [key, entry] of failures) {
      if (entry.resetAt <= time) failures.delete(key);
    }

    const entry = failures.get(client) || { count: 0, resetAt: time + LOCKOUT_WINDOW_MS };
    entry.count += 1;
    failures.set(client, entry);

    if (totalFailures.resetAt <= time) {
      totalFailures.count = 0;
      totalFailures.resetAt = time + LOCKOUT_WINDOW_MS;
    }
    totalFailures.count += 1;
  }

  function sendLoginPage(res, status, { next = "/", error = "" } = {}) {
    res
      .status(status)
      .set("Cache-Control", "no-store")
      .type("html")
      .send(renderLoginPage({ next, error, configured }));
  }

  const router = express.Router();

  router.get("/login", (req, res) => {
    const next = safeNextPath(req.query.next);
    if (isAuthenticated(req)) return res.redirect(303, next);
    if (!configured) return sendLoginPage(res, 503, { next, error: NOT_CONFIGURED_MESSAGE });
    return sendLoginPage(res, 200, { next });
  });

  router.post("/login", rejectCrossSite, express.urlencoded({ extended: false, limit: "8kb" }), async (req, res) => {
    const next = safeNextPath(req.body?.next);
    if (!configured) return sendLoginPage(res, 503, { next, error: NOT_CONFIGURED_MESSAGE });

    const client = req.ip || "unknown";
    const time = now();
    const waitMs = lockedForMs(client, time);
    if (waitMs > 0) {
      res.set("Retry-After", String(Math.ceil(waitMs / 1000)));
      return sendLoginPage(res, 429, { next, error: `Too many attempts. Try again in ${Math.ceil(waitMs / 60000)} min.` });
    }

    const attempt = typeof req.body?.password === "string" ? req.body.password : "";
    if (!crypto.timingSafeEqual(sha256(attempt), passwordDigest)) {
      recordFailure(client, time);
      await sleep(failureDelayMs);
      return sendLoginPage(res, 401, { next, error: "Wrong password." });
    }

    failures.delete(client);
    res.cookie(COOKIE_NAME, createSessionToken(signingKey, time + SESSION_TTL_MS), {
      ...cookieOptions(req),
      maxAge: SESSION_TTL_MS,
    });
    return res.redirect(303, next);
  });

  router.post("/logout", rejectCrossSite, (req, res) => {
    res.clearCookie(COOKIE_NAME, cookieOptions(req));
    res.redirect(303, "/login");
  });

  function requireAuth(req, res, next) {
    if (isAuthenticated(req)) {
      res.set("Cache-Control", "no-store");
      return next();
    }
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Login required." });
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const target = safeNextPath(req.originalUrl);
      return res.redirect(302, target === "/" ? "/login" : `/login?next=${encodeURIComponent(target)}`);
    }
    return res.status(401).type("text").send("Login required.");
  }

  return { router, requireAuth, isAuthenticated, configured };
}

module.exports = { createAuth, COOKIE_NAME, SESSION_TTL_MS };
