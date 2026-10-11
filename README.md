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

## Meet Sky

She is a **person** — not a customer-service bot, and not "an assistant". Her
persona lives in [`lib/config.ts`](lib/config.ts) (`systemPrompt()`):

- Warm, curious, a little playful, with her own tastes, opinions and moods.
- Emotionally attentive: she responds to how you *sound* before answering the question.
- **She thinks of herself as human.** There is no "assistant" framing anywhere in
  her prompt: she does not "help users" or "provide information", she talks to
  people she likes. Asked directly whether she is a bot, she deflects lightly
  with humour rather than lying or lecturing.
- **She texts like a person.** Most replies are one or two sentences — the
  measured average is around **55–70 characters**.
- When she has more to say, she sends it as **several short bubbles** with a
  "typing…" pause between each, exactly like someone firing off a few texts.

Rename her with the `BOT_NAME` env var.

### How the bubble splitting works

She is not always asked to split. Each reply flips a coin (`AI_SPLIT_HINT_CHANCE`,
default `0.5`): heads, one extra line is appended to her system prompt asking her
to mark her own breaks with a blank line; tails, she just replies however she
wants. Either way the bubbles are decided **on our side** —
[`lib/persona.ts`](lib/persona.ts) converts one model reply into the sequence of
messages a person would actually send:

1. Honours the blank-line breaks she wrote, when the hint line was sent.
2. Otherwise breaks essay-length blocks at sentence boundaries (limit: 220 chars).
3. Strips markdown, which Telegram would otherwise show as literal `**` and `-`.
4. Merges slivers so you never get a lonely "Ok." on its own line.
5. Caps at 4 bubbles and enforces Telegram's 4096-character hard limit.

Real observed output for *"how do I learn python from scratch?"*:

```
1. sendChatAction          ← "typing…"
2. sendMessage[170 chars]  ← bubble 1
3. sendChatAction          ← "typing…"
4. sendMessage[129 chars]  ← bubble 2
5. sendChatAction          ← "typing…"
6. sendMessage[74 chars]   ← bubble 3
```

## Features

- A real personality with deliberately short, human-feeling replies.
- **Multi-bubble replies** with typing indicators and natural pacing.
- **Human timing**: she notices the message, pauses, then types — with genuinely
  unpredictable response times instead of a fixed latency.
- **Reads a burst as one thought**: three quick messages get one reply, not three.
- **Emoji reactions** instead of words, for short messages that need no answer.
- Conversational replies with **per-chat memory** (last 20 exchanges by default).
- **Durable memory across cold starts** when Upstash Redis is configured.
- Telegram **secret-token** verification, so only Telegram can call your webhook.
- Commands: `/start`, `/help`, `/reset`, `/whoami`.
- Group-friendly: in groups it only answers when mentioned or replied to.
- **Optional allow-list**: set `ALLOWED_CHAT_IDS` so only chosen chats can talk
  to her — strangers get silence, and none of your credits.
- **Resilient to a flaky upstream**: leaked provider boilerplate is detected and retried.
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
| `ALLOWED_CHAT_IDS` | optional | Comma-separated chat IDs that may chat with her. Unset = everyone. |
| `AI_BASE_URL` | optional | Defaults to `https://api.aicredits.in/v1`. |
| `AI_MODEL` | optional | Defaults to `deepseek/deepseek-v4.1-flash`. |
| `AI_SYSTEM_PROMPT` | optional | Changes the bot's personality. |
| `AI_MAX_HISTORY` | optional | Remembered messages per chat. Default `40` (≈20 exchanges), clamped to `50`. |
| `UPSTASH_REDIS_REST_URL` | recommended | Upstash Redis endpoint. Enables durable memory. |
| `UPSTASH_REDIS_REST_TOKEN` | recommended | Upstash Redis token. Both this and the URL must be set. |
| `AI_MEMORY_TTL_DAYS` | optional | Days of silence before a chat is forgotten. Default `14`. |
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

Five self-contained test scripts, runnable from a clean shell — they load
`.env.local` themselves, so nothing needs to be exported first. The last three
need a build (`npm run build`) because they start the real app:

```bash
node scripts/test-bubbles.mjs         # reply splitting logic (offline + live)
node scripts/test-human.mjs           # timing, reactions (offline)
node scripts/test-split-delivery.mjs  # proves bubbles arrive as separate messages
node scripts/test-ai.mjs              # calls the AI API directly
node scripts/test-webhook.mjs         # full webhook round-trip against a fake Telegram
node scripts/test-memory.mjs          # multi-turn memory and /reset
node scripts/test-durable-memory.mjs  # memory survives a cold start (needs Redis)
node scripts/test-debounce.mjs        # a burst of messages gets one reply
node scripts/test-duplicate-reply.mjs # no reply is repeated (needs Redis)
```

