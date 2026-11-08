#!/usr/bin/env node
// login.mjs — QR-code login for the iLink Bot protocol (CLI).
//
// Flow (from official login-qr.ts):
//   1. POST get_bot_qrcode -> { qrcode, qrcode_img_content (URL string) }
//   2. Render the URL as qrcode.png (0600) in the state dir; print the URL too.
//   3. Long-poll get_qrcode_status until a terminal state:
//        wait / scaned            -> keep polling
//        need_verifycode          -> the phone shows pairing digits; submit
//                                    them via the next poll's verify_code.
//                                    Digits come from stdin (TTY prompt) or
//                                    from the `verify-code` file in the state
//                                    dir (written by the operator). Digits
//                                    are never logged.
//        scaned_but_redirect      -> switch polling host to redirect_host
//                                    (after the weixin.qq.com whitelist check)
//        expired / verify_code_blocked -> fetch a fresh QR (max 3 refreshes)
//        binded_redirect          -> this bot is already bound; existing
//                                    local credentials stay valid
//        confirmed                -> save credentials, delete the QR PNG
//
// Usage:
//   node src/login.mjs                     interactive login
//   node src/login.mjs --print-qr-url-only offline dry-run: validate inputs
//                                          and print the QR request URL that
//                                          WOULD be called; no network use
//   node src/login.mjs --selftest          offline: render a test QR PNG to
//                                          /tmp and check the PNG signature
//   Options: --bot-type <n> (default 3), --timeout-ms <n> (default 480000)

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import {
  FIXED_BASE_URL,
  DEFAULT_BOT_TYPE,
  assertWeixinUrl,
  fetchBotQrCode,
  pollQrStatus,
} from "./ilink.mjs";
import { encodeQrPng } from "./qr.mjs";
import {
  STATE_DIR,
  QRCODE_PATH,
  VERIFY_CODE_PATH,
  ensureDir,
  writeSecretFile,
  loadCredentials,
  saveCredentials,
  tailOf,
} from "./state.mjs";

const MAX_QR_REFRESHES = 3;

function parseArgs(argv) {
  const args = { botType: DEFAULT_BOT_TYPE, timeoutMs: 480_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--print-qr-url-only") args.printQrUrlOnly = true;
    else if (a === "--selftest") args.selftest = true;
    else if (a === "--bot-type") args.botType = argv[++i];
    else if (a === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!/^\d+$/.test(String(args.botType))) throw new Error("--bot-type must be a non-negative integer string");
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) throw new Error("--timeout-ms must be >= 1000");
  return args;
}

function printUsage() {
  console.log("Usage: node src/login.mjs [--print-qr-url-only | --selftest] [--bot-type <n>] [--timeout-ms <n>]");
}

/** Offline dry-run: run all local validation and print what would be called. */
function dryRun(args) {
  // Validate the fixed base URL against the egress whitelist (throws if bad).
  assertWeixinUrl(FIXED_BASE_URL, "FIXED_BASE_URL");
  const endpoint = `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(args.botType)}`;
  const url = new URL(endpoint, `${FIXED_BASE_URL}/`);
  assertWeixinUrl(url.href, "get_bot_qrcode url");
  const existing = loadCredentials();
  console.log("[dry-run] no network requests were made");
  console.log(`[dry-run] POST ${url.href}`);
  console.log(`[dry-run] body: { "local_token_list": [<${existing ? 1 : 0} existing token(s), value not printed>] }`);
  console.log(`[dry-run] QR PNG would be written to: ${QRCODE_PATH}`);
  console.log(`[dry-run] state dir: ${STATE_DIR}`);
}

/** Offline self-test of the QR + PNG pipeline. */
function selfTest() {
  const png = encodeQrPng("https://ilinkai.weixin.qq.com/selftest");
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!png.subarray(0, 8).equals(sig)) throw new Error("selftest: bad PNG signature");
  const out = "/tmp/wechat-bridge-qr-selftest.png";
  fs.writeFileSync(out, png);
  console.log(`[selftest] QR PNG ok (${png.length} bytes) -> ${out}`);
}

async function writeQrPng(qrcodeUrl) {
  const png = encodeQrPng(qrcodeUrl);
  writeSecretFile(QRCODE_PATH, png);
}

function deleteQrPng() {
  try {
    fs.unlinkSync(QRCODE_PATH);
  } catch {
    /* already gone */
  }
}

/** Read pairing digits from the verify-code file if present (never logged). */
function readVerifyCodeFile() {
  try {
    const code = fs.readFileSync(VERIFY_CODE_PATH, "utf-8").trim();
    return code || undefined;
  } catch {
    return undefined;
  }
}

function consumeVerifyCodeFile() {
  try {
    fs.unlinkSync(VERIFY_CODE_PATH);
  } catch {
    /* ignore */
  }
}

