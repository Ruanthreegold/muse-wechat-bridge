// ilink.mjs — Minimal client for Tencent's official iLink Bot protocol.
//
// Protocol facts are taken from the official npm package
// `@tencent-weixin/openclaw-weixin@2.4.10` (Tencent) TypeScript sources:
//   - src/api/api.ts       endpoints, headers, base_info, timeouts
//   - src/api/types.ts     message / getupdates wire shapes
//   - src/auth/login-qr.ts QR login flow, statuses, bot_type default
//   - src/auth/accounts.ts DEFAULT_BASE_URL fallback
//   - src/messaging/send.ts outbound text message construction
//   - src/messaging/inbound.ts context_token semantics
//
// Hard security rules enforced here:
//   * Outbound requests go ONLY to https URLs whose host is weixin.qq.com or
//     *.weixin.qq.com on port 443. The login-provided base_url and any
//     redirect_host must pass the same check before use.
//   * Redirects are never followed automatically (fetch redirect: "manual");
//     any 3xx response is an error.
//   * bot_token is never logged.

import crypto from "node:crypto";

/** Fixed entry host for QR login (official: login-qr.ts FIXED_BASE_URL). */
export const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";

/** package.json `ilink_appid` of the official package (api.ts: ILINK_APP_ID). */
export const ILINK_APP_ID = "bot";

/**
 * Our own client version. Sent as `channel_version` in base_info, and encoded
 * into the iLink-App-ClientVersion header the same way the official client
 * does (major<<16 | minor<<8 | patch). Deliberately NOT copied from the
 * official package's version: whether the server enforces a minimum client
 * version is unknown (see README "存疑点"). Override with env
 * WECHAT_BRIDGE_CHANNEL_VERSION if interop requires it.
 */
export const CHANNEL_VERSION = process.env.WECHAT_BRIDGE_CHANNEL_VERSION ?? "0.1.0";

/** base_info.bot_agent (UA-style); official default is "OpenClaw". */
export const BOT_AGENT = `WechatBridge/${CHANNEL_VERSION}`;

/** Default bot_type for get_bot_qrcode (login-qr.ts DEFAULT_ILINK_BOT_TYPE). */
export const DEFAULT_BOT_TYPE = "3";

function buildClientVersion(version) {
  const parts = version.split(".").map((p) => parseInt(p, 10) || 0);
  return (((parts[0] ?? 0) & 0xff) << 16) | (((parts[1] ?? 0) & 0xff) << 8) | ((parts[2] ?? 0) & 0xff);
}
export const ILINK_APP_CLIENT_VERSION = String(buildClientVersion(CHANNEL_VERSION));

export const LONG_POLL_TIMEOUT_MS = 35_000;
export const API_TIMEOUT_MS = 15_000;

/** base_info attached to every POST body (api.ts buildBaseInfo). */
export function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
}

// ---------------------------------------------------------------------------
// URL whitelist guard
// ---------------------------------------------------------------------------
export function isWeixinHost(hostname) {
  const host = String(hostname).toLowerCase();
  return host === "weixin.qq.com" || host.endsWith(".weixin.qq.com");
}

/** Validate a URL string against the egress whitelist; returns URL or throws. */
export function assertWeixinUrl(urlStr, label = "url") {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`${label}: invalid URL (refused)`);
  }
  if (u.protocol !== "https:") throw new Error(`${label}: only https is allowed (refused)`);
  if (!isWeixinHost(u.hostname)) throw new Error(`${label}: host outside weixin.qq.com whitelist (refused)`);
  if (u.port && u.port !== "443") throw new Error(`${label}: only port 443 is allowed (refused)`);
  if (u.username || u.password) throw new Error(`${label}: URL credentials not allowed (refused)`);
  return u;
}

/** Build a request URL from a (validated) base URL + endpoint, then re-validate. */
function buildUrl(baseUrl, endpoint) {
  const base = assertWeixinUrl(baseUrl, "baseUrl");
  const baseWithSlash = base.href.endsWith("/") ? base.href : `${base.href}/`;
  const url = new URL(endpoint, baseWithSlash);
  return assertWeixinUrl(url.href, "request url");
}

// ---------------------------------------------------------------------------
// Headers (api.ts buildHeaders / buildCommonHeaders)
// ---------------------------------------------------------------------------
/** X-WECHAT-UIN: random uint32 -> decimal string -> base64 (api.ts). */
function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function commonHeaders() {
  const headers = {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
  const routeTag = process.env.WECHAT_BRIDGE_ROUTE_TAG;
  if (routeTag) headers.SKRouteTag = routeTag;
  return headers;
}

function postHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

// ---------------------------------------------------------------------------
// JSON parsing with lossless uint64 message-id handling.
// message_id / msg_id / svr_id can exceed Number.MAX_SAFE_INTEGER; quote bare
// numeric values for these keys before JSON.parse (same approach as the
// official parseWeixinApiJson in api.ts).
// ---------------------------------------------------------------------------
const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);
export function parseApiJson(rawText) {
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }
    const stringStart = index;
    index++;
    let escaped = false;
    while (index < rawText.length) {
      const ch = rawText[index++];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') break;
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;
    let cursor = index;
    while (cursor < rawText.length && /\s/.test(rawText[cursor])) cursor++;
    if (rawText[cursor] !== ":") continue;
    let key;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;
    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (cursor < rawText.length && /\s/.test(rawText[cursor])) output += rawText[cursor++];
    const numStart = cursor;
    if (rawText[cursor] === "-") cursor++;
    while (cursor < rawText.length && /\d/.test(rawText[cursor])) cursor++;
    if (cursor > numStart && !(cursor === numStart + 1 && rawText[numStart] === "-")) {
      output += `"${rawText.slice(numStart, cursor)}"`;
      index = cursor;
    } else {
      index = numStart;
    }
  }
  return JSON.parse(output);
}

