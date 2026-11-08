#!/usr/bin/env node
// server.mjs — Resident bridge process.
//
// Responsibilities:
//   * Long-poll getupdates with the persisted get_updates_buf cursor.
//     Every inbound message is appended to inbox.jsonl with exactly:
//     { ts, from_user_id, to_user_id, text, context_token }
//     (text = concatenated TEXT items; a voice item's server-provided
//     transcription is used when present). The peer's latest context_token
//     is also cached (contexts.json) so /send can thread replies.
//   * Serve a local HTTP API on 127.0.0.1:18792 only:
//       GET  /healthz              -> { alive: true }            (no auth)
//       GET  /status               -> login + last poll status   (Bearer)
//       GET  /inbox?since=<ms>     -> inbox records since ts     (Bearer)
//       POST /send {to_user_id, text} -> send via sendmessage     (Bearer)
//     The Bearer token is generated on first run into
//     ~/.config/wechat-bridge/token (0600) and compared in constant time.
//
// Logging never includes bot_token, the API token, or full message text.

import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";

import { getUpdates, sendTextMessage, assertWeixinUrl } from "./ilink.mjs";
import {
  INBOX_PATH,
  STATE_DIR,
  ensureDir,
  loadCredentials,
  loadSyncBuf,
  saveSyncBuf,
  saveContextToken,
  getContextToken,
  loadOrCreateApiToken,
  tailOf,
} from "./state.mjs";

const HOST = "127.0.0.1";
const PORT = 18792;
const STALE_TOKEN_ERRCODE = -14; // official session-guard.ts
const MAX_BODY_BYTES = 64 * 1024;

const state = {
  startedAt: new Date().toISOString(),
  lastPollOkAt: null,
  lastError: null,
  sessionStale: false,
  messagesReceived: 0,
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function logError(msg) {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

ensureDir(STATE_DIR);
const apiToken = loadOrCreateApiToken();

// ---------------------------------------------------------------------------
// Inbound message handling
// ---------------------------------------------------------------------------
function extractText(msg) {
  const parts = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && typeof item.text_item?.text === "string") {
      parts.push(item.text_item.text);
    } else if (item.type === 3 && typeof item.voice_item?.text === "string" && item.voice_item.text) {
      parts.push(item.voice_item.text); // server-side voice transcription
    }
  }
  return parts.join("\n");
}

function recordInbound(msg) {
  const record = {
    ts: Date.now(),
    from_user_id: msg.from_user_id ?? "",
    to_user_id: msg.to_user_id ?? "",
    text: extractText(msg),
    context_token: msg.context_token ?? "",
  };
  fs.appendFileSync(INBOX_PATH, JSON.stringify(record) + "\n", { mode: 0o600 });
  if (record.context_token && record.from_user_id) {
    saveContextToken(record.from_user_id, record.context_token);
  }
  state.messagesReceived++;
}

// ---------------------------------------------------------------------------
// Long-poll loop
// ---------------------------------------------------------------------------
const abortController = new AbortController();
let stopRequested = false;

