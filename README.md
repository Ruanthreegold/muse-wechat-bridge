# muse-wechat-bridge — 把 Muse 接入微信的自研极简桥

一个按腾讯官方 **iLink Bot** 协议（微信 ClawBot 背后的协议）从零实现的
微信桥：扫码登录、长轮询收消息、本地 API 发消息。Node.js 24+，
**零第三方依赖**（只用内置 `fetch` / `crypto` / `fs` / `zlib`，连二维码
编码器都是自带的纯 JS 实现），全部代码 5 个文件、约 1500 行，
**任何人都可以从头到尾审计一遍再决定要不要用**。

它的定位是给 Muse（或任何本地 Agent）提供一个微信收发通道：桥只负责
收发，消息的理解与回复由你自己的 Agent 完成。

## 为什么自研，而不用现成的第三方桥

市面上能找到的同类项目大多是个人发布的仓库：来源背景不清晰、代码量不小、
没有可核查的审计记录，却要求你拿真实微信账号扫码登录、把登录凭证交给它
保管。微信登录凭证（`bot_token`）等同于账号的会话钥匙，这类凭证交给一段
没审过的代码，风险不对等。

所以本项目的设计取向是：

- **协议只认官方出处**：每个端点、每个字段都对照腾讯官方 npm 包
  `@tencent-weixin/openclaw-weixin@2.4.10` 的源码实现，并在文档中标注
  出处文件，不凭博客或二手转述写代码。
- **代码小到可审计**：零依赖、单文件职责清晰，先审后用是默认流程
  （仓库附带一份给 Muse 的部署指令，第一条就是先审代码）。
- **凭证不出本机**：凭证、聊天记录、令牌全部只落在本地受限权限文件里，
  代码没有任何向第三方地址出站的路径。

## 架构与数据流

```
手机微信 ──扫码──▶ src/login.mjs ──▶ credentials.json (0600)
                                        │ bot_token / ilink_bot_id
                                        │ base_url / ilink_user_id
                                        ▼
                                   src/server.mjs（常驻）
                                        │ 长轮询 getupdates
                                        ├─▶ inbox.jsonl（入站消息落盘）
                                        ├─▶ contexts.json（每用户最新 context_token）
                                        └─▶ 本地 HTTP API 127.0.0.1:18792
                                              /status /inbox /send（Bearer 令牌）
```

| 文件 | 作用 |
| --- | --- |
| `src/ilink.mjs` | 协议客户端：请求头、base_info、出站白名单校验、各端点调用 |
| `src/login.mjs` | 命令行扫码登录；生成二维码 PNG；轮询状态；处理配对码 |
| `src/server.mjs` | 常驻进程：长轮询收消息落盘 + 本地 HTTP API |
| `src/state.mjs` | 本地状态/凭证/令牌的路径与权限管理 |
| `src/qr.mjs` | 纯 JS QR 编码器（字节模式、纠错 M、版本 1–10）+ PNG 写入 |

数据流：`login.mjs` 扫码成功后把凭证写入本地状态目录；`server.mjs` 用
凭证长轮询 `getupdates`，把入站消息逐行追加到 `inbox.jsonl`，并缓存每个
对端用户最新的 `context_token`；上层 Agent 通过本地 API 读消息、发回复，
发送时桥自动带上对应用户的 `context_token`，把回复挂进正确的会话。

## 协议端点表

基础地址：登录固定走 `https://ilinkai.weixin.qq.com`；登录成功后服务器
返回 `baseurl`，后续请求改走该地址（为空时回退到固定地址）。

所有 POST 的公共请求头：`Content-Type: application/json`、
`AuthorizationType: ilink_bot_token`、`X-WECHAT-UIN`（随机 uint32 →
十进制字符串 → base64，每请求新生成）、`Authorization: Bearer <bot_token>`
（有 token 时）、`iLink-App-Id: bot`、`iLink-App-ClientVersion`（版本号按
`major<<16|minor<<8|patch` 编码的 uint32）。扫码状态轮询是 GET，只带
`iLink-App-Id` / `iLink-App-ClientVersion` 两个头。所有 POST body 都带
`base_info = { channel_version, bot_agent }`。