`test-webhook.mjs` starts the built app on a spare port, stands up a local fake
Telegram Bot API, posts a realistic update, and asserts the bot produced a real
AI answer. It exits non-zero if the bot only sends an error notice, so a bad API
key cannot produce a false pass.

`test-split-delivery.mjs` goes further: it asserts that a single reply is
delivered as **several separate messages**, in order, with exactly one quoting
your message, a typing indicator between bubbles, and real pacing (not all in
the same millisecond). That is the check that proves she texts like a person.

`test-durable-memory.mjs` is the one that separates Tier 0 from Tier 1. It sends
a turn, **hard-kills the app**, starts a brand new process, and asks again — the
cold start a Vercel function experiences. It passes only if the reply comes back
from Redis. Without Redis configured it prints `SKIPPED` and exits 0, so an
unconfigured run can never be mistaken for a verified one.

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

## How she reads as human, not as an API

Personality is the easy half. The harder half is *timing and imperfection* — a
bot that answers a question correctly at a constant 1.5s still feels like a bot,
because no person behaves that way. Four things close that gap.

**She notices before she answers.** There is a pause before the typing indicator
appears, so the sequence reads as *saw it → started composing* rather than
*received → instantly typed*. `AI_READ_DELAY_MIN_MS` / `AI_READ_DELAY_MAX_MS`.

**Her response times are unpredictable.** After the model answers, a random pause
is added that has nothing to do with how long the model took — because a human's
reply time does not track their CPU load. Occasionally she is simply busy and
takes much longer. `AI_REPLY_JITTER_*`, `AI_BUSY_*`.

The typing indicator is also refreshed every 4s while she thinks. Telegram's
indicator lapses after about five seconds, so without this a slow answer would
make the indicator vanish and the message appear from nowhere.

**A burst of messages is one thought.** People send "hey" / "you around?" /
"quick question" as three messages and expect one answer. She claims the reply
slot atomically with Redis `SET NX`, queues the rest, and answers all of it in
one go. `AI_DEBOUNCE_MS` controls the window; `0` disables it.

Messages sent *while she is still composing* are picked up at the end of the
reply and answered as a **follow-up**, not as a second answer to the same
question. Two bugs caused duplicate replies here and both are fixed:

1. The claim key expired mid-wait (a 2.5s TTL against a 3s burst wait), so a
   message landing in that gap looked like a brand-new turn. The claim now
   outlives the whole window.
2. The queue was drained *before* the model call, so anything sent during
   composing was invisible to the answering invocation. It is now drained again
   after the reply is sent.

`test-duplicate-reply.mjs` covers both: it sends a follow-up mid-compose and
asserts no bubble repeats content from another.

**Short messages sometimes get a reaction instead of words.** With
`AI_REACTION_CHANCE`, a short message that needs no answer gets an emoji
reaction — the way a person just taps 👍 instead of typing "ok".

### The timing budget

Every artificial pause is drawn from **one shared 10s pool** per reply, derived
from the platform limit rather than chosen by feel:

```
60s route cap
-40s model request timeout   (AI_TIMEOUT_MS)
- 7s bubble pacing           (up to 3 inter-bubble delays)
- 3s safety margin           (Redis + Telegram round trips)
= 10s for all human pauses
```

Each stage decrements the same pool, so no combination of random branches can
overrun. This matters: an earlier version gave each pause its own cap, which made
the *worst case the sum of them all* — fine on average, but on a slow model day
the function was killed mid-flight and the user got **no reply at all**.

> If you raise `AI_TIMEOUT_MS`, `AI_MAX_HISTORY`, or the bubble count, lower
> `HUMAN_PAUSE_BUDGET_MS` in [`app/api/telegram/route.ts`](app/api/telegram/route.ts)
> to match. The sum is what matters, not each part.

---

## How conversation memory works

`lib/memory.ts` supports two interchangeable backends behind one interface
(`getHistory`, `appendTurn`, `clearHistory`, `memoryStats` — all async).

**Durable (Upstash Redis)** — used when `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN` are both set. Each chat is one Redis list at
`sky:history:<chatId>`, holding JSON-encoded turns. History is therefore
**shared across every serverless instance and survives cold starts**. Writes are
pipelined into a single request (`RPUSH` + `LTRIM` + `EXPIRE`), and each key
expires after `AI_MEMORY_TTL_DAYS` of silence (default 14) so abandoned
conversations don't accumulate forever. It talks plain `fetch` to Upstash's REST
API, so there is still no runtime dependency beyond Next.js.

**In-memory (`Map<chatId, messages[]>`)** — the fallback, used when Redis isn't
configured (typical for local development) *and* whenever a Redis call fails.
Its limits are real:

- **Vercel functions are ephemeral.** After a cold start the history is empty
  again, so the bot may forget earlier turns. Replies stay correct — it just
  loses context.
- Each warm instance has its own copy of the store.
- Chats idle for 2 hours are evicted, and at most 500 chats are tracked.

### Memory failures never break a reply

Memory is treated as an enhancement, not a correctness requirement. If Redis is
unreachable, misconfigured, or returns a bad payload, the error is logged and the
request continues on the in-memory store — the worst outcome is that she briefly
forgets, never that she stops answering. `/reset` is the one case worth
watching: it clears the in-memory copy first, then `DEL`s the Redis key, and logs
loudly if that delete fails, because it has promised the user their history is
gone.

`/api/health` reports which backend is live:

```json
{ "config": { "memoryBackend": "redis", "maxHistory": 40 },
  "memory":  { "chats": 5, "backend": "redis" } }
```

If `memoryBackend` says `memory` in production, the Redis variables are missing —
set them in Vercel and redeploy.

---

## Project layout

```
app/
  api/telegram/route.ts   Webhook: verify → handle → reply as bubbles
  api/setup/route.ts      Registers the webhook with Telegram
  api/health/route.ts     Config check
  layout.tsx, page.tsx    Minimal status page
lib/
  config.ts               Env vars + Sky's personality (systemPrompt) + tuning knobs
  persona.ts              Splits one reply into bubbles; pacing; human timing
  ai.ts                   AICredits client, with leaked-prompt retry
  telegram.ts             Telegram Bot API client, bubble sends, edits, reactions
  memory.ts               Per-chat history: Redis-backed, with in-memory fallback
scripts/
  test-bubbles.mjs        Splitting logic + live conciseness check
  test-human.mjs          Timing, reaction and back-channel logic
  test-split-delivery.mjs Proves bubbles arrive as separate messages
  test-ai.mjs             Direct AI API smoke test
  test-webhook.mjs        Full webhook round-trip
  test-memory.mjs         Multi-turn memory and /reset
  test-durable-memory.mjs Memory survives a cold start (needs Redis)
  test-debounce.mjs       A burst of messages produces one reply
  test-duplicate-reply.mjs No reply repeats another (needs Redis)
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
Check `/api/health` — if `config.memoryBackend` is `memory`, Redis is not
configured or the variables were added without redeploying, so history lives
only inside one serverless instance and dies at the next cold start. See the
memory section above. Expected locally; not expected in production.

**Everything returns `401 unauthorized` from `/api/telegram`.**
`TELEGRAM_WEBHOOK_SECRET` changed after the webhook was registered. Re-run
`/api/setup` so Telegram receives the new secret.

**She replies with something about "an AI accessed via an API" or JSON output.**
That is the *upstream provider* leaking its own system prompt — not your prompt,
and not a bug in this code. It happens intermittently at their end. `lib/ai.ts`
already detects it and retries up to 3 times. If you still see it, search the
Vercel logs for `[ai] attempt` to confirm the retry fired.

**Her replies are too long / too short, or not splitting into bubbles.**
Tune the thresholds at the top of [`lib/persona.ts`](lib/persona.ts):
`PREFERRED_MAX` (220) controls when a block gets split, `MAX_BUBBLES` (4) caps
how many she sends, and `AI_SPLIT_HINT_CHANCE` controls how often she is asked
to mark her own breaks at all. Verify changes with
`node scripts/test-bubbles.mjs`.

**She sounds generic and lost her personality.**
An `AI_SYSTEM_PROMPT` value is set somewhere and is overriding her persona —
that variable replaces her *entire* prompt. Remove it from Vercel (and
`.env.local`) to restore the built-in personality. Check with:

```bash
vercel env ls production | grep AI_SYSTEM_PROMPT
```

## Security notes

- `TELEGRAM_WEBHOOK_SECRET` is the only thing preventing a stranger from using
  your API credits. Always set it in production.
- `/api/setup` is open when `SETUP_KEY` is unset. It only registers a webhook
  pointing at your own deployment, but setting a key is still wise.
- Secrets live only in environment variables and are never logged or returned.
- Anyone who finds your bot on Telegram can use your credits. Set
  `ALLOWED_CHAT_IDS` (your chat ID, from `/whoami`) to restrict her to chosen
  chats; unset, she is open to everyone. A typo'd value blocks everyone rather
  than quietly opening to strangers — on purpose.

---

## Further reading

| Document | What it covers |
| --- | --- |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Day-to-day running: health checks, redeploying, rotating secrets, tuning her behaviour, troubleshooting. |
| [docs/API DOCUMENTATION.md](docs/API%20DOCUMENTATION.md) | The AICredits API reference and model name. |