async function pollLoop() {
  let getUpdatesBuf = loadSyncBuf();
  let consecutiveFailures = 0;
  let nextTimeoutMs = 35_000;

  while (!stopRequested) {
    const creds = loadCredentials();
    if (!creds) {
      // Not logged in yet (or credentials removed): idle and retry.
      state.sessionStale = false;
      await sleep(5000);
      continue;
    }
    try {
      assertWeixinUrl(creds.base_url || "", "stored base_url");
    } catch (err) {
      state.lastError = `stored base_url failed whitelist check: ${err.message}`;
      logError(state.lastError);
      await sleep(30_000);
      continue;
    }
    let resp;
    try {
      resp = await getUpdates({
        baseUrl: creds.base_url,
        token: creds.bot_token,
        getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        signal: abortController.signal,
      });
    } catch (err) {
      if (stopRequested) break;
      consecutiveFailures++;
      state.lastError = `getupdates request failed (${err.name ?? "error"})`;
      logError(`${state.lastError}; consecutive=${consecutiveFailures}`);
      await sleep(consecutiveFailures >= 3 ? 30_000 : 2_000);
      continue;
    }

    if (resp.longpolling_timeout_ms > 0) nextTimeoutMs = resp.longpolling_timeout_ms;

    const isError = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
    if (isError) {
      if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
        // Token/session stale: the official client pauses the session.
        // We back off and flag it; re-login is an operator action.
        state.sessionStale = true;
        state.lastError = "session stale (errcode -14); re-login required";
        logError(state.lastError);
        await sleep(60_000);
        continue;
      }
      consecutiveFailures++;
      state.lastError = `getupdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`;
      logError(`${state.lastError}; consecutive=${consecutiveFailures}`);
      await sleep(consecutiveFailures >= 3 ? 30_000 : 2_000);
      continue;
    }

    consecutiveFailures = 0;
    state.sessionStale = false;
    state.lastError = null;
    state.lastPollOkAt = new Date().toISOString();

    if (typeof resp.get_updates_buf === "string" && resp.get_updates_buf !== getUpdatesBuf) {
      getUpdatesBuf = resp.get_updates_buf;
      saveSyncBuf(getUpdatesBuf);
    }
    for (const msg of resp.msgs ?? []) {
      try {
        recordInbound(msg);
      } catch (err) {
        logError(`failed to record inbound message: ${err.message}`);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    abortController.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// Local HTTP API
// ---------------------------------------------------------------------------
function tokenMatches(req) {
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(apiToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function readInboxSince(sinceMs) {
  let raw;
  try {
    raw = fs.readFileSync(INBOX_PATH, "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (!sinceMs || rec.ts >= sinceMs) out.push(rec);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { alive: true });
    }
    if (!tokenMatches(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (req.method === "GET" && url.pathname === "/status") {
      const creds = loadCredentials();
      return sendJson(res, 200, {
        logged_in: Boolean(creds),
        ilink_bot_id_tail: creds ? tailOf(creds.ilink_bot_id) : null,
        ilink_user_id_tail: creds ? tailOf(creds.ilink_user_id) : null,
        started_at: state.startedAt,
        last_poll_ok_at: state.lastPollOkAt,
        last_error: state.lastError,
        session_stale: state.sessionStale,
        messages_received: state.messagesReceived,
      });
    }
    if (req.method === "GET" && url.pathname === "/inbox") {
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      return sendJson(res, 200, { messages: readInboxSince(since) });
    }
    if (req.method === "POST" && url.pathname === "/send") {
      const creds = loadCredentials();
      if (!creds) return sendJson(res, 409, { error: "not logged in" });
      const body = JSON.parse(await readBody(req));
      const to = typeof body.to_user_id === "string" ? body.to_user_id : "";
      const text = typeof body.text === "string" ? body.text : "";
      if (!to || !text) return sendJson(res, 400, { error: "to_user_id and text are required" });
      const contextToken = getContextToken(to);
      const result = await sendTextMessage({
        baseUrl: creds.base_url,
        token: creds.bot_token,
        toUserId: to,
        text,
        contextToken,
      });
      log(`sent message to ${tailOf(to)} (server message_id ${result.message_id ?? "?"})`);
      return sendJson(res, 200, { ok: true, message_id: result.message_id ?? null, client_id: result.client_id });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    logError(`http handler error: ${err.message}`);
    return sendJson(res, 500, { error: err.message });
  }
});

httpServer.listen(PORT, HOST, () => {
  const creds = loadCredentials();
  log(
    `wechat-bridge listening on http://${HOST}:${PORT} ` +
      `(logged_in=${Boolean(creds)}${creds ? `, bot=${tailOf(creds.ilink_bot_id)}` : ""})`,
  );
});

pollLoop().catch((err) => logError(`poll loop exited: ${err.message}`));

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  stopRequested = true;
  abortController.abort();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
