# Next Steps — Getting your bot live

**Status right now:** the bot is built and fully tested. It is **not deployed**,
and the Telegram webhook is **not registered** (`getWebhookInfo` returns an empty
`url`). If you message [@sky_2026_10_08_bot](https://t.me/sky_2026_10_08_bot)
today, it will stay silent.

Everything below takes about **10 minutes**. Steps 1–5 are required; the rest is
optional.

---

## What already works (verified, no action needed)

| Check | Result |
| --- | --- |
| `npm run build` | ✅ passes, all 3 API routes dynamic |
| `npm run typecheck` | ✅ passes |
| AI replies | ✅ live, ~1.7s via `deepseek/deepseek-v4.1-flash` |
| Webhook round-trip | ✅ real AI answer end-to-end |
| Conversation memory + `/reset` | ✅ both pass |
| Bot token | ✅ live: `@sky_2026_10_08_bot` |
| Bad-caller rejection | ✅ returns HTTP 401 |

The only missing pieces are deployment and webhook registration — both need a
public URL that doesn't exist yet.

---

## Step 0 — Prerequisite: install the tools you'll need

You currently have **Node v22.18.0** and **npm 11.6.2** ✅, but **no git repo**,
**no Vercel CLI**, and **no tunnel tool**. Pick one path:

- **Path A (GitHub + dashboard)** — needs a GitHub account and git. No CLI install.
- **Path B (Vercel CLI)** — needs `npm i -g vercel`. Faster, no GitHub needed.

---

## Step 1 — Put the code somewhere Vercel can reach

### Path A — GitHub (recommended)

The folder is **not a git repository yet**, so initialise it:

```bash
cd D:\coding\telegram-bot
git init
git add .
git commit -m "Telegram AI bot"
```

> ⚠️ **Before you commit, confirm your secrets are excluded.** Run
> `git status` and check the staged list:
>
> - `.env` and `.env.local` **must NOT appear** — those hold your live token and
>   AI key. (Verified: `.gitignore` excludes both.)
> - `.env.example` **should appear** — that's the empty template, safe to commit.
>
> If `.env` or `.env.local` show up, **stop** and do not push.

Then create an empty repo on GitHub and push:

```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

### Path B — Vercel CLI

```bash
cd D:\coding\telegram-bot
npm i -g vercel
vercel login
vercel          # links/creates the project (accept the defaults)
vercel --prod   # deploy to production
```

> When asked about settings, Vercel auto-detects Next.js. Accept the defaults.

---

## Step 2 — Add the environment variables

**This is the step people most often get wrong.** The bot cannot run without
`TELEGRAM_BOT_TOKEN` and `AI_API`.

Copy these four values **from [`.env.local`](.env.local)**, which is gitignored —
the secrets are deliberately not written into this document, because this repo is
public on GitHub:

| Variable | Where to get it |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | `.env.local` |
| `TELEGRAM_WEBHOOK_SECRET` | `.env.local` |
| `AI_API` | `.env.local` |
| `SETUP_KEY` | `.env.local` |

Open `.env.local` in a text editor and copy each value across.

**In the dashboard:** Project → **Settings** → **Environment Variables** → add
each one → apply to **Production, Preview, and Development**.

**With the CLI:** `vercel env add TELEGRAM_BOT_TOKEN` (repeat per variable), or
add them in the dashboard after the first deploy.

> `AI_BASE_URL` and `AI_MODEL` are optional — the defaults
> (`https://api.aicredits.in/v1` and `deepseek/deepseek-v4.1-flash`) already match
> your `API DOCUMENTATION.md`.

---

## Step 3 — Deploy

```bash
vercel --prod
```

…or click **Deploy** in the Vercel dashboard. Wait for it to finish, then note
your URL, e.g. `https://telegram-bot-abc123.vercel.app`.

> **If you added variables after deploying, redeploy.** Environment changes only
> take effect on a new deployment.

---

## Step 4 — Confirm the configuration is detected

Open this in a browser:

```
https://<your-app>.vercel.app/api/health
```

You want to see **`"ready": true`** and all four `checks` as `true`:

```json
{
  "ok": true,
  "ready": true,
  "checks": {
    "TELEGRAM_BOT_TOKEN": true,
    "TELEGRAM_WEBHOOK_SECRET": true,
    "AI_API": true,
    "SETUP_KEY": true
  }
}
```

If `ready` is `false`, the output tells you exactly which variable is missing.
Fix it in Step 2 and redeploy.

---

## Step 5 — Register the webhook (the step that makes it live)

Open this URL **once** — this is what fills in that empty `url`:

```
https://<your-app>.vercel.app/api/setup?key=<SETUP_KEY>
```

Replace `<SETUP_KEY>` with the value from `.env.local`.

Expected response:

```json
{
  "ok": true,
  "bot": { "username": "sky_2026_10_08_bot", "name": "Sky" },
  "webhook": "https://<your-app>.vercel.app/api/telegram",
  "secretTokenSet": true
}
```

Re-run this any time your domain changes.

---

## Step 6 — Talk to your bot

Open [t.me/sky_2026_10_08_bot](https://t.me/sky_2026_10_08_bot) and send:

```
/start
```

then:

```
Hello! What can you do?
```

You should get a real AI reply within a couple of seconds. Try the commands:

| Command | What it does |
| --- | --- |
| `/start` | Greeting |
| `/help` | Lists commands |
| `/reset` | Forgets the conversation |
| `/whoami` | Shows your chat ID |

That's it — **the bot is live.**

---

## If something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| Bot never replies | Webhook not registered → redo **Step 5**. Also check the `info.last_error_message` field in the `/api/setup` response. |
| `{"ok":false,"error":"unauthorized"}` from `/api/setup` | Wrong or missing `?key=` → use the `SETUP_KEY` value exactly. |
| `⚠️ The AI API key was rejected.` | `AI_API` is wrong or you changed it without redeploying. |
| `⚠️ Could not reach the AI service.` | Transient. Retry. If it persists, check your AICredits balance. |
| `409 Conflict` on registration | Another webhook or a polling process is attached. `/api/setup` overwrites it — just re-run it. |
| Bot forgets earlier messages | Expected after idle: Vercel functions are ephemeral. See "Memory" below. |
| `ready: false` | A variable is missing or was added without a redeploy. |

---

## Optional, but worth knowing

### Test locally before deploying

Telegram can't reach `localhost`, so you need a tunnel:

```bash
npm run dev
npx localtunnel --port 3000     # gives you a public https URL
```

Then open `https://<your-tunnel>.loca.lt/api/setup?key=<SETUP_KEY>`.
Locally the app derives its own origin, so this points the webhook at your
tunnel automatically.

### Re-run the verification suite any time

```bash
node scripts/test-ai.mjs        # calls the AI API directly
node scripts/test-webhook.mjs   # full round-trip against a fake Telegram
node scripts/test-memory.mjs    # multi-turn memory and /reset
```

These also exist as `npm run test:ai`, `npm run test:webhook`, and
`npm run test:memory`. If those fail with **`'node' is not recognized`**, that's
a PATH quirk of your terminal, not a code problem — use the `node scripts/...`
form above, which always works.

`test:webhook` requires a build first (`npm run build`) and fails if the bot only
returns an error notice, so a broken key cannot produce a false pass.

### Memory resets on cold starts

Vercel functions are ephemeral — after idling, the bot forgets earlier turns.
Replies stay correct, it just loses context. To make memory durable, replace
[`lib/memory.ts`](lib/memory.ts) with Upstash Redis (free tier, REST API, works
from serverless with plain `fetch`). Keep the same three exports —
`getHistory`, `appendTurn`, `clearHistory` — and nothing else changes.

### Lock the bot to yourself

**Anyone who finds the bot can spend your AICredits.** There's no allow-list. To
add one, edit `handleMessage` in [`app/api/telegram/route.ts`](app/api/telegram/route.ts)
and return early unless `message.from?.id` matches your Telegram user ID (get it
from `/whoami`).

---

## Security reminders

1. **Never commit `.env.local`.** It holds your live bot token and AI key.
2. **`TELEGRAM_WEBHOOK_SECRET` is what protects your credits** — it's the only
   thing stopping a stranger from POSTing to your endpoint and billing you. It's
   already set; keep it secret.
3. **If a token ever leaks**, send `/revoke` to [@BotFather](https://t.me/BotFather),
   then update `TELEGRAM_BOT_TOKEN` and re-run Step 5.

---

## Quick checklist

- [ ] **Step 0** — git installed, or `npm i -g vercel`
- [ ] **Step 1** — code pushed to GitHub, or `vercel` linked
- [ ] **Step 2** — all 4 environment variables added in Vercel
- [ ] **Step 3** — deployed
- [ ] **Step 4** — `/api/health` shows `"ready": true`
- [ ] **Step 5** — `/api/setup` returned `"ok": true`
- [ ] **Step 6** — bot replies on Telegram ✅

Full reference: [`README.md`](README.md)
