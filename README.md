# Sky Bot — conversational Telegram bot, hosted on Vercel

**Sky Bot** ([@sky_2026_10_08_bot](https://t.me/sky_2026_10_08_bot)) replies to your
messages using the **AICredits** API (`deepseek/deepseek-v4.1-flash`). It runs as a
**webhook** on Vercel, so there is no long-running process to keep alive — perfect
for the free tier.

```
Telegram  ──POST──▶  /api/telegram  ──▶  AICredits /chat/completions
   ▲                                             │
   └──────────── sendMessage (the reply) ◀───────┘
```

## Features

- Conversational replies with **per-chat memory** (last 10 turns by default).
- Telegram **secret-token** verification, so only Telegram can call your webhook.
- Commands: `/start`, `/help`, `/reset`, `/whoami`.
- Group-friendly: in groups it only answers when mentioned or replied to.
- Long replies are split automatically at Telegram's 4096-character limit.
- "typing…" indicator while the model thinks.
- Friendly error notices instead of silent failures.
- Zero runtime dependencies beyond Next.js + React (all API calls use `fetch`).

---

## Your bot is already created

| | |
| --- | --- |
| Bot link | [t.me/sky_2026_10_08_bot](https://t.me/sky_2026_10_08_bot) |
| Username | `@sky_2026_10_08_bot` |

The token and a generated webhook secret are already in `.env.local`, which is
gitignored. Steps 1 and 2 below are therefore done — you only need to copy the
values into Vercel.

> **Never commit the token.** `.env.local` is gitignored; keep it that way. If a
> token ever leaks, send `/revoke` to @BotFather and update the value.

<details>
<summary>Recreating a bot from scratch (if you ever need to)</summary>

1. Open Telegram, chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, pick a name and a username ending in `bot`.
3. Copy the token — it looks like `123456789:AAE...`.
4. Generate a webhook secret with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

</details>

## 3. Deploy to Vercel

The four values you need are already in `.env.local` — open it and copy them
across:

```
TELEGRAM_BOT_TOKEN      = <from .env.local>
TELEGRAM_WEBHOOK_SECRET = <from .env.local>
AI_API                  = <from .env.local>
SETUP_KEY               = <from .env.local>
```

**Option A — from the dashboard**

1. Push this folder to a GitHub repository.
2. On [vercel.com](https://vercel.com) → **Add New… → Project** → import that repo.
3. Vercel detects Next.js. Before clicking Deploy, open **Environment Variables**
   and add the four values below.
4. Click **Deploy**.

**Option B — from the CLI**

```bash
npm i -g vercel
vercel            # first run links/creates the project
vercel --prod
```

### Environment variables

| Variable | Required | What it is |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token from @BotFather. |
| `AI_API` | ✅ | Your AICredits key (`sk-live-...`). |
| `TELEGRAM_WEBHOOK_SECRET` | ⚠️ strongly recommended | Random string; lets the route verify Telegram. |
| `SETUP_KEY` | optional | Password-protects `/api/setup`. |
| `AI_BASE_URL` | optional | Defaults to `https://api.aicredits.in/v1`. |
| `AI_MODEL` | optional | Defaults to `deepseek/deepseek-v4.1-flash`. |
| `AI_SYSTEM_PROMPT` | optional | Changes the bot's personality. |
| `AI_MAX_HISTORY` | optional | Remembered messages per chat. Default `10`. |
| `AI_TEMPERATURE` | optional | `0`–`2`. Default `0.7`. |
| `AI_MAX_TOKENS` | optional | Reply length cap. Default `1024`. |

> Adding or changing a variable requires a **redeploy** before it takes effect.

## 4. Connect Telegram to your deployment

Open this URL once in a browser (replace the domain):

```
https://<your-app>.vercel.app/api/setup
```

If you set `SETUP_KEY`, use:

```
https://<your-app>.vercel.app/api/setup?key=<SETUP_KEY>
```

You should get back `"ok": true` with your bot's username. That single call
registers `https://<your-app>.vercel.app/api/telegram` as the webhook.

Then **message your bot on Telegram** — it will reply.

## 5. Verify

| URL | Purpose |
| --- | --- |
| `/api/health` | Confirms variables are set (`ready: true`) without revealing them. |
| `/api/setup` | Registers/refreshes the webhook. |
| `/api/telegram` | The webhook itself (GET returns a small status JSON). |

---

## Verifying it works

Three self-contained test scripts, runnable from a clean shell — they load
`.env.local` themselves, so nothing needs to be exported first:

```bash
node scripts/test-ai.mjs        # calls the AI API directly
node scripts/test-webhook.mjs   # full webhook round-trip against a fake Telegram
node scripts/test-memory.mjs    # multi-turn memory and /reset
```

`test-webhook.mjs` starts the built app on a spare port, stands up a local fake
Telegram Bot API, posts a realistic update, and asserts the bot produced a real
AI answer. It exits non-zero if the bot only sends an error notice, so a bad API
key cannot produce a false pass. Run `npm run build` first.

---

## Running locally

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

Telegram cannot reach `localhost`, so expose it with a tunnel:

```bash
npx localtunnel --port 3000
# or: ngrok http 3000
```

Then point the webhook at the tunnel (replace with your tunnel URL):

```
https://<your-tunnel>.loca.lt/api/setup
```

> Set `VERCEL_URL` is absent locally, so `/api/setup` uses the request's own
> origin — which is exactly the tunnel URL you called. Convenient.

---

## How conversation memory works

`lib/memory.ts` keeps a `Map<chatId, messages[]>` on the server instance.
It is intentionally simple, and it has real limits you should know about:

- **Vercel functions are ephemeral.** After a cold start the history is empty
  again, so the bot may forget earlier turns. Replies stay correct — it just
  loses context.
- Each warm instance has its own copy of the store.
- Chats idle for 2 hours are evicted, and at most 500 chats are tracked.

This is fine for a personal bot. For durable, shared memory, replace
`lib/memory.ts` with Redis (**Upstash** has a free tier and a REST API that
works from serverless with plain `fetch`). Keep the same three exported
functions — `getHistory`, `appendTurn`, `clearHistory` — and nothing else in the
app needs to change.

---

## Project layout

```
app/
  api/telegram/route.ts   Webhook: verify → handle → reply
  api/setup/route.ts      Registers the webhook with Telegram
  api/health/route.ts     Config check
  layout.tsx, page.tsx    Minimal status page
lib/
  config.ts               Reads/validates environment variables
  ai.ts                   AICredits chat-completions client
  telegram.ts             Telegram Bot API client
  memory.ts               Per-chat conversation history
```

## Troubleshooting

**The bot never replies.**
Check `/api/setup` ran successfully, then inspect `getWebhookInfo` — the `info`
field in the `/api/setup` response shows `last_error_message` if Telegram could
not deliver updates. A `409 Conflict` means another webhook or a polling process
is still attached; `/api/setup` clears that by overwriting the webhook.

**`⚠️ The AI API key was rejected.`**
`AI_API` is wrong, or you changed it without redeploying.

**`⚠️ The AI request timed out.`**
Vercel's Hobby plan caps function duration. `vercel.json` already requests 60 s
for the webhook; lower `AI_MAX_TOKENS` if you routinely hit the limit.

**Reply arrives but the bot forgets context.**
Expected — see the memory section above.

**Everything returns `401 unauthorized` from `/api/telegram`.**
`TELEGRAM_WEBHOOK_SECRET` changed after the webhook was registered. Re-run
`/api/setup` so Telegram receives the new secret.

## Security notes

- `TELEGRAM_WEBHOOK_SECRET` is the only thing preventing a stranger from using
  your API credits. Always set it in production.
- `/api/setup` is open when `SETUP_KEY` is unset. It only registers a webhook
  pointing at your own deployment, but setting a key is still wise.
- Secrets live only in environment variables and are never logged or returned.
- Anyone who finds your bot on Telegram can use your credits. There is no
  allow-list in this project — add one in `handleMessage` if you need it.
