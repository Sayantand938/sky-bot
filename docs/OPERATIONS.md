# Operations — running and maintaining Sky Bot

**Current status:** deployed and live.

| | |
| --- | --- |
| Bot | [@sky_2026_10_08_bot](https://t.me/sky_2026_10_08_bot) |
| Production URL | https://sky-bot-two.vercel.app |
| Hosting | Vercel, auto-deploys on every push to `main` |
| Webhook | registered at `https://sky-bot-two.vercel.app/api/telegram` |
| Model | `deepseek/deepseek-v4.1-flash` via AICredits |

This document covers **day-to-day operation**: checking health, redeploying,
rotating secrets, tuning her behaviour, and fixing things when they break.
For first-time setup, see [README.md](../README.md).

---

## The normal workflow

Nothing needs the CLI or dashboard for routine changes:

```bash
# edit code
git add -A
git commit -m "your change"
git push          # Vercel builds and deploys automatically (~30s)
```

The webhook points at the **stable alias** (`sky-bot-two.vercel.app`), not a
deployment-specific URL, so redeploys never break Telegram delivery. This was
deliberate — `/api/setup` initially registered a per-deployment host, which would
have gone stale on the next push.

**Changing environment variables** is the one exception: env changes require a
redeploy to take effect. Push an empty commit to trigger one:

```bash
git commit --allow-empty -m "redeploy" && git push
```

---

## Health checks

| Endpoint | Purpose |
| --- | --- |
| `/api/health` | Confirms env vars are set. Look for `"ready": true`. |
| `/api/telegram` | GET returns a small status JSON; POST is the webhook. |
| `/api/setup` | Re-registers the webhook. Requires `?key=<SETUP_KEY>`. |

Check the webhook directly from Telegram:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

What to look for:

- `"url"` — must be `https://sky-bot-two.vercel.app/api/telegram`
- `"pending_update_count"` — should be low; a growing number means delivery is failing
- `"last_error_message"` — **must be absent**. Any value here is the fastest clue
  to what's broken.

---

## Environment variables

Set in Vercel → Project Settings → Environment Variables. Real values live in
[`.env.local`](../.env.local), which is gitignored.

| Variable | Required | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | From @BotFather. |
| `AI_API` | ✅ | AICredits key. |
| `TELEGRAM_WEBHOOK_SECRET` | ✅ | Proves the caller is Telegram. |
| `SETUP_KEY` | optional | Locks `/api/setup`. |
| `BOT_NAME` | optional | Her name. Default `Sky`. |
| `AI_SYSTEM_PROMPT` | ⚠️ | **Replaces her entire personality.** Leave unset. |
| `AI_MODEL` | optional | Default `deepseek/deepseek-v4.1-flash`. |
| `AI_BASE_URL` | optional | Default `https://api.aicredits.in/v1`. |
| `AI_MAX_HISTORY` | optional | Remembered messages per chat. Default `40` (≈20 exchanges), clamped to `50`. |
| `UPSTASH_REDIS_REST_URL` | recommended | Upstash Redis endpoint. Enables durable memory. |
| `UPSTASH_REDIS_REST_TOKEN` | recommended | Upstash Redis token. Both this and the URL must be set. |
| `AI_MEMORY_TTL_DAYS` | optional | Days of silence before a chat is forgotten. Default `14`. |
| `AI_TEMPERATURE` | optional | Default `0.7`. |
| `AI_MAX_TOKENS` | optional | Reply length cap. Default `1024`. |

> **`AI_SYSTEM_PROMPT` is a trap.** Setting it silently disables her persona
> *and* the brevity and bubble-splitting instructions. If she suddenly sounds
> generic, check this first.

---

## Tuning her behaviour

| Want to change | Edit |
| --- | --- |
| Her personality, tone, or rules | `systemPrompt()` in [`lib/config.ts`](../lib/config.ts) |
| When long replies get split | `PREFERRED_MAX` in [`lib/persona.ts`](../lib/persona.ts) (default 220) |
| How many bubbles she can send | `MAX_BUBBLES` in [`lib/persona.ts`](../lib/persona.ts) (default 4) |
| Pause length between bubbles | `bubbleDelayMs()` in [`lib/persona.ts`](../lib/persona.ts) |
| How much she remembers | `AI_MAX_HISTORY` env var (default 40, max 50) |
| How long memory lasts | `UPSTASH_REDIS_REST_URL` + `_TOKEN` (durable); `AI_MEMORY_TTL_DAYS` for expiry |
| Markdown stripping rules | `stripMarkdown()` in [`lib/persona.ts`](../lib/persona.ts) |

After changing anything, verify before pushing:

```bash
node scripts/test-bubbles.mjs         # splitting logic + live conciseness
node scripts/test-split-delivery.mjs  # bubbles arrive as separate messages
node scripts/test-durable-memory.mjs  # memory survives a cold start (needs Redis)
```

---

## Rotating secrets

**If the bot token leaks** (e.g. you shared `BOT DETAILS.md`):

1. Message [@BotFather](https://t.me/BotFather) → `/revoke` → pick the bot.
2. Update `TELEGRAM_BOT_TOKEN` in Vercel and in `.env.local`.
3. Redeploy.
4. Re-run `/api/setup` so Telegram gets the new webhook configuration.

**If the AI key leaks:** regenerate it with your AICredits provider, update
`AI_API` in Vercel, redeploy.

**If the webhook secret leaks:** it only protects your endpoint from
unauthorized callers. Change `TELEGRAM_WEBHOOK_SECRET`, redeploy, then re-run
`/api/setup` — Telegram must be told the new secret or every update gets `401`.

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| She never replies | Webhook not registered, or `last_error_message` is set. Re-run `/api/setup`. |
| Replies stopped after a deploy | Webhook pointing at an old deployment URL. Re-run `/api/setup`. |
| She replies with text about "an AI accessed via an API" or JSON | **Upstream provider leaking its own system prompt.** Not your bug. `lib/ai.ts` retries automatically; search logs for `[ai] attempt`. |
| She sounds generic, lost her personality | `AI_SYSTEM_PROMPT` is set. Remove it and redeploy. |
| `⚠️ The AI API key was rejected.` | `AI_API` wrong, or changed without redeploying. |
| `⚠️ The AI request timed out.` | Lower `AI_MAX_TOKENS`; Vercel caps function duration at 60s. |
| `401 unauthorized` on every update | `TELEGRAM_WEBHOOK_SECRET` changed without re-running `/api/setup`. |
| `409 Conflict` | Another webhook or poller attached. `/api/setup` overwrites it. |
| Replies are too long | Lower `PREFERRED_MAX` in `lib/persona.ts`. |
| She forgets context | Check `/api/health` -> `config.memoryBackend`. `memory` means Redis is unset; see below. |

---

## Known limitations

**Memory is durable only when Redis is configured.** With
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set, history lives in
Redis and survives cold starts. Without them — or if Redis is unreachable —
`lib/memory.ts` falls back to the server instance's memory, and Vercel functions
are ephemeral, so after a cold start she forgets earlier turns. Replies stay
correct either way; she just loses context. On the fallback path, chats idle for
2 hours are evicted and at most 500 chats are tracked. Confirm which backend is
live by checking `config.memoryBackend` on `/api/health`, and verify durability
with `node scripts/test-durable-memory.mjs`.

**Anyone who finds her spends your AICredits.** There is no allow-list. To add
one, filter on `message.from?.id` in `handleMessage`
([`app/api/telegram/route.ts`](../app/api/telegram/route.ts)); get your ID via
`/whoami`.

**The upstream model is occasionally flaky.** It sometimes emits its own
system-prompt boilerplate. `lib/ai.ts` detects and retries up to 3 times; if all
attempts fail the user gets a polite retry message rather than nonsense.

---

## Security reminders

1. **Never commit `.env.local`** or `BOT DETAILS.md` — both hold live secrets.
   Both are gitignored, and the token file is ignored at any depth.
2. **`TELEGRAM_WEBHOOK_SECRET` protects your API credits.** It is the only thing
   preventing a stranger from POSTing to your endpoint and billing you.
3. Secrets are never logged or returned by any endpoint. `/api/health` reports
   only whether each variable is *present*.
4. If a token ever leaks, revoke it immediately — see "Rotating secrets" above.
