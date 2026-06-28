"use strict";

/**
 * Hermes_Station — single-port router on HF Space port 7861.
 *
 * Routes:
 *   /login                -> Hermes_Station login (password = GATEWAY_TOKEN)
 *   /health /status       -> JSON health (unauthenticated — for HF probes)
 *   /hm  /hm/*            -> Hermes_Station status page + app (auth-gated)
 *   /hmd /hmd/*           -> Hermes dashboard passthrough for off-Space
 *                            workspaces (no router auth — dashboard's own
 *                            session token gates writes; opt-in by URL)
 *   /dashboard            -> redirect to /hm
 *   /v1  /v1/*            -> Hermes gateway (bearer auth; HTML => login redirect)
 *   /telegram  /telegram/*-> Telegram webhook (unauthenticated; Telegram needs to reach it)
 *   everything else       -> Hermes WebUI (nesquena/hermes-webui) as the primary UI
 *                           WebUI handles its own login at /login-... no, wait: WebUI
 *                           also exposes /login. We keep Hermes_Station's login at /login
 *                           so the shared GATEWAY_TOKEN gates both.
 *
 * Based on the original HuggingMes project with added WebUI routing as the
 * primary UI.
 */

const http = require("http");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 7861);
const GATEWAY_PORT = Number(process.env.API_SERVER_PORT || 8642);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9119);
const TELEGRAM_WEBHOOK_PORT = Number(process.env.TELEGRAM_WEBHOOK_PORT || 8765);
const WEBUI_PORT = Number(process.env.HERMES_WEBUI_PORT || 8787);
const GATEWAY_HOST = "127.0.0.1";
const startTime = Date.now();
const API_SERVER_KEY = process.env.API_SERVER_KEY || "";
const HM_PREFIX = "/hm";
const HMD_PREFIX = "/hmd";
const LOGIN_PATH = "/hm/login";
const SESSION_COOKIE = "hermes_station_session";
const PRIMARY_UI = (process.env.PRIMARY_UI || "webui").toLowerCase();

const SYNC_STATUS_FILE = "/tmp/hermes_station-sync-status.json";

const internalAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });

/* ── httpProbe ────────────────────────────────────────────────────── */

function httpProbe(port, host = GATEWAY_HOST, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch {}
      resolve(ok);
    };
    const req = http.get(
      { hostname: host, port, path: "/", timeout: timeoutMs },
      (res) => {
        finish(res.statusCode != null);
      },
    );
    req.on("timeout", () => finish(false));
    req.on("error", () => {
      const socket = net.createConnection({ port, host });
      const tcpDone = (ok) => {
        socket.removeAllListeners();
        socket.destroy();
        finish(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => tcpDone(true));
      socket.once("timeout", () => tcpDone(false));
      socket.once("error", () => tcpDone(false));
    });
  });
}

/* ── Auth helpers ─────────────────────────────────────────────────── */

function getBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length, 0));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  if (!API_SERVER_KEY) return true;
  const cookie = String(req.headers.cookie || "");
  const sessionMatch = cookie.match(
    new RegExp(`${SESSION_COOKIE}=([A-Za-z0-9_-]+)`),
  );
  if (sessionMatch && sessionMatch[1]) {
    const sessionToken = decodeURIComponent(sessionMatch[1]);
    if (timingSafeEqualString(sessionToken, API_SERVER_KEY)) {
      return true;
    }
  }
  const bearer = getBearerToken(req);
  if (bearer && timingSafeEqualString(bearer, API_SERVER_KEY)) {
    return true;
  }
  return false;
}

function buildSessionCookie(req) {
  const hostname = String(req.headers.host || "").split(":")[0];
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  const secureAttr = isLocal ? "" : " Secure;";
  const sameSite = isLocal ? "Lax" : "None";
  return `${SESSION_COOKIE}=${encodeURIComponent(API_SERVER_KEY)}; Path=/; HttpOnly;${secureAttr} SameSite=${sameSite}; Max-Age=86400`;
}

function allowedWsOrigin(req) {
  const origin = String(req.headers.origin || "");
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    const allowed = [
      String(req.headers.host || "").split(":")[0],
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
    ];
    if (allowed.includes(hostname)) return true;
    if (
      hostname.endsWith(".hf.space") ||
      hostname.endsWith(".github.dev")
    ) {
      return true;
    }
    const envList = String(process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (envList.includes(hostname)) return true;
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
    return true;
  }
  return false;
}

function sanitizeNext(value, fallback = "/") {
  if (!value || typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value)) return fallback;
  return value;
}