async function promptVerifyCode(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printUsage();
  if (args.printQrUrlOnly) return dryRun(args);
  if (args.selftest) return selfTest();

  ensureDir(STATE_DIR);
  const existing = loadCredentials();
  const localTokenList = existing ? [existing.bot_token] : [];

  let qr = await fetchBotQrCode({ botType: args.botType, localTokenList });
  let qrcode = qr.qrcode;
  await writeQrPng(qr.qrcode_img_content);
  console.log(`二维码已生成: ${QRCODE_PATH}`);
  console.log(`备用链接（同样可完成绑定）: ${qr.qrcode_img_content}`);
  console.log("请用手机微信扫描二维码。");

  let pollBaseUrl = FIXED_BASE_URL;
  let pendingVerifyCode;
  let lastSubmittedCode;
  let refreshes = 1;
  let scannedPrinted = false;
  const deadline = Date.now() + args.timeoutMs;

  while (Date.now() < deadline) {
    const resp = await pollQrStatus({ baseUrl: pollBaseUrl, qrcode, verifyCode: pendingVerifyCode });
    switch (resp.status) {
      case "wait":
        break;
      case "scaned":
        if (pendingVerifyCode) {
          // Server accepted the pairing digits.
          pendingVerifyCode = undefined;
          lastSubmittedCode = undefined;
          consumeVerifyCodeFile();
        }
        if (!scannedPrinted) {
          console.log("已扫码，正在验证…");
          scannedPrinted = true;
        }
        break;
      case "need_verifycode": {
        // If we already submitted digits and the server still asks, they were
        // wrong (official CLI infers the same and re-prompts).
        const wrongRetry = pendingVerifyCode !== undefined;
        if (wrongRetry) {
          console.log("配对数字不匹配，请重新输入。");
          pendingVerifyCode = undefined;
          consumeVerifyCodeFile();
        }
        let code;
        const fileCode = readVerifyCodeFile();
        if (fileCode && fileCode !== lastSubmittedCode) {
          code = fileCode;
        } else if (process.stdin.isTTY) {
          code = await promptVerifyCode("输入手机微信上显示的配对数字: ");
        } else {
          // Non-interactive: wait for the operator to write the verify-code
          // file, then submit on the next iteration.
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (code) {
          pendingVerifyCode = code;
          lastSubmittedCode = code;
        }
        continue; // poll again immediately with the code attached
      }
      case "scaned_but_redirect": {
        if (resp.redirect_host) {
          const newBase = `https://${resp.redirect_host}`;
          // The redirect target must pass the same whitelist before use.
          assertWeixinUrl(newBase, "redirect_host");
          pollBaseUrl = newBase;
          console.log(`已切换轮询主机: ${resp.redirect_host}`);
        }
        break;
      }
      case "expired":
      case "verify_code_blocked": {
        if (resp.status === "verify_code_blocked") {
          console.log("配对数字多次错误，需要刷新二维码。");
          pendingVerifyCode = undefined;
          lastSubmittedCode = undefined;
          consumeVerifyCodeFile();
        }
        refreshes++;
        if (refreshes > MAX_QR_REFRESHES) {
          deleteQrPng();
          throw new Error("二维码多次失效，登录已停止。请稍后再试。");
        }
        console.log(`二维码已失效，正在刷新 (${refreshes}/${MAX_QR_REFRESHES})…`);
        qr = await fetchBotQrCode({ botType: args.botType, localTokenList });
        qrcode = qr.qrcode;
        await writeQrPng(qr.qrcode_img_content);
        scannedPrinted = false;
        console.log(`新二维码: ${QRCODE_PATH}`);
        console.log(`备用链接: ${qr.qrcode_img_content}`);
        break;
      }
      case "binded_redirect":
        deleteQrPng();
        console.log("这个机器人已经绑定过，本地已有凭证继续有效，无需重复登录。");
        return;
      case "confirmed": {
        if (!resp.ilink_bot_id) throw new Error("登录失败：服务器未返回 ilink_bot_id。");
        if (!resp.bot_token) throw new Error("登录失败：服务器未返回 bot_token。");
        let baseUrl = FIXED_BASE_URL;
        if (resp.baseurl) {
          // Validate the server-provided base_url before trusting it.
          baseUrl = assertWeixinUrl(resp.baseurl, "login baseurl").href.replace(/\/$/, "");
        }
        saveCredentials({
          bot_token: resp.bot_token,
          ilink_bot_id: resp.ilink_bot_id,
          base_url: baseUrl,
          ilink_user_id: resp.ilink_user_id,
          saved_at: new Date().toISOString(),
        });
        deleteQrPng();
        console.log("登录成功。");
        console.log(`  ilink_bot_id : ${tailOf(resp.ilink_bot_id)}`);
        console.log(`  ilink_user_id: ${tailOf(resp.ilink_user_id)}`);
        console.log(`  base_url     : ${baseUrl}`);
        console.log(`  凭证已存到 state 目录下的 credentials.json (0600)，bot_token 不会打印。`);
        return;
      }
      default:
        console.log(`未知的登录状态: ${String(resp.status)}，继续轮询…`);
        break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  deleteQrPng();
  throw new Error("登录超时，请重试。");
}

main().catch((err) => {
  console.error(`登录失败: ${err.message}`);
  process.exit(1);
});
