// state.mjs — Local state layout shared by login.mjs and server.mjs.
//
//   State dir  ~/.local/state/wechat-bridge/            (0700)
//     credentials.json   bot_token + ids + base_url     (0600)
//     sync.json          { get_updates_buf } cursor     (0600)
//     contexts.json      { userId: context_token }      (0600)
//     inbox.jsonl        append-only inbound log
//     qrcode.png         transient, deleted after login (0600)
//     verify-code        transient pairing digits       (0600)
//   Config dir ~/.config/wechat-bridge/                 (0700)
//     token              local HTTP API Bearer token    (0600)
//
// Paths can be overridden for testing with WECHAT_BRIDGE_STATE_DIR /
// WECHAT_BRIDGE_CONFIG_DIR.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const STATE_DIR =
  process.env.WECHAT_BRIDGE_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "wechat-bridge");
export const CONFIG_DIR =
  process.env.WECHAT_BRIDGE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "wechat-bridge");

export const CREDENTIALS_PATH = path.join(STATE_DIR, "credentials.json");
export const SYNC_PATH = path.join(STATE_DIR, "sync.json");
export const CONTEXTS_PATH = path.join(STATE_DIR, "contexts.json");
export const INBOX_PATH = path.join(STATE_DIR, "inbox.jsonl");
export const QRCODE_PATH = path.join(STATE_DIR, "qrcode.png");
export const VERIFY_CODE_PATH = path.join(STATE_DIR, "verify-code");
export const API_TOKEN_PATH = path.join(CONFIG_DIR, "token");

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir mode is masked by umask and ignored for existing dirs; enforce.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
}

export function writeSecretFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

/** Credentials: { bot_token, ilink_bot_id, base_url, ilink_user_id, saved_at } */
export function loadCredentials() {
  const data = readJson(CREDENTIALS_PATH);
  if (!data || typeof data.bot_token !== "string" || !data.bot_token) return undefined;
  return data;
}

export function saveCredentials(creds) {
  writeSecretFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2) + "\n");
}

export function loadSyncBuf() {
  const data = readJson(SYNC_PATH);
  return typeof data?.get_updates_buf === "string" ? data.get_updates_buf : "";
}

export function saveSyncBuf(buf) {
  writeSecretFile(SYNC_PATH, JSON.stringify({ get_updates_buf: buf }));
}

/** Latest context_token per peer user id (from their inbound messages). */
export function loadContexts() {
  return readJson(CONTEXTS_PATH) ?? {};
}

export function saveContextToken(userId, token) {
  if (!userId || !token) return;
  const contexts = loadContexts();
  if (contexts[userId] === token) return;
  contexts[userId] = token;
  writeSecretFile(CONTEXTS_PATH, JSON.stringify(contexts, null, 2) + "\n");
}

export function getContextToken(userId) {
  return loadContexts()[userId];
}

/** Local HTTP API Bearer token; generated on first use. */
export function loadOrCreateApiToken() {
  try {
    const existing = fs.readFileSync(API_TOKEN_PATH, "utf-8").trim();
    if (existing) return existing;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(32).toString("hex");
  writeSecretFile(API_TOKEN_PATH, token + "\n");
  return token;
}

/** Last characters only, for safe display of identifiers. */
export function tailOf(value, n = 4) {
  if (typeof value !== "string" || value.length === 0) return "(none)";
  return `…${value.slice(-n)}`;
}