| # | 端点 | 方法 | 关键字段 | 来源（官方包文件） |
| --- | --- | --- | --- | --- |
| 1 | `ilink/bot/get_bot_qrcode?bot_type=3` | POST | body `{local_token_list: string[]}`（已有账号的 token，供服务器识别已绑定）；返回 `{qrcode, qrcode_img_content}`，后者是二维码编码的 **URL 字符串** | `auth/login-qr.ts` |
| 2 | `ilink/bot/get_qrcode_status?qrcode=…[&verify_code=…]` | GET（35 s 长轮询） | `status` ∈ `wait / scaned / confirmed / expired / scaned_but_redirect / need_verifycode / verify_code_blocked / binded_redirect`；`confirmed` 时带 `bot_token / ilink_bot_id / baseurl / ilink_user_id`；`scaned_but_redirect` 时带 `redirect_host`，后续轮询改走 `https://<redirect_host>` | `auth/login-qr.ts` |
| 3 | `ilink/bot/getupdates` | POST | body `{get_updates_buf, base_info}`；首轮游标为 `""`，之后原样回传响应给的游标（不透明，须持久化）；`errcode=-14` = 会话/token 失效 | `api/api.ts`、`api/session-guard.ts` |
| 4 | `ilink/bot/sendmessage` | POST | body `{msg, base_info}`；`msg = {from_user_id:"", to_user_id, client_id, message_type:2, message_state:2, item_list:[{type:1, text_item:{text}}], context_token?}`；返回 `{message_id, ret, errmsg}` | `api/api.ts`、`messaging/send.ts` |

补充说明：

- **context_token**：由 `getupdates` 随每条入站消息下发，按（账号，
  发送者）保存最新一条，发送时原样带上以串联会话。缺失也能发，但可能
  无法正确串联会话。
- **配对码**：协议内步骤，不是独立接口。扫码后状态可能变为
  `need_verifycode`——手机微信上显示一串数字，把数字作为 `verify_code`
  查询参数随下一次状态轮询提交；多次错误会变 `verify_code_blocked`
  并作废当前二维码。本桥支持在终端输入，或把数字写进状态目录的
  `verify-code` 文件由程序自动提交（提交后即删除，**数字从不写日志**）。
- **message_id**：uint64，JSON 里可能以裸数字出现且超出 JS 安全整数，
  本实现与官方一样在 `JSON.parse` 前把相关字段的裸数字值加引号无损解析。

## 安全模型

- **出站白名单（代码强制）**：所有请求 URL 必须满足 https、主机名为
  `weixin.qq.com` 或 `*.weixin.qq.com`、端口 443、无内嵌凭证；登录返回
  的 `baseurl` 与轮询重定向的 `redirect_host` 在使用前都过同一校验
  （`src/ilink.mjs` 的 `assertWeixinUrl`）。`fetch` 使用
  `redirect: "manual"`，任何 3xx 直接报错，永不自动跟随跳转。除微信
  域名外，代码不访问任何网络地址（本地 HTTP API 是入站监听，不算出站）。
- **凭证只存本地，权限 0600**：状态目录 0700；`credentials.json`
  （`bot_token` 等）、轮询游标、上下文缓存、收件箱、本地 API 令牌全部
  0600。日志只打印 ID 尾号，**从不打印 `bot_token`、API 令牌、配对数字**。
- **本地 API 带令牌**：只绑 `127.0.0.1:18792`；除 `/healthz` 返回
  `{alive:true}` 外，全部接口需要 Bearer 令牌（恒定时间比较）；请求体
  上限 64 KB。令牌是本地随机生成的 32 字节，存在
  `~/.config/wechat-bridge/token`。
- **发信人白名单在消费层落实**：桥本身记录所有入站消息；谁的消息可以
  触发上层 Agent 执行动作，必须由消费 `inbox.jsonl` 的一层按
  `from_user_id == 登录者本人的 ilink_user_id` 做白名单。**部署时务必
  落实这一层**，否则任何能给这个 Bot 发消息的人都可能间接驱动你的 Agent。