// ---------------------------------------------------------------------------
// Fetch wrappers — whitelist-checked, redirects never followed
// ---------------------------------------------------------------------------
async function doFetch(url, { method, headers, body, timeoutMs, signal }) {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const onExternalAbort = () => controller?.abort();
  if (signal && controller) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(url.href, {
      method,
      headers,
      body,
      redirect: "manual",
      ...(controller ? { signal: controller.signal } : signal ? { signal } : {}),
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`HTTP ${res.status} redirect refused (redirects are never followed)`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && controller) signal.removeEventListener("abort", onExternalAbort);
  }
}

/** GET with only the common headers (matches official apiGetFetch usage). */
export async function apiGet({ baseUrl, endpoint, timeoutMs }) {
  const url = buildUrl(baseUrl, endpoint);
  return doFetch(url, { method: "GET", headers: commonHeaders(), timeoutMs });
}

/** POST JSON with the full header set (matches official apiPostFetch). */
export async function apiPost({ baseUrl, endpoint, bodyObj, token, timeoutMs, signal }) {
  const url = buildUrl(baseUrl, endpoint);
  return doFetch(url, {
    method: "POST",
    headers: postHeaders(token),
    body: JSON.stringify(bodyObj),
    timeoutMs,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Protocol operations
// ---------------------------------------------------------------------------

/**
 * Step 1 of QR login: POST ilink/bot/get_bot_qrcode?bot_type=<t>
 * Body: { local_token_list: string[] } — tokens of already-known accounts so
 * the server can answer binded_redirect for an already-bound bot.
 * Returns { qrcode, qrcode_img_content } where qrcode_img_content is the URL
 * string encoded in the QR image. (login-qr.ts fetchQRCode)
 */
export async function fetchBotQrCode({ botType = DEFAULT_BOT_TYPE, localTokenList = [] } = {}) {
  const raw = await apiPost({
    baseUrl: FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    bodyObj: { local_token_list: localTokenList },
    timeoutMs: API_TIMEOUT_MS,
  });
  return JSON.parse(raw);
}

/**
 * Step 2 of QR login: GET ilink/bot/get_qrcode_status?qrcode=<id>[&verify_code=<code>]
 * Long-poll (35 s). Client timeout or transient network error is reported as
 * { status: "wait" } so callers simply continue polling (official behavior).
 * Possible statuses: wait | scaned | confirmed | expired |
 *   scaned_but_redirect (see redirect_host) | need_verifycode |
 *   verify_code_blocked | binded_redirect.
 * On confirmed: { bot_token, ilink_bot_id, baseurl, ilink_user_id }.
 */
export async function pollQrStatus({ baseUrl = FIXED_BASE_URL, qrcode, verifyCode }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    const raw = await apiGet({ baseUrl, endpoint, timeoutMs: LONG_POLL_TIMEOUT_MS });
    return JSON.parse(raw);
  } catch {
    return { status: "wait" };
  }
}

/**
 * Long-poll for messages: POST ilink/bot/getupdates
 * Body: { get_updates_buf, base_info }. The response's get_updates_buf is the
 * opaque cursor to persist and send back on the next call; the server may
 * suggest the next timeout via longpolling_timeout_ms.
 * Client-side timeout returns an empty success so the caller retries.
 * errcode -14 means the token/session is stale (session-guard.ts).
 */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = "", timeoutMs = LONG_POLL_TIMEOUT_MS, signal }) {
  try {
    const raw = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      bodyObj: { get_updates_buf: getUpdatesBuf, base_info: buildBaseInfo() },
      token,
      timeoutMs,
      signal,
    });
    return parseApiJson(raw);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && !signal?.aborted) {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/**
 * Send one text message: POST ilink/bot/sendmessage
 * Body: { msg: {...}, base_info }. The msg mirrors messaging/send.ts:
 * message_type=2 (BOT), message_state=2 (FINISH), a single TEXT item, a fresh
 * client_id, and context_token copied from the peer's latest inbound message
 * (issued per-message by getupdates; see inbound.ts). context_token may be
 * omitted, but the official sender warns when it is missing.
 * Returns the parsed response ({ message_id, ret, errmsg }).
 */
export async function sendTextMessage({ baseUrl, token, toUserId, text, contextToken }) {
  const clientId = `wechat-bridge:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const raw = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    bodyObj: {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
      base_info: buildBaseInfo(),
    },
    token,
    timeoutMs: API_TIMEOUT_MS,
  });
  const resp = parseApiJson(raw);
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg ?? "(none)"}`);
  }
  return { ...resp, client_id: clientId };
}