function loginUrl(nextPath) {
  return `${LOGIN_PATH}?next=${encodeURIComponent(sanitizeNext(nextPath))}`;
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/* ── Login page ───────────────────────────────────────────────────── */

function renderLoginPage(nextPath, errorMessage = "") {
  const safeNext = sanitizeNext(nextPath, "/");
  const errorHtml = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hermes_Station — Login</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #e5e7eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 28px; width: 90%; max-width: 380px; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p { color: #9ca3af; margin: 0 0 16px; font-size: .95rem; }
    .error { background: #7f1d1d; color: #fecaca; border: 1px solid #991b1b; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-size: .9rem; }
    label { display: block; font-size: .85rem; color: #9ca3af; margin-bottom: 6px; }
    input[type="password"] { width: 100%; box-sizing: border-box; background: #0b0f19; border: 1px solid #374151; color: #e5e7eb; border-radius: 8px; padding: 10px 12px; font-size: 1rem; outline: none; }
    input[type="password"]:focus { border-color: #60a5fa; }
    button { margin-top: 14px; width: 100%; background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: 10px 0; font-size: 1rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .hint { margin-top: 14px; font-size: .85rem; color: #6b7280; }
    .hint a { color: #93c5fd; }
  </style>
</head>
<body>
  <form class="card" method="post" action="${LOGIN_PATH}">
    <h1>Hermes_Station Admin</h1>
    <p>Enter the <code>GATEWAY_TOKEN</code> from your Space secrets to access the status dashboard.</p>
    <p class="hint">For the Hermes chat UI, go to <a href="/">/</a>.</p>
    ${errorHtml}
    <label for="token">Token</label>
    <input id="token" name="token" type="password" placeholder="GATEWAY_TOKEN" autofocus required>
    <input type="hidden" name="next" value="${escapeHtml(safeNext)}">
    <button type="submit">Log in</button>
  </form>
</body>
</html>`;
}

async function handleLogin(req, res, parsed) {
  const nextPath = sanitizeNext(parsed.searchParams.get("next") || "/", "/");

  if (!API_SERVER_KEY) {
    redirect(res, nextPath);
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderLoginPage(nextPath));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end("Method not allowed");
    return;
  }

  try {
    const body = await readRequestBody(req);
    const params = new URLSearchParams(body);
    const submittedToken = params.get("token") || "";
    const submittedNext = sanitizeNext(params.get("next") || nextPath, "/");

    if (!timingSafeEqualString(submittedToken, API_SERVER_KEY)) {
      res.writeHead(401, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        renderLoginPage(
          submittedNext,
          "That token did not match GATEWAY_TOKEN.",
        ),
      );
      return;
    }

    res.writeHead(302, {
      location: submittedNext,
      "set-cookie": buildSessionCookie(req),
      "cache-control": "no-store",
    });
    res.end();
  } catch (error) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(error.message || "Invalid login request.");
  }
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  const parsed = new URL(req.url, "http://localhost");
  redirect(res, loginUrl(`${parsed.pathname}${parsed.search}`));
  return false;
}

/* ── Upstream proxy ────────────────────────────────────────────────── */

function proxyRequest(
  req,
  res,
  targetPort,
  rewritePath = (path) => path,
  headerOverrides = {},
) {
  const parsed = new URL(req.url, "http://localhost");
  const targetPath = rewritePath(parsed.pathname) + parsed.search;
  const localOrigin = `http://${GATEWAY_HOST}:${targetPort}`;
  const headers = {
    ...req.headers,
    ...headerOverrides,
    host: `${GATEWAY_HOST}:${targetPort}`,
    origin: localOrigin,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
  };

  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
  if (hasBody) {
    const chunks = [];
    let size = 0;
    const limit = 20 * 1024 * 1024;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
        }
      }
    });
    req.on("end", () => {
      delete headers["transfer-encoding"];
      headers["content-length"] = String(size);
      const proxy = http.request(
        {
          hostname: GATEWAY_HOST,
          port: targetPort,
          method: req.method,
          path: targetPath,
          headers,
          agent: internalAgent,
        },
        (upstream) => {
          res.writeHead(upstream.statusCode || 502, upstream.headers);
          upstream.pipe(res);
          upstream.on("error", () => {
            if (!res.headersSent) {
              try {
                res.writeHead(502, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "upstream_error" }));
              } catch {}
            } else {
              try { res.destroy(); } catch {}
            }
          });
        },
      );
      proxy.setTimeout(30000, () => {
        if (!res.headersSent) {
          res.writeHead(504, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "upstream_timeout" }));
        }
        try { proxy.destroy(new Error("upstream_timeout")); } catch {}
      });
      proxy.on("error", (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
        } else {
          try { res.destroy(); } catch {}
        }
      });
      if (size > 0) proxy.write(Buffer.concat(chunks));
      proxy.end();
    });
    req.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
      }
    });
    return;
  }

  const proxy = http.request(
    {
      hostname: GATEWAY_HOST,
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers,
      agent: internalAgent,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
      upstream.on("error", () => {
        if (!res.headersSent) {
          try {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "upstream_error" }));
          } catch {}
        } else {
          try { res.destroy(); } catch {}
        }
      });
    },
  );

  proxy.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_timeout" }));
    }
    try { proxy.destroy(new Error("upstream_timeout")); } catch {}
  });

  proxy.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
    } else {
      try { res.destroy(); } catch {}
    }
  });

  req.pipe(proxy);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, { location });
  res.end();
}