### 本地状态文件一览

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `~/.local/state/wechat-bridge/` | 状态目录 | 0700 |
| `…/credentials.json` | `bot_token`、`ilink_bot_id`、`base_url`、`ilink_user_id` | 0600 |
| `…/sync.json` | `get_updates_buf` 轮询游标 | 0600 |
| `…/contexts.json` | 每个对端用户最新的 `context_token` | 0600 |
| `…/inbox.jsonl` | 入站记录：`{ts, from_user_id, to_user_id, text, context_token}` | 0600 |
| `…/qrcode.png` | 登录二维码，登录结束后删除 | 0600 |
| `…/verify-code` | 配对数字传递文件（用后删除） | 0600 |
| `~/.config/wechat-bridge/token` | 本地 HTTP API 的 Bearer 令牌 | 0600 |

路径可用环境变量 `WECHAT_BRIDGE_STATE_DIR` / `WECHAT_BRIDGE_CONFIG_DIR`
覆盖（测试用）。

## 快速开始

前置：Node.js 24+、一台能跑 systemd 的 Linux（常驻部分）、一个已开通
ClawBot 的微信（用哪个号由扫码那一下决定）。

### 1. 登录

```bash
node src/login.mjs
# 二维码图片: ~/.local/state/wechat-bridge/qrcode.png（终端也会打印备用链接）
# 用手机微信扫码；若手机出现配对数字：终端直接输入，或把数字写进
# ~/.local/state/wechat-bridge/verify-code，程序会自动提交
```

二维码约 1–2 分钟过期，登录程序会自动刷新（最多 3 张）。**把二维码图片
发给扫码人时请用唯一文件名**（例如带时间戳），避免聊天客户端缓存旧图、
扫到过期码。

### 2. 常驻（systemd）

```ini
# /etc/systemd/system/wechat-bridge.service
[Unit]
Description=muse-wechat-bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/home/<你的用户名>
EnvironmentFile=-/home/<你的用户名>/.config/wechat-bridge/env
WorkingDirectory=/path/to/muse-wechat-bridge
ExecStart=/usr/bin/node src/server.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wechat-bridge
```

两个必须注意的点（都是实测踩过的坑，详见「已知坑与限制」）：

- 单元里必须显式写 `Environment=HOME=…`，否则服务以 root 身份把状态
  目录落到 `/root` 下，读不到你用户目录里的凭证，表现是「服务在跑但
  没登录」。
- 如果本机出网要走代理，必须用 EnvironmentFile 把 `http_proxy` /
  `https_proxy` / `NODE_USE_ENV_PROXY=1` 传给服务（见下），systemd
  不会继承你 shell 里的环境变量。

`~/.config/wechat-bridge/env` 示例（无代理需求可不建此文件）：

```ini
http_proxy=http://127.0.0.1:7890
https_proxy=http://127.0.0.1:7890
NODE_USE_ENV_PROXY=1
```

### 3. 本地 API 自查

```bash
TOKEN=$(cat ~/.config/wechat-bridge/token)
curl -s http://127.0.0.1:18792/healthz
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18792/status
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:18792/inbox?since=0"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"to_user_id":"<对端ID>","text":"你好"}' http://127.0.0.1:18792/send
```

`/status` 里 `logged_in=true` 且 `last_poll_ok_at` 有值、`last_error`
为空，才算轮询正常。

离线自检（不联网）：

```bash
node --check src/*.mjs                   # 语法检查
node src/login.mjs --print-qr-url-only   # 校验参数与 URL 构造，打印将调用的请求
node src/login.mjs --selftest            # 生成一张测试 QR PNG 并校验
```

## 值守说明（桥只负责收发，回复要自己安排）

桥不会自己回复任何消息——它只把消息落盘到 `inbox.jsonl`、提供发送 API。
要做到「微信里发消息，Agent 自动回」，使用方必须自己安排一个**常驻
消费者**：持续盯着收件箱，有新行就交给 Agent 处理并调用 `/send` 回复，
处理完推进已读位置。

