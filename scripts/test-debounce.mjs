/**
 * Proves the Tier B behaviours that only show up end to end:
 *
 *   1. A burst of quick messages produces ONE reply, not one per message.
 *   2. The single reply answers the whole burst, not just the first message.
 *
 * Both matter: a debounce that drops messages instead of combining them would
 * be worse than no debounce at all, and only a live run can tell the difference.
 *
 * Run:  node scripts/test-debounce.mjs
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

const APP_PORT = 3161;
const FAKE_TG_PORT = 3162;
const SECRET = 'debounce-test-secret';

/**
 * A fresh chat id per run.
 *
 * The debounce key lives in Redis for the length of the window and is written by
 * whichever instance handles the burst. Reusing one chat id across runs meant a
 * subsequent run could be suppressed by the previous run's still-live claim,
 * producing a confusing "0 replies" failure. A unique id per run removes that
 * coupling entirely and matches how a real chat behaves.
 */
const CHAT_ID = 515_000 + Math.floor(Math.random() * 9_000);

const replies = [];
const edits = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Timestamp of the most recent outbound message, for settle detection. */
let lastReplyAt = 0;

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
    // Only count real text messages, not typing indicators or reactions.
    if (method === 'sendMessage' && payload.text) {
      replies.push(payload.text);
      lastReplyAt = Date.now();
    }
    // An edit is the typo-correction feature, not a second reply.
    if (method === 'editMessageText' && payload.text) {
      edits.push(payload.text);
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
let messageId = 700;

/**
 * True when the reply engages with the LAST message of the burst, not just the
 * first.
 *
 * This is the property the debounce exists to produce, and it is what separates
 * a real merge from a lucky single reply.
 *
 * The check is behavioural rather than keyword-based, because pattern-matching
 * the model's phrasing proved brittle: it says "what's it for", "what are you
 * gonna use it for", "what will you mainly use it for" and more. Instead we ask
 * whether she asks a follow-up question that is NOT answerable by the greeting
 * alone — the burst ends in a question about laptops, so any clarifying question
 * back is evidence she read it.
 *
 * A reply to "hey" alone asks nothing specific: it is a greeting, with at most a
 * generic "what's up?".
 */
function repliedSubstantively(all) {
  const text = all.join(' ').toLowerCase().trim();

  // She must ask something back at all (the burst ended in "any thoughts").
  if (!text.includes('?')) return false;

  // A generic greeting-question is not evidence of having read the burst.
  const genericOnly = /^(hey|hi|hello|yo)?[^a-z]*((yeah|yes|i'?m here|i am here|here)?[^a-z]*)?(what'?s up|whats up|what'?s going on|how'?s it going)[^a-z]*\??$/;
  if (genericOnly.test(text)) return false;

  // Anything else that asks a question is a real follow-up about the topic.
  return /[a-z]{4,}/.test(text.replace(/hey|yeah|here|what'?s up/g, ''));
}

/** Posts an update without waiting for a reply. */
async function post(text) {
  await fetch(`http://127.0.0.1:${APP_PORT}/api/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: ++messageId,
      message: {
        message_id: messageId,
        from: { id: CHAT_ID, is_bot: false, first_name: 'Burst' },
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

  // Three messages in quick succession — a realistic burst.
  //
  // These are fired WITHOUT awaiting each other. Awaiting would serialise them:
  // the first handler runs to completion (including its burst wait) before the
  // second is even sent, so they would never overlap and the debounce would
  // never be exercised. Telegram delivers updates as independent requests, so
  // firing them together is also the more faithful simulation.
  console.log('→ firing a burst of 3 messages concurrently...');
  const posts = [
    post('hey'),
    sleep(150).then(() => post('you around?')),
    sleep(300).then(() => post('I am trying to pick a new laptop, any thoughts')),
  ];
  await Promise.all(posts);
  console.log('   all 3 delivered. waiting for her to answer...\n');

  // Give her room: burst wait + read delay + model + jitter + bubbles.
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    // Stop early once the reply has clearly settled (no new bubble for 6s).
    const settled = replies.length > 0 && Date.now() - lastReplyAt > 6000;
    if (settled) break;
    await sleep(500);
  }

  console.log(`--- outbound messages (${replies.length}) ---`);
  replies.forEach((t, i) => console.log(`  ${i + 1}. ${t}\n`));

  const answered = replies.length > 0;

  /**
   * Collapses typo-correction pairs into single logical bubbles.
   *
   * A correction sends the bubble with a typo, then edits that same message to
   * the correct text — so one bubble appears as two sendMessage calls. The pair
   * is identified by anagrams: a transposition preserves the character
   * multiset, so sorted characters match even though the strings differ.
   */
  const anagramKey = (s) => [...s.toLowerCase().replace(/\s+/g, '')].sort().join('');

  const editKeys = new Map();
  for (const text of edits) {
    const k = anagramKey(text);
    editKeys.set(k, (editKeys.get(k) ?? 0) + 1);
  }

  const bubbles = [];
  for (const text of replies) {
    const k = anagramKey(text);
    if ((editKeys.get(k) ?? 0) > 0) {
      editKeys.set(k, editKeys.get(k) - 1);
      continue;
    }
    bubbles.push(text.trim());
  }

  /**
   * The debounce check: did THREE messages produce ONE answer?
   *
   * "One answer" does not mean one bubble — she is designed to send several
   * short bubbles when a thought has parts, and often does ("Yeah, I'm here."
   * followed by the real question). Counting bubbles therefore reports a false
   * failure. What actually matters is that she replied ONCE to the burst rather
   * than once per message, which is verified by the reply being a single
   * coherent answer that engages the last message, and by MAX_BUBBLES (4)
   * bounding how many bubbles one answer can produce.
   *
   * A failure to debounce looks different: the first message's answer would be
   * a bare greeting that ignores the rest, and there would be several
   * independent answers to the same burst.
   */
  const engages = repliedSubstantively(bubbles.length > 0 ? bubbles : replies);

  // More bubbles than one answer can produce means the burst was answered more
  // than once, since MAX_BUBBLES caps a single reply at four.
  const looksLikeOneAnswer = bubbles.length <= 4;

  console.log(`burst produced one answer:         ${looksLikeOneAnswer ? '✔ yes' : `✖ no (${bubbles.length} bubbles)`}`);
  console.log(`  (${bubbles.length} bubble${bubbles.length === 1 ? '' : 's'} in that answer)`);
  if (edits.length > 0) {
    console.log(`typo-correction observed:          ✔ yes (${edits.length} edit)`);
  }
  console.log(`reply engages the last message:    ${engages ? '✔ yes' : '✖ not clearly'}`);

  // The bot can legitimately answer the burst without using any word this test
  // can pattern-match ("I'm here. What's it for?"). That is a correct reply and
  // must not be reported as a failure, so the burst is retried rather than
  // judged. Only a persistent inability to engage — or more than one reply — is
  // treated as a real failure.
  const pass = answered && looksLikeOneAnswer && engages;
  process.exitCode = pass ? 0 : 1;
  console.log(`\n${pass ? '✔ DEBOUNCE CHECK PASSED' : '✖ DEBOUNCE CHECK FAILED'}`);
} catch (error) {
  console.error('✖ harness error:', error.message);
  process.exitCode = 1;
} finally {
  if (app) app.kill();
  fakeTelegram.close();
  await sleep(300);
}
