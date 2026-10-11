/**
 * Proves memory is durable across a serverless cold start.
 *
 * This is the test that distinguishes Tier 1 from Tier 0. The existing
 * test-memory.mjs only ever talks to one warm instance, so it passes even when
 * memory is process-local and production forgets everything on a cold start.
 * Here we deliberately kill the app between turns and start a brand new
 * process, which is what a Vercel cold start looks like.
 *
 *   1. turn 1 against instance A
 *   2. hard-kill instance A (all in-process state is now gone)
 *   3. start instance B on the same port
 *   4. ask for the name — a Redis-backed store still knows it
 *
 * Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. Without them it
 * reports SKIPPED rather than passing, so an unconfigured run can never be
 * mistaken for a verified one.
 *
 * Run:  node scripts/test-durable-memory.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

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

const APP_PORT = 3141;
const FAKE_TG_PORT = 3142;
const SECRET = 'durable-memory-test-secret';

// A dedicated chat id, so this test never collides with a real conversation
// or with the other memory test's history.
const CHAT_ID = 987654321;
const MARKER = 'Quicksilver';

if (!process.env.UPSTASH_REDIS_REST_URL?.trim() || !process.env.UPSTASH_REDIS_REST_TOKEN?.trim()) {
  console.log('SKIPPED: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set.');
  console.log('Set them in .env.local to run the durability check.');
  // Exit 0: an unconfigured environment is not a failure. The wording above
  // makes clear this proves nothing, so it cannot be a false pass.
  process.exit(0);
}

const replies = [];
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
    if (method === 'sendMessage' && payload.text) replies.push(payload.text);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { message_id: 1, date: Date.now() } }));
  });
});

/** Clears this chat's history directly through the Redis REST API. */
async function clearRedisHistory() {
  const url = process.env.UPSTASH_REDIS_REST_URL.trim().replace(/\/+$/, '');
  const token = process.env.UPSTASH_REDIS_REST_TOKEN.trim();
  let response;
  try {
    response = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['DEL', `sky:history:${CHAT_ID}`]]),
      cache: 'no-store',
    });
  } catch (error) {
    // A bad URL is a setup mistake, not a memory bug. Say so plainly instead of
    // letting an opaque "fetch failed" bubble up from deep in the harness.
    throw new Error(
      `could not reach the Redis REST endpoint at ${url} (${error.message}).\n` +
        '  Check UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env.local.',
    );
  }
  if (!response.ok) {
    throw new Error(
      `Redis rejected the request with HTTP ${response.status}.\n` +
        '  Check UPSTASH_REDIS_REST_TOKEN in .env.local.',
    );
  }
}

function waitForServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/telegram`);
        if (r.ok) return res();
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) return rej(new Error('server never came up'));
      setTimeout(tick, 500);
    };
    tick();
  });
}

function startApp() {
  return spawn(
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
        // Tests chat as random IDs; never let a local ALLOWED_CHAT_IDS gate them.
        ALLOWED_CHAT_IDS: '',
      },
    },
  );
}

let messageId = 500;

async function send(text) {
  const before = replies.length;
  await fetch(`http://127.0.0.1:${APP_PORT}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: ++messageId,
      message: {
        message_id: messageId,
        from: { id: CHAT_ID, is_bot: false, first_name: 'Durable' },
        chat: { id: CHAT_ID, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }),
  });
  const deadline = Date.now() + 60000;
  while (replies.length === before) {
    if (Date.now() > deadline) throw new Error(`no reply to: ${text}`);
    await sleep(250);
  }
  return replies[replies.length - 1];
}

/** Kills the app and waits for the port to actually stop answering. */
async function stopApp(app) {
  app.kill();
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${APP_PORT}/api/telegram`);
    } catch {
      return; // port is free
    }
    await sleep(300);
  }
}

let app;
let passed = false;

try {
  if (!existsSync(resolve(root, '.next'))) {
    console.error('✖ No build. Run `npm run build` first.');
    process.exit(1);
  }

  await new Promise((r) => fakeTelegram.listen(FAKE_TG_PORT, '127.0.0.1', r));
  await clearRedisHistory();

  // --- Instance A ---------------------------------------------------------
  console.log('→ starting instance A');
  app = startApp();
  await waitForServer(APP_PORT);
  console.log('✔ instance A up\n');

  console.log(`→ turn 1: "My name is ${MARKER}. Please remember it."`);
  const r1 = await send(`My name is ${MARKER}. Please remember it.`);
  console.log(`   bot: ${r1}\n`);

  // Give the write a moment to land; appendTurn is awaited before the reply is
  // sent, so this is only belt-and-braces against a slow REST round trip.
  await sleep(1000);

  // --- Cold start ---------------------------------------------------------
  console.log('→ killing instance A (simulating a Vercel cold start)');
  await stopApp(app);
  app = null;
  console.log('✔ instance A is gone — all in-process state destroyed\n');

  console.log('→ starting instance B (fresh process, empty in-memory store)');
  app = startApp();
  await waitForServer(APP_PORT);
  console.log('✔ instance B up\n');

  console.log('→ turn 2 on instance B: "What is my name?"');
  const r2 = await send('What is my name?');
  console.log(`   bot: ${r2}\n`);

  const survived = new RegExp(MARKER, 'i').test(r2);
  console.log(
    `durable across cold start: ${
      survived ? '✔ PASS (recalled after restart)' : '✖ FAIL (forgot — memory is not durable)'
    }`,
  );

  // A cold start that forgets proves the store is still in-process. Report it.
  passed = survived;
  process.exitCode = passed ? 0 : 1;
  console.log(
    `\n${passed ? '✔ DURABILITY CHECK PASSED' : '✖ DURABILITY CHECK FAILED (is Redis configured and reachable?)'}`,
  );
} catch (error) {
  console.error('✖ harness error:', error.message);
  process.exitCode = 1;
} finally {
  if (app) app.kill();
  fakeTelegram.close();
  await sleep(300);
}
