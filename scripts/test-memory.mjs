/**
 * Proves the bot remembers earlier turns within one warm instance.
 *
 * Sends "My name is Zephyr." then asks "What is my name?" and checks the
 * second reply contains it. Also verifies /reset clears the context.
 *
 * Run:  node scripts/test-memory.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const APP_PORT = 3121;
const FAKE_TG_PORT = 3122;
const SECRET = 'memory-test-secret';

const replies = [];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
let messageId = 100;

async function send(text) {
  const before = replies.length;
  await fetch(`http://127.0.0.1:${APP_PORT}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: ++messageId,
      message: {
        message_id: messageId,
        from: { id: 7, is_bot: false, first_name: 'Mem' },
        chat: { id: 7, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }),
  });
  // Wait for a new outbound message to appear.
  const deadline = Date.now() + 60000;
  while (replies.length === before) {
    if (Date.now() > deadline) throw new Error(`no reply to: ${text}`);
    await sleep(250);
  }
  return replies[replies.length - 1];
}

try {
  if (!existsSync(resolve(root, '.next'))) {
    console.error('✖ No build. Run `npm run build` first.');
    process.exit(1);
  }

  await new Promise((r) => fakeTelegram.listen(FAKE_TG_PORT, '127.0.0.1', r));
  app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(APP_PORT)], {
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
  });

  await waitForServer(APP_PORT);
  console.log('✔ app up\n');

  console.log('→ turn 1: "My name is Zephyr."');
  const r1 = await send('My name is Zephyr. Please remember it.');
  console.log(`   bot: ${r1}\n`);

  console.log('→ turn 2: "What is my name?"');
  const r2 = await send('What is my name?');
  console.log(`   bot: ${r2}\n`);

  const remembered = /zephyr/i.test(r2);
  console.log(`memory across turns: ${remembered ? '✔ PASS (recalled "Zephyr")' : '✖ FAIL (forgot)'}`);

  console.log('\n→ /reset');
  const r3 = await send('/reset');
  console.log(`   bot: ${r3}`);

  console.log('→ turn 3 (after reset): "What is my name?"');
  const r4 = await send('What is my name?');
  console.log(`   bot: ${r4}\n`);

  const forgot = !/zephyr/i.test(r4);
  console.log(`reset cleared history: ${forgot ? '✔ PASS (no longer knows)' : '✖ FAIL (still knows)'}`);

  process.exitCode = remembered && forgot ? 0 : 1;
  console.log(`\n${process.exitCode === 0 ? '✔ ALL MEMORY CHECKS PASSED' : '✖ MEMORY CHECKS FAILED'}`);
} catch (error) {
  console.error('✖ harness error:', error.message);
  process.exitCode = 1;
} finally {
  if (app) app.kill();
  fakeTelegram.close();
  await sleep(300);
}
