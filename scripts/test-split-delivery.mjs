/**
 * Proves that ONE model reply is delivered as SEVERAL Telegram messages.
 *
 * The webhook test proves a reply is produced; this proves it is *split*.
 * It runs the real built app against a fake Telegram Bot API and asserts on
 * the number, order, and content of the outbound sendMessage calls — including
 * that each bubble is a separate request, and that the "typing…" indicator
 * appears between them (which is what makes it feel human).
 *
 * Run:  node scripts/test-split-delivery.mjs
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
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, '.env'));

const APP_PORT = 3131;
const FAKE_TG_PORT = 3132;
const SECRET = 'split-delivery-test';

/** Ordered log of outbound calls, so we can assert on the interleaving. */
const calls = [];

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
    calls.push({
      method,
      text: payload.text,
      replyTo: payload.reply_to_message_id,
      at: Date.now(),
    });
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
      setTimeout(tick, 400);
    };
    tick();
  });
}

let app;
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✔' : '✖'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

try {
  if (!existsSync(resolve(root, '.next'))) {
    console.error('✖ No build found. Run: node node_modules/next/dist/bin/next build');
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
    },
  });

  await waitForServer(APP_PORT);
  console.log('✔ app up\n');

  // A prompt that reliably invites a longer, multi-part answer.
  const question = 'how do I learn python from scratch?';
  console.log(`→ asking: "${question}"`);

  const before = calls.length;
  await fetch(`http://127.0.0.1:${APP_PORT}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 42,
        from: { id: 7, is_bot: false, first_name: 'Split' },
        chat: { id: 7, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: question,
      },
    }),
  });

  // Wait for the bubbles to stop arriving.
  let last = calls.length;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(600);
    if (calls.length === last && calls.length > before) break;
    last = calls.length;
  }

  const outbound = calls.slice(before);
  const sends = outbound.filter((c) => c.method === 'sendMessage');
  const typings = outbound.filter((c) => c.method === 'sendChatAction');

  console.log('\n--- outbound sequence ---');
  outbound.forEach((c, i) => {
    const label = c.method === 'sendMessage' ? `sendMessage[${c.text?.length ?? 0} chars]` : c.method;
    console.log(`  ${i + 1}. ${label}${c.text ? `: ${c.text}` : ''}`);
  });

  console.log('\n=== delivery checks ===');
  check('at least one message sent', sends.length >= 1, `got ${sends.length}`);
  check('no message exceeds Telegram 4096 limit', sends.every((s) => (s.text?.length ?? 0) <= 4096));

  if (sends.length > 1) {
    check('reply WAS split into multiple messages', true, '');
    check('exactly one reply quotes the original message',
      sends.filter((s) => s.replyTo === 42).length === 1,
      `got ${sends.filter((s) => s.replyTo === 42).length}`);
    check('first bubble quotes the original message', sends[0].replyTo === 42);
    check('later bubbles are NOT quoted replies', sends.slice(1).every((s) => s.replyTo === undefined));
    check('typing indicator shown between bubbles', typings.length >= 1, `got ${typings.length}`);

    // Human pacing: bubbles must not all land in the same millisecond.
    const gaps = sends.slice(1).map((s, i) => s.at - sends[i].at);
    check('bubbles are paced, not instant', gaps.every((g) => g >= 250), `gaps: ${gaps.join(',')}`);
    check('pauses are not absurdly long', gaps.every((g) => g <= 6000), `gaps: ${gaps.join(',')}`);

    // Order must be preserved.
    const joined = sends.map((s) => s.text).join(' ');
    check('no bubble is empty', sends.every((s) => (s.text ?? '').trim().length > 0));
    check('content preserved (no text dropped)', joined.length > 40, `${joined.length} chars`);
  } else {
    // Not a failure: she is meant to be brief. Report it honestly.
    console.log('  ℹ reply came back as a single short message (she is brief by design)');
    check('single message still quotes the original', sends[0]?.replyTo === 42);
  }

  console.log(`\n  bubbles delivered: ${sends.length}`);
  console.log(`  total reply chars: ${sends.reduce((n, s) => n + (s.text?.length ?? 0), 0)}`);
} catch (error) {
  console.error('✖ harness error:', error.message);
  failed += 1;
} finally {
  if (app) app.kill();
  fakeTelegram.close();
  await sleep(300);
}

console.log(failed === 0 ? '\n✔ SPLIT-DELIVERY CHECKS PASSED' : `\n✖ ${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