本项目实际在用的做法（供参考）：一个每 **30 秒**运行一次的轻量钩子
脚本，比对 `inbox.jsonl` 的行数与已处理计数文件；有新消息才唤醒 Agent，
Agent 只处理「已处理行数之后」的新行、按发信人白名单过滤（只回登录者
本人）、回复后把计数推进到当前总行数。这样平时零打扰，来消息时约
30 秒～1 分钟内有人接。你也可以用 cron、systemd path unit 或任何
长驻进程实现同样的事，原理都是「轮询收件箱 + 维护已读计数 + 白名单」。

## 已知坑与限制

实测踩过并已确认的坑：

1. **代理与 NODE_USE_ENV_PROXY**：本机出网需走代理时，Node 的 `fetch`
   要靠环境变量 `NODE_USE_ENV_PROXY=1` 加 `http_proxy`/`https_proxy`
   才会走代理；systemd 服务不继承 shell 环境，必须显式配
   EnvironmentFile，否则 `getupdates` 直接报 TypeError（fetch failed），
   看起来像「协议不通」，其实是网络没出去。
2. **systemd 的 HOME**：单元不写 `Environment=HOME=<用户HOME>` 时，
   状态目录会落到 `/root/.local/state/…`，变成另一套空状态——服务状态
   显示在跑，却读不到凭证、不轮询。
3. **二维码时效与缓存**：二维码约 1–2 分钟过期，登录程序会自动刷新
   最多 3 张；把二维码图发给用户时务必用唯一文件名，聊天客户端会按
   文件名/路径缓存图片，同名重发可能显示的是已过期的旧码。
4. **baseurl / redirect_host 必须校验**：登录返回的 `baseurl` 和状态
   轮询的重定向主机都是服务端下发的数据，使用前必须过白名单校验
   （本桥已在代码里强制），不要裸用，否则等于让服务端响应决定你的
   凭证发往哪个域名。
5. **errcode -14 = 会话失效**：轮询返回 -14 表示 token/会话已失效
   （确切成因无官方说明），本桥做退避并置 stale 标志，实际恢复路径
   大概率是重新扫码登录。
6. **配对数字不要进日志**：扫码后手机可能出现配对数字，走
   `verify_code` 提交即可；任何环节都不要把数字写进公开日志或聊天
   记录，本桥的日志与状态文件都不记录它。

功能限制（当前版本）：

- **纯文本桥**：只收发文本。图片/语音/文件/视频的媒体消息（CDN 上传
  下载）未实现。
- **未实现的协议面**：`getconfig`、打字状态（`sendtyping`）、上下线
  通知（`notifystart` / `notifystop`）均未实现。其中上下线通知是否
  影响消息投递未知——若登录成功但收不到消息，这是第二排查项
  （第一是代理）。
- **channel_version 如实上报的风险**：本桥如实上报自己的
  `channel_version=0.1.0` 与 ClientVersion，不冒充官方客户端版本。
  若服务端按版本做最低门槛拦截，登录或轮询可能被拒；可用环境变量
  `WECHAT_BRIDGE_CHANNEL_VERSION` 调整上报值重试，但这属于未验证路径。
- **其他未确定项**：`bot_type=3` 的确切语义无官方文档（沿用官方包
  默认值）；`binded_redirect` 状态下本地凭证丢失的恢复路径无官方
  文档，本实现未处理；入站去重完全依赖 `get_updates_buf` 游标语义，
  未按 `message_id` 二次去重。

## 免责声明

- 本项目**不是腾讯官方产品**，与腾讯、微信团队没有任何隶属或授权
  关系；iLink Bot 协议及相关接口的权利归腾讯所有，本项目只是按公开
  可得的官方客户端实现所做的独立重写。
- 本项目与 Muse / Meta 没有隶属关系，只是一个可供 Muse 等 Agent
  使用的通道工具。
- 微信账号存在被限制、要求重新验证或封禁的可能，协议变更也可能随时
  使本项目失效。**是否使用、使用哪个账号，风险由使用者自行评估和
  承担**；建议先用非主力账号验证。
- 本项目按 MIT 许可证「按现状」提供，不作任何担保（见 LICENSE）。
