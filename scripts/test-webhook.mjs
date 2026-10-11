/**
 * End-to-end test of the webhook reply path with NO real Telegram involved.
 *
 *   1. starts the built Next.js server on a spare port
 *   2. intercepts outbound Telegram calls with a local fake Bot API
 *   3. POSTs a realistic Telegram update to /api/telegram
 *   4. asserts the bot called sendMessage with a real AI reply
 *
 * Run:  node scripts/test-webhook.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const nodeBin = process.execPath;

/** Loads .env.local then .env so the harness works without a pre-set shell. */
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, '.env'));

if (!process.env.AI_API?.trim()) {
  console.error('✖ AI_API is not set in .env.local or .env — the bot cannot reply without it.');
  process.exit(1);
}

const APP_PORT = 3111;
const FAKE_TG_PORT = 3112;
const SECRET = 'test-secret-token-abc123';

const captured = { calls: [], messages: [] };
let replyResolve;
const replyReceived = new Promise((r) => {
  replyResolve = r;
});

// ---------------------------------------------------------------------------
// 1. Fake Telegram Bot API
// ---------------------------------------------------------------------------
const fakeTelegram = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      /* ignore */
    }
    captured.calls.push({ method, payload });

    if (method === 'sendMessage') {
      captured.messages.push(payload.text);
      if (replyResolve) replyResolve();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { message_id: 999, date: Date.now() } }));
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function waitForServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/telegram`);
        if (r.ok) return resolvePromise();
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return reject(new Error(`server on ${port} never came up`));
      setTimeout(tick, 500);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
let server;
let app;

try {
  if (!existsSync(resolve(root, '.next'))) {
    console.error('✖ No .next build found. Run `npm run build` first.');
    process.exit(1);
  }

  await new Promise((r) => fakeTelegram.listen(FAKE_TG_PORT, '127.0.0.1', r));
  console.log(`✔ fake Telegram Bot API on :${FAKE_TG_PORT}`);

  // Point the app's Telegram client at the fake server via IPv4 loopback.
  app = spawn(nodeBin, ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT)], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: `test-token`,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TELEGRAM_API_ROOT: `http://127.0.0.1:${FAKE_TG_PORT}`,
      // Tests chat as random IDs; never let a local ALLOWED_CHAT_IDS gate them.
      ALLOWED_CHAT_IDS: '',
      AI_API: process.env.AI_API ?? '',
      AI_BASE_URL: process.env.AI_BASE_URL ?? 'https://api.aicredits.in/v1',
      AI_MODEL: process.env.AI_MODEL ?? 'deepseek/deepseek-v4.1-flash',
    },
  });

  await waitForServer(APP_PORT);
  console.log(`✔ app listening on :${APP_PORT}`);

  // --- Auth check: wrong secret must be rejected ---------------------------
  const bad = await fetch(`http://127.0.0.1:${APP_PORT}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
    body: JSON.stringify({ update_id: 1 }),
  });
  console.log(`✔ wrong secret -> HTTP ${bad.status} ${bad.status === 401 ? '(correctly rejected)' : '(UNEXPECTED)'}`);

  // --- Real message --------------------------------------------------------
  const update = {
    update_id: 2,
    message: {
      message_id: 10,
      from: { id: 42, is_bot: false, first_name: 'Test' },
      chat: { id: 42, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text: 'Hello! In one short sentence, what are you?',
    },
  };

  console.log('\n→ sending a real message through the webhook...');
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': SECRET,
    },
    body: JSON.stringify(update),
  });

  console.log(`✔ webhook responded HTTP ${res.status} in ${Date.now() - started}ms`);
  console.log(`   body: ${await res.text()}`);

  // --- Wait for the outbound reply -----------------------------------------
  const gotReply = await Promise.race([
    replyReceived.then(() => true),
    sleep(60000).then(() => false),
  ]);

  console.log('\n--- outbound Telegram calls ---');
  for (const call of captured.calls) {
    const summary = call.payload.text
      ? `text="${String(call.payload.text).slice(0, 120)}"`
      : JSON.stringify(call.payload).slice(0, 120);
    console.log(`  ${call.method}(${summary})`);
  }

  console.log('\n================ RESULT ================');

  // An error notice is still a sendMessage call, so "a message was sent" is not
  // proof of success. Treat the bot's own ⚠️ prefix as a hard failure, otherwise
  // a broken API key would report PASS.
  const errorNotices = captured.messages.filter((m) => m.startsWith('⚠️'));
  const realReplies = captured.messages.filter((m) => !m.startsWith('⚠️'));

  if (!gotReply || captured.messages.length === 0) {
    console.error('✖ FAIL: the bot never called sendMessage.');
    process.exitCode = 1;
  } else if (realReplies.length === 0) {
    console.error('✖ FAIL: the bot only sent an error notice — no real AI reply.');
    console.error('   This usually means the AI call failed (check AI_API / AI_MODEL).');
    console.log('--------------------------------------------------');
    for (const m of errorNotices) console.log(m);
    console.log('--------------------------------------------------');
    process.exitCode = 1;
  } else {
    console.log('✔ PASS: the bot replied to the Telegram update with a real AI answer.\n');
    console.log('Bot reply:');
    console.log('--------------------------------------------------');
    for (const m of realReplies) console.log(m);
    console.log('--------------------------------------------------');

    const sentTyping = captured.calls.some((c) => c.method === 'sendChatAction');
    console.log(`typing indicator sent: ${sentTyping ? 'yes' : 'no'}`);
    console.log(`reply quoted the user's message: ${
      captured.calls.some((c) => c.method === 'sendMessage' && c.payload.reply_to_message_id === 10)
        ? 'yes'
        : 'no'
    }`);
  }
} catch (error) {
  console.error('✖ test harness error:', error);
  process.exitCode = 1;
} finally {
  if (app) app.kill();
  fakeTelegram.close();
  await sleep(300);
}
