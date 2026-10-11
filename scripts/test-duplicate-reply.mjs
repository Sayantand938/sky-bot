/**
 * Regression test for the duplicate-reply bug.
 *
 * The bug: a message sent while she was still composing claimed a fresh reply
 * slot and produced a second, near-identical answer to the same question. Two
 * causes were fixed:
 *
 *   1. The debounce claim expired mid-wait (key TTL 2.5s vs a 3s burst wait), so
 *      a message landing in that gap looked like a new turn.
 *   2. The burst queue was drained before the model call, so anything sent
 *      during composing was never seen by the answering invocation.
 *
 * This test fires an initial message, then a follow-up DURING the compose
 * window, and asserts she does not answer the same thing twice.
 *
 * Run:  node scripts/test-duplicate-reply.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, '.env'));

const APP_PORT = 3191;
const FAKE_TG_PORT = 3192;
const SECRET = 'duplicate-test-secret';

// Fresh chat per run, so a previous run's Redis keys cannot interfere.
const CHAT_ID = 717_000 + Math.floor(Math.random() * 9_000);

const replies = [];
let lastReplyAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (method === 'sendMessage' && payload.text) {
      replies.push(payload.text);
      lastReplyAt = Date.now();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { message_id: replies.length + 1, date: Date.now() } }));
  });
});

function waitForServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/telegram`);
        if (r.ok) return res();
      } catch {
        /* not up */
      }
      if (Date.now() > deadline) return rej(new Error('server never came up'));
      setTimeout(tick, 500);
    };
    tick();
  });
}

let app;
let messageId = 800;

async function post(text) {
  await fetch(`http://127.0.0.1:${APP_PORT}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: ++messageId,
      message: {
        message_id: messageId,
        from: { id: CHAT_ID, is_bot: false, first_name: 'Dup' },
        chat: { id: CHAT_ID, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }),
  });
}

try {
  if (!existsSync(resolve(root, '.next'))) {
    console.error('✖ No build. Run `npm run build` first.');
    process.exit(1);
  }

  await new Promise((r) => fakeTelegram.listen(FAKE_TG_PORT, '127.0.0.1', r));
  app = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT)],
    {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${FAKE_TG_PORT}`,
      },
    },
  );

  await waitForServer(APP_PORT);
  console.log('✔ app up\n');

  // Message 1 opens a turn. Message 2 arrives well after the 2.5s debounce
  // window but while she is still composing — the exact gap that previously
  // produced a second full answer.
  console.log('→ message 1');
  const first = post('what should I have for dinner tonight');
  await sleep(4000);
  console.log('→ message 2 (sent mid-compose, after the debounce window)');
  const second = post('also I have chicken and rice in the fridge');
  await Promise.all([first, second]);

  // Wait for the conversation to settle.
  //
  // Two phases, because a single settle check can fire before anything arrives
  // when the model is slow: first wait for at least one reply, then wait for the
  // bubbles to stop coming. A hard overall deadline bounds both.
  const overall = Date.now() + 60000;
  while (Date.now() < overall && replies.length === 0) await sleep(500);

  if (replies.length === 0) {
    console.error('✖ no reply arrived within 60s — the AI call likely failed.');
    process.exitCode = 1;
  } else {
    while (Date.now() < overall) {
      if (Date.now() - lastReplyAt > 7000) break;
      await sleep(500);
    }
  }

  console.log(`\n--- outbound messages (${replies.length}) ---`);
  replies.forEach((t, i) => console.log(`  ${i + 1}. ${t.replace(/\n/g, ' / ')}`));

  // With the typo gag gone there are no edit pairs to collapse, so every
  // sendMessage is one logical bubble.
  const bubbles = replies.map((t) => t.trim());

  // The failure signature: the same question answered twice, i.e. two bubbles
  // that say the same thing.
  //
  // This is the whole point of the test, and it is measured on content — not on
  // a bubble count. An earlier version capped the count at MAX_BUBBLES (4),
  // which was wrong: two unanswered messages are two turns, so she may
  // legitimately send up to eight bubbles, and the cap measured the splitter
  // rather than duplication.
  const normalize = (b) =>
    b
      .toLowerCase()
      .replace(/[^a-z ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const normalized = bubbles.map(normalize).filter((b) => b.length > 12);
  let duplicates = 0;
  const duplicatePairs = [];
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      // Exact repeats, or one bubble containing the other wholesale — either
      // means the same thing was said twice.
      if (normalized[i] === normalized[j] || normalized[i].includes(normalized[j]) || normalized[j].includes(normalized[i])) {
        duplicates += 1;
        duplicatePairs.push([bubbles[i], bubbles[j]]);
      }
    }
  }

  console.log(`\nno duplicated content:            ${duplicates === 0 ? '✔ yes' : `✖ no (${duplicates} pair(s))`}`);
  if (duplicates > 0) {
    for (const [a, b] of duplicatePairs) {
      console.log(`   A: ${a}`);
      console.log(`   B: ${b}`);
    }
  }
  console.log(`replied at all:                   ${replies.length > 0 ? '✔ yes' : '✖ no'}`);

  const pass = duplicates === 0 && replies.length > 0;
  process.exitCode = pass ? 0 : 1;
  console.log(`\n${pass ? '✔ NO DUPLICATE REPLIES' : '✖ DUPLICATE REPLY DETECTED'}`);
} catch (error) {
  console.error('✖ harness error:', error.message);
  process.exitCode = 1;
} finally {
  if (app) app.kill();
  fakeTelegram.close();
  await sleep(300);
}