/* ── Dashboard SPA proxy with HTML rewriting ────────────────────────── */
function proxyDashboard(req, res) {
  const parsed = new URL(req.url, "http://localhost");
  const inner = parsed.pathname.replace(`${HM_PREFIX}/app`, "") || "/";

  const isAssetLike =
    inner.startsWith("/assets/") ||
    inner.startsWith("/api/") ||
    inner.startsWith("/dashboard-plugins/") ||
    inner.startsWith("/ds-assets/") ||
    /\.[a-z0-9]{1,6}$/i.test(inner);

  const targetPath =
    (isAssetLike || inner === "/" ? inner : "/") + parsed.search;

  const headers = {
    ...req.headers,
    host: `${GATEWAY_HOST}:${DASHBOARD_PORT}`,
    origin: `http://${GATEWAY_HOST}:${DASHBOARD_PORT}`,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
    "accept-encoding": "identity",
  };

  const upstream = http.request(
    {
      hostname: GATEWAY_HOST,
      port: DASHBOARD_PORT,
      method: req.method,
      path: targetPath,
      headers,
      agent: internalAgent,
    },
    (upRes) => {
      const contentType = String(upRes.headers["content-type"] || "");
      const shouldRewrite =
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml");

      if (!shouldRewrite) {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
        upRes.on("error", () => {
          if (!res.headersSent) {
            try {
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "upstream_error" }));
            } catch {}
          } else {
            try { res.destroy(); } catch {}
          }
        });
        return;
      }

      const chunks = [];
      upRes.on("data", (chunk) => chunks.push(chunk));
      upRes.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");

        body = body.replace(
          /window\.__HERMES_BASE_PATH__\s*=\s*"[^"]*"/g,
          `window.__HERMES_BASE_PATH__="${HM_PREFIX}/app"`,
        );

        const prefix = `${HM_PREFIX}/app`;
        body = body.replace(
          /\b(src|href)="\/(?!\/)http([^"]*)"/g,
          (match, attr, rest) => {
            if (
              ("/" + rest).startsWith(prefix + "/") ||
              "/" + rest === prefix
            ) {
              return match;
            }
            return `${attr}="${prefix}/${rest}"`;
          },
        );

        const buf = Buffer.from(body, "utf8");
        const outHeaders = { ...upRes.headers };
        delete outHeaders["content-length"];
        delete outHeaders["transfer-encoding"];
        delete outHeaders["content-encoding"];
        outHeaders["content-length"] = String(buf.length);

        res.writeHead(upRes.statusCode || 502, outHeaders);
        res.end(buf);
      });
      upRes.on("error", () => {
        if (!res.headersSent) {
          try {
            res.writeHead(502);
            res.end();
          } catch {}
        } else {
          try { res.destroy(); } catch {}
        }
      });
    },
  );

  upstream.setTimeout(30000, () => {
    if (!res.headersSent) {
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream_timeout" }));
    }
    try { upstream.destroy(new Error("upstream_timeout")); } catch {}
  });

  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
    } else {
      try { res.destroy(); } catch {}
    }
  });

  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH";
  if (hasBody) {
    const bodyChunks = [];
    let bodySize = 0;
    const bodyLimit = 20 * 1024 * 1024;
    req.on("data", (chunk) => {
      bodyChunks.push(chunk);
      bodySize += chunk.length;
      if (bodySize > bodyLimit) {
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
        }
      }
    });
    req.on("end", () => {
      delete headers["transfer-encoding"];
      headers["content-length"] = String(bodySize);
      upstream.end(Buffer.concat(bodyChunks));
    });
    req.on("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
      }
    });
  } else {
    req.pipe(upstream);
  }
}

/* ── Status JSON + Hermes_Station status page ─────────────────────────── */

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

let _statusCache = null;
let _statusCacheAt = 0;
const STATUS_CACHE_TTL_MS = 1500;

async function readJsonAsync(path, fallback = null) {
  try {
    const content = await fs.promises.readFile(path, "utf8");
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function statusPayload() {
  const now = Date.now();
  if (_statusCache && now - _statusCacheAt < STATUS_CACHE_TTL_MS) {
    return _statusCache;
  }
  const hasTelegramWebhook = !!process.env.TELEGRAM_WEBHOOK_URL;
  const [gateway, dashboard, webui, telegramWebhook] = await Promise.all([
    httpProbe(GATEWAY_PORT),
    httpProbe(DASHBOARD_PORT),
    httpProbe(WEBUI_PORT),
    hasTelegramWebhook ? httpProbe(TELEGRAM_WEBHOOK_PORT) : Promise.resolve(false),
  ]);
  const sync = await readJsonAsync(
    SYNC_STATUS_FILE,
    process.env.HF_TOKEN
      ? { status: "configured", message: "Backup enabled; waiting for first sync." }
      : { status: "disabled", message: "HF_TOKEN is not configured." },
  );

  const payload = {
    ok: gateway && webui,
    uptime: formatUptime(Date.now() - startTime),
    startedAt: new Date(startTime).toISOString(),
    gateway,
    dashboard,
    webui,
    authConfigured: !!API_SERVER_KEY,
    primaryUi: PRIMARY_UI,
    ports: {
      public: PORT,
      gateway: GATEWAY_PORT,
      dashboard: DASHBOARD_PORT,
      webui: WEBUI_PORT,
      telegramWebhook: TELEGRAM_WEBHOOK_PORT,
    },
    telegram: {
      configured: !!process.env.TELEGRAM_BOT_TOKEN,
      webhook: !!process.env.TELEGRAM_WEBHOOK_URL,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || "",
      webhookListening: telegramWebhook,
    },
    model:
      process.env.MODEL_FOR_CONFIG ||
      process.env.HERMES_MODEL ||
      process.env.LLM_MODEL ||
      "",
    provider:
      process.env.PROVIDER_FOR_CONFIG ||
      process.env.HERMES_INFERENCE_PROVIDER ||
      "auto",
    backup: sync,
    dashboardSessionToken: process.env.HERMES_DASHBOARD_SESSION_TOKEN || "",
  };
  _statusCache = payload;
  _statusCacheAt = now;
  return payload;
}

function toneBadge(label, tone = "neutral") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function valueOrUnset(value, fallback = "Not set") {
  return value
    ? escapeHtml(value)
    : `<span class="muted">${escapeHtml(fallback)}</span>`;
}

function renderTile({ title, value, detail = "", tone = "neutral", meta = "" }) {
  return `<div class="tile ${tone}">
  <div class="tile-title">${escapeHtml(title)}</div>
  <div class="tile-value">${value}</div>
  ${detail ? `<div class="tile-detail">${detail}</div>` : ""}
  ${meta ? `<div class="tile-meta">${meta}</div>` : ""}
</div>`;
}

function renderStatusPage(data) {
  const syncStatus = String(data.backup?.status || "unknown");
  const syncTone = ["success", "restored", "synced", "configured"].includes(syncStatus)
    ? "ok"
    : syncStatus === "disabled"
      ? "warn"
      : "neutral";
  const telegramTone = data.telegram.configured
    ? data.telegram.webhookListening || !data.telegram.webhook
      ? "ok"
      : "warn"
    : "warn";
  const telegramDetail = data.telegram.configured
    ? `${data.telegram.webhook ? "Webhook" : "Polling"}`
    : "Not configured";
  const backupDetail = data.backup?.message
    ? escapeHtml(data.backup.message)
    : "No status yet";
  const backupWarning = data.backup?.warning?.message
    ? `<div class="tile-warning">${escapeHtml(data.backup.warning.message)}</div>`
    : "";

  const tiles = [
    renderTile({
      title: "WebUI",
      value: toneBadge(data.webui ? "Online" : "Offline", data.webui ? "ok" : "off"),
      detail: data.webui ? `Port ${data.ports.webui}` : "Unreachable",
      tone: data.webui ? "ok" : "off",
    }),
    renderTile({
      title: "Gateway",
      value: toneBadge(data.gateway ? "Online" : "Offline", data.gateway ? "ok" : "off"),
      detail: data.gateway ? `API on port ${data.ports.gateway}` : "Unreachable",
      tone: data.gateway ? "ok" : "off",
      meta: data.authConfigured ? "Protected" : "Unprotected",
    }),
    renderTile({
      title: "Model",
      value: `<code>${valueOrUnset(data.model)}</code>`,
      detail: `Provider: ${valueOrUnset(data.provider || "auto")}`,
      tone: data.model ? "ok" : "warn",
    }),
    renderTile({
      title: "Desktop App",
      value: data.dashboardSessionToken
        ? toneBadge("Ready", "ok")
        : toneBadge("No token", "warn"),
      detail: data.dashboardSessionToken
        ? `<a href="${HM_PREFIX}/desktop-app-setup">Setup guide</a> · token: <code>${escapeHtml(data.dashboardSessionToken.slice(0, 8))}…</code>`
        : "HERMES_DASHBOARD_SESSION_TOKEN not set",
      tone: data.dashboardSessionToken ? "ok" : "warn",
    }),
    renderTile({
      title: "Runtime",
      value: escapeHtml(data.uptime),
      detail: `Port ${data.ports.public}`,
      tone: "neutral",
    }),
    renderTile({
      title: "Telegram",
      value: toneBadge(data.telegram.configured ? "Configured" : "Disabled", telegramTone),
      detail: telegramDetail,
      tone: telegramTone,
    }),
    renderTile({
      title: "Backup",
      value: toneBadge(syncStatus.toUpperCase(), data.backup?.warning ? "warn" : syncTone),
      detail: backupDetail + backupWarning,
      tone: data.backup?.warning ? "warn" : syncTone,
      meta: data.backup?.timestamp
        ? `<span class="local-time" data-iso="${escapeHtml(data.backup.timestamp)}"></span>`
        : "",
    }),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hermes_Station</title>
  <style>
    :root { --bg:#0b0f19; --card:#111827; --border:#1f2937; --text:#e5e7eb; --muted:#9ca3af; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
    .container { max-width: 960px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 1.5rem; margin: 0 0 6px; }
    .subtitle { color: var(--muted); margin: 0 0 18px; font-size: .95rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
    .tile { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .tile-title { font-size: .8rem; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; }
    .tile-value { font-size: 1.1rem; font-weight: 600; margin-bottom: 6px; }
    .tile-detail { font-size: .85rem; color: var(--muted); }
    .tile-meta { font-size: .75rem; color: #6b7280; margin-top: 6px; }
    .tile-warning { background: #451a03; color: #fdba74; border: 1px solid #78350f; border-radius: 6px; padding: 8px 10px; margin-top: 8px; font-size: .85rem; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .8rem; font-weight: 600; }
    .badge.ok { background: #064e3b; color: #6ee7b7; }
    .badge.warn { background: #451a03; color: #fdba74; }
    .badge.neutral { background: #1f2937; color: #d1d5db; }
    .badge.off { background: #7f1d1d; color: #fecaca; }
    .muted { color: var(--muted); }
    code { background: #1f2937; padding: 1px 4px; border-radius: 4px; font-size: .9em; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚉 Hermes_Station</h1>
    <p class="subtitle">Self-hosted Hermes Agent on HF Spaces</p>
    <div class="grid">
      ${tiles}
    </div>
  </div>
  <script>
    document.querySelectorAll('.local-time').forEach(el => {
      const iso = el.getAttribute('data-iso');
      if (iso) {
        const d = new Date(iso);
        el.textContent = d.toLocaleString();
      }
    });
  </script>
</body>
</html>`;
}

/* ── Server ─────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  if (path === LOGIN_PATH) {
    await handleLogin(req, res, parsed);
    return;
  }

  if (path === "/health") {
    const data = await statusPayload();
    res.writeHead(data.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: data.ok,
        gateway: data.gateway,
        webui: data.webui,
        uptime: data.uptime,
      }),
    );
    return;
  }

  if (path === "/status" || path === "/api/status") {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (path === "/telegram" || path.startsWith("/telegram/")) {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "telegram_not_configured" }));
      return;
    }
    proxyRequest(req, res, TELEGRAM_WEBHOOK_PORT);
    return;
  }

  if (path === "/v1" || path.startsWith("/v1/")) {
    if (!isAuthorized(req)) {
      if (wantsHtml(req)) {
        redirect(res, loginUrl(`${path}${parsed.search}`));
        return;
      }
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          error: "unauthorized",
          message: "Use Authorization: Bearer <GATEWAY_TOKEN>.",
        }),
      );
      return;
    }
    const upstreamHeaders =
      getBearerToken(req) || !API_SERVER_KEY
        ? {}
        : { authorization: `Bearer ${API_SERVER_KEY}` };
    proxyRequest(req, res, GATEWAY_PORT, (p) => p, upstreamHeaders);
    return;
  }

  if (path === HM_PREFIX || path === `${HM_PREFIX}/`) {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStatusPage(data));
    return;
  }

  if (path === HMD_PREFIX || path.startsWith(`${HMD_PREFIX}/`)) {
    proxyRequest(req, res, DASHBOARD_PORT, (p) => p.replace(HMD_PREFIX, "") || "/");
    return;
  }

  if (path === `${HM_PREFIX}/app` || path.startsWith(`${HM_PREFIX}/app/`)) {
    if (!requireAuth(req, res)) return;
    proxyDashboard(req, res);
    return;
  }

  if (path === `${HM_PREFIX}/status`) {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (path === `${HM_PREFIX}/desktop-app-setup`) {
    if (!requireAuth(req, res)) return;
    const token = process.env.HERMES_DASHBOARD_SESSION_TOKEN || "";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const baseUrl = host ? `https://${host}` : "";
    const remoteUrl = `${baseUrl}${HMD_PREFIX}`;
    if (wantsHtml(req)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Desktop App Setup</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #e5e7eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 28px; width: 90%; max-width: 520px; }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p { color: #9ca3af; margin: 0 0 16px; font-size: .95rem; }
    label { display: block; font-size: .85rem; color: #9ca3af; margin: 16px 0 6px; }
    .field { background: #0b0f19; border: 1px solid #374151; color: #e5e7eb; border-radius: 8px; padding: 10px 12px; font-size: .95rem; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; word-break: break-all; }
    ol { color: #d1d5db; padding-left: 20px; }
    li { margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hermes Desktop App — Remote Setup</h1>
    <p>Configure once. These values persist across Space restarts (the session token is saved to the backed-up state volume).</p>
    <label>Remote Gateway URL</label>
    <div class="field">${escapeHtml(remoteUrl)}</div>
    <label>Session Token</label>
    <div class="field">${escapeHtml(token)}</div>
    <ol>
      <li>Open the Hermes desktop app</li>
      <li>Settings → Gateway → Remote gateway</li>
      <li>URL: paste the Remote Gateway URL above</li>
      <li>Session token: paste the token above</li>
      <li>Connect — it should stay connected across restarts</li>
    </ol>
    <p>In the desktop app: chat, model picker, and settings work remotely. File browser and terminal panel show your local PC (upstream desktop app limitation). For remote files/terminal, use the WebUI at /.</p>
  </div>
</body>
</html>`);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        remoteGatewayUrl: remoteUrl,
        sessionToken: token,
        note: "Configure once in the desktop app: Settings → Gateway → Remote gateway. Persists across restarts.",
      }, null, 2));
    }
    return;
  }

  if (path === `${HM_PREFIX}/logs` || path.startsWith(`${HM_PREFIX}/logs/`)) {
    if (!requireAuth(req, res)) return;
    const logDir = `${process.env.HERMES_HOME || "/opt/data"}/logs`;
    const logFiles = ["dashboard.log", "gateway.log", "webui.log"];
    if (path.startsWith(`${HM_PREFIX}/logs/`)) {
      const name = path.slice(`${HM_PREFIX}/logs/`.length);
      if (!logFiles.includes(name)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      try {
        let tail = Number(parsed.searchParams.get("tail") || 200);
        if (!Number.isFinite(tail) || tail < 0) tail = 200;
        if (tail > 10000) tail = 10000;
        const filePath = `${logDir}/${name}`;
        const stat = fs.statSync(filePath);
        if (stat.size > 50 * 1024 * 1024) {
          res.writeHead(413, { "content-type": "text/plain" });
          res.end(`Log file ${name} is ${(stat.size / 1024 / 1024).toFixed(1)} MB — too large to serve in-browser. SSH in or rotate the log first.`);
          return;
        }
        const content = await fs.promises.readFile(filePath, "utf8");
        const lines = content.split("\n");
        const sliced = lines.slice(-tail);
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(sliced.join("\n"));
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`Log file ${name} not found`);
      }
      return;
    }
    const links = logFiles.map((f) => {
      const size = (() => { try { return fs.statSync(`${logDir}/${f}`).size; } catch { return 0; } })();
      return `<li><a href="${HM_PREFIX}/logs/${f}?tail=200">${escapeHtml(f)}</a> (${(size / 1024).toFixed(1)} KB)</li>`;
    }).join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Hermes_Station Logs</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #e5e7eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 28px; width: 90%; max-width: 520px; }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p { color: #9ca3af; margin: 0 0 16px; font-size: .95rem; }
    li { margin-bottom: 8px; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Service Logs</h1>
    <p>Append <code>?tail=N</code> to limit lines (default 200, max 10000).</p>
    <ul>${links}</ul>
  </div>
</body>
</html>`);
    return;
  }

  if (path === `${HM_PREFIX}/debug/model-options`) {
    if (!requireAuth(req, res)) return;
    const localHost = `${GATEWAY_HOST}:${DASHBOARD_PORT}`;
    const localOrigin = `http://${localHost}`;
    const rootReq = http.request(
      { hostname: GATEWAY_HOST, port: DASHBOARD_PORT, method: "GET", path: "/", headers: { host: localHost, origin: localOrigin }, agent: internalAgent },
      (rootRes) => {
        const chunks = [];
        rootRes.on("data", (c) => chunks.push(c));
        rootRes.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8");
          const m = html.match(/__HERMES_SESSION_TOKEN__\s*[=:]\s*["']([A-Za-z0-9_\-]+)["']/)
            || html.match(/session[_-]?token\s*[=:]\s*["']([A-Za-z0-9_\-]+)["']/i);
          const token = m ? m[1] : "";
          if (!token) {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end(`Could not extract session token from dashboard HTML.\n\nHTML preview (first 500 chars):\n${html.slice(0, 500)}`);
            return;
          }
          const apiReq = http.request(
            { hostname: GATEWAY_HOST, port: DASHBOARD_PORT, method: "GET", path: "/api/model/options", headers: { host: localHost, origin: localOrigin, "x-hermes-session-token": token }, agent: internalAgent },
            (apiRes) => {
              const bodyChunks = [];
              apiRes.on("data", (c) => bodyChunks.push(c));
              apiRes.on("end", () => {
                const body = Buffer.concat(bodyChunks).toString("utf8");
                res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
                res.end(`Token: ${token.slice(0, 8)}...\nStatus: ${apiRes.statusCode}\nHeaders: ${JSON.stringify(apiRes.headers, null, 2)}\n\n${body}`);
              });
              apiRes.on("error", (e) => {
                res.writeHead(502, { "content-type": "text/plain" });
                res.end(`API probe error: ${e.message}`);
              });
            },
          );
          apiReq.on("error", (e) => {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end(`API connection error: ${e.message}`);
          });
          apiReq.end();
        });
        rootRes.on("error", (e) => {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`Dashboard root error: ${e.message}`);
        });
      },
    );
    rootReq.on("error", (e) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Dashboard connection error: ${e.message}`);
    });
    rootReq.end();
    return;
  }

  if (path === `${HM_PREFIX}/debug/model-options-trace`) {
    if (!requireAuth(req, res)) return;
    const { execFile } = require("child_process");
    const pyCode = `
import os, sys, traceback
os.environ.setdefault("HERMES_HOME", "/opt/data")
sys.path.insert(0, "/opt/hermes")
sys.path.insert(0, "/opt/hermes/.venv/lib/python3.12/site-packages")
try:
  from hermes_cli.inventory import build_models_payload, load_picker_context
  ctx = load_picker_context()
  print("=== load_picker_context OK ===")
  print("  current_model:", repr(ctx.current_model))
  print("  current_provider:", repr(ctx.current_provider))
  print("  current_base_url:", repr(ctx.current_base_url))
  print("  user_providers:", type(ctx.user_providers).__name__, list(ctx.user_providers.keys()) if isinstance(ctx.user_providers, dict) else "")
  print("  custom_providers:", type(ctx.custom_providers).__name__, list(ctx.custom_providers.keys()) if isinstance(ctx.custom_providers, dict) else "")
except Exception:
  print("=== load_picker_context FAILED ===")
  traceback.print_exc()
  sys.exit(0)
try:
  result = build_models_payload(ctx, max_models=50, include_unconfigured=True, picker_hints=True, canonical_order=True, pricing=True, capabilities=True)
  print("=== build_models_payload OK ===")
  print("  providers count:", len(result.get("providers", [])))
  print("  model:", repr(result.get("model")))
  print("  provider:", repr(result.get("provider")))
except Exception:
  print("=== build_models_payload FAILED ===")
  traceback.print_exc()
`;
    execFile("/opt/hermes/.venv/bin/python", ["-c", pyCode], { timeout: 30000 }, (err, stdout, stderr) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(`--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n--- exit ---\n${err ? err.message : "0"}`);
    });
    return;
  }

  if (path === "/dashboard" || path === "/dashboard/") {
    redirect(res, `${HM_PREFIX}${parsed.search}`);
    return;
  }

  const dashboardRootRoutes = new Set([
    "/config",
    "/env",
    "/models",
    "/providers",
    "/profiles",
    "/sessions",
    "/skills",
    "/cron",
    "/analytics",
    "/logs",
    "/plugins",
    "/chat",
    "/docs",
  ]);
  if (dashboardRootRoutes.has(path) || [...dashboardRootRoutes].some((r) => path.startsWith(r + "/"))) {
    redirect(res, `${HM_PREFIX}/app${path}${parsed.search}`);
    return;
  }

  const refererPath = (() => {
    const ref = String(req.headers.referer || "");
    if (!ref) return "";
    try {
      return new URL(ref).pathname;
    } catch {
      return "";
    }
  })();
  const refererIsDashboard = refererPath.startsWith(`${HM_PREFIX}/app`);

  if (refererIsDashboard) {
    if (!path.startsWith("/webui")) {
      if (!requireAuth(req, res)) return;
      const parsed2 = new URL(req.url, "http://localhost");
      const looksLikeAsset =
        path.startsWith("/assets/") ||
        path.startsWith("/ds-assets/") ||
        path.startsWith("/dashboard-plugins/") ||
        path.startsWith("/api/") ||
        path === "/favicon.ico" ||
        /\.[a-z0-9]{1,6}$/i.test(path);
      if (looksLikeAsset) {
        proxyRequest(req, res, DASHBOARD_PORT);
      } else {
        proxyDashboard(req, res);
      }
      return;
    }
  }

  if (
    /^\/api\/sessions\/[^/]+\/chat\/stream\/?$/.test(path) &&
    !refererIsDashboard
  ) {
    res.writeHead(404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(
      JSON.stringify({
        error: "not_found",
        message:
          "Legacy enhanced-fork chat stream is not exposed by this Space. Use /v1/chat/completions.",
      }),
    );
    return;
  }

  if (PRIMARY_UI === "dashboard" && path === "/") {
    if (!requireAuth(req, res)) return;
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderStatusPage(data));
    return;
  }

  proxyRequest(req, res, WEBUI_PORT);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Hermes_Station router listening on 0.0.0.0:${PORT}`);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException in router (continuing):", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection in router (continuing):", err);
});
server.on("error", (err) => {
  console.error("router server error:", err && err.stack ? err.stack : err);
});

server.on("upgrade", (req, clientSocket, head) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  const needsAuth =
    path === "/v1" ||
    path.startsWith("/v1/") ||
    path === HM_PREFIX ||
    path.startsWith(`${HM_PREFIX}/`) ||
    path === `${HM_PREFIX}/app` ||
    path.startsWith(`${HM_PREFIX}/app/`);
  if (needsAuth && !isAuthorized(req)) {
    try {
      clientSocket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    } catch {
      try { clientSocket.destroy(); } catch {}
    }
    return;
  }
  if (!allowedWsOrigin(req)) {
    try {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    } catch {
      try { clientSocket.destroy(); } catch {}
    }
    return;
  }

  let targetPort = WEBUI_PORT;
  let targetPath = req.url;

  const refererPath = (() => {
    const ref = String(req.headers.referer || "");
    if (!ref) return "";
    try {
      return new URL(ref).pathname;
    } catch {
      return "";
    }
  })();
  const refererIsDashboard = refererPath.startsWith(`${HM_PREFIX}/app`);

  let rewriteLocalOrigin = true;

  if (path === "/v1" || path.startsWith("/v1/")) {
    targetPort = GATEWAY_PORT;
  } else if (path === HMD_PREFIX || path.startsWith(`${HMD_PREFIX}/`)) {
    targetPort = DASHBOARD_PORT;
    targetPath = path.replace(HMD_PREFIX, "") || "/";
    if (parsed.search) targetPath += parsed.search;
    rewriteLocalOrigin = false;
  } else if (path === `${HM_PREFIX}/app` || path.startsWith(`${HM_PREFIX}/app/`)) {
    targetPort = DASHBOARD_PORT;
    targetPath = path.replace(`${HM_PREFIX}/app`, "") || "/";
    if (parsed.search) targetPath += parsed.search;
  } else if (refererIsDashboard && !path.startsWith("/webui")) {
    targetPort = DASHBOARD_PORT;
  } else if (path.startsWith("/webui/") || path === "/webui") {
    targetPort = WEBUI_PORT;
    targetPath = path.replace(/^\/webui/, "") || "/";
    if (parsed.search) targetPath += parsed.search;
  }

  const upstream = net.createConnection(targetPort, GATEWAY_HOST, () => {
    const localHost = `${GATEWAY_HOST}:${targetPort}`;
    const headerLines = [
      `${req.method} ${targetPath} HTTP/1.1`,
    ];
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (lower === "host") {
        headerLines.push(`Host: ${localHost}`);
        continue;
      }
      if (lower === "origin") {
        if (rewriteLocalOrigin) {
          headerLines.push(`Origin: http://${localHost}`);
        } else {
          headerLines.push(`Origin: ${value}`);
        }
        continue;
      }
      if (Array.isArray(value)) {
        for (const v of value) headerLines.push(`${name}: ${v}`);
      } else {
        headerLines.push(`${name}: ${value}`);
      }
    }
    headerLines.push("", "");
    upstream.write(headerLines.join("\r\n"));
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on("error", () => {
    try {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    } catch {}
  });
  clientSocket.on("error", () => {
    try {
      upstream.destroy();
    } catch {}
  });
});
