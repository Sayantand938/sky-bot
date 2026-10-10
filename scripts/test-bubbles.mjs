/**
 * Tests the reply-splitting logic in lib/persona.ts.
 *
 * Two layers:
 *   1. Pure logic checks on splitIntoBubbles (offline, deterministic).
 *   2. A live check that real model replies stay short and split naturally.
 *
 * Run:  node scripts/test-bubbles.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

// ---------------------------------------------------------------------------
// Import the TypeScript module by compiling it on the fly with esbuild-free
// trickery: node can't import .ts directly, so we transpile a copy.
//
// persona.ts imports its tuning values from ./config, so both files are compiled
// together — compiling persona alone produces an import that cannot resolve in
// the temp directory.
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(resolve(tmpdir(), 'persona-'));
const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
const res = spawnSync(
  process.execPath,
  [tsc, resolve(root, 'lib/persona.ts'), resolve(root, 'lib/config.ts'),
   '--outDir', tmp, '--module', 'esnext',
   '--target', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck'],
  { encoding: 'utf8' },
);
if (res.status !== 0) {
  console.error('✖ could not compile lib/persona.ts');
  console.error(res.stdout || '', res.stderr || '');
  process.exit(1);
}

// tsc leaves relative imports extensionless ('./config'), but Node's ESM loader
// requires an explicit '.js'. Rather than add a bundler just for a test, rewrite
// the specifier in the emitted file.
{
  const emitted = resolve(tmp, 'persona.js');
  const source = readFileSync(emitted, 'utf8').replace(
    /from ['"]\.\/([A-Za-z0-9_-]+)['"]/g,
    "from './$1.js'",
  );
  writeFileSync(emitted, source);
}

const { splitIntoBubbles, bubbleDelayMs } = await import(
  `file://${resolve(tmp, 'persona.js').replace(/\\/g, '/')}`
);

// ---------------------------------------------------------------------------
// 1. Pure logic
// ---------------------------------------------------------------------------
let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✔ ${name}`);
  } else {
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

console.log('=== splitting logic ===');

// Blank-line breaks become separate bubbles.
const two = splitIntoBubbles("Oh nice, congrats!\n\nWhat are you doing to celebrate?");
check('blank line -> 2 bubbles', two.length === 2, `got ${two.length}: ${JSON.stringify(two)}`);

// A single short line stays a single bubble.
const one = splitIntoBubbles('Yeah, totally.');
check('short reply -> 1 bubble', one.length === 1, `got ${one.length}`);

// Markdown is stripped (Telegram shows it literally).
const md = splitIntoBubbles('That is **great** news and `very` cool.');
check('markdown stripped', !/[*`]/.test(md.join(' ')), JSON.stringify(md));

// Bullet markers are removed.
const bullets = splitIntoBubbles('Here you go:\n- first\n- second\n- third');
check('bullet markers stripped', !/^\s*-\s/m.test(bullets.join('\n')), JSON.stringify(bullets));

// A long single paragraph is broken at sentence boundaries.
const long =
  'So here is the thing about that. You want to start small and stay consistent. ' +
  'Most people burn out because they try to do everything at once. Pick one thing, ' +
  'do it for two weeks, and then add the next. That is genuinely it.';
check('test paragraph is actually long enough', long.length > 220, `len ${long.length}`);
const longOut = splitIntoBubbles(long);
check('long paragraph -> multiple bubbles', longOut.length > 1, `got ${longOut.length}`);
check(
  'long paragraphs broken into text-sized bubbles',
  longOut.every((b) => b.length <= 260),
  `lengths: ${longOut.map((b) => b.length).join(',')}`,
);

// A reply that is already short must NOT be split up.
const alreadyShort = 'Yeah, sounds good to me.';
check('short reply not split', splitIntoBubbles(alreadyShort).length === 1);

// Never more than 4 bubbles, no matter how rambling.
const rambling = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1} about things.`).join(
  '\n\n',
);
const capped = splitIntoBubbles(rambling);
check('bubble count capped at 4', capped.length <= 4, `got ${capped.length}`);

// Every bubble must respect Telegram's hard limit.
const huge = 'word '.repeat(3000); // ~15000 chars, no punctuation
const hugeOut = splitIntoBubbles(huge);
check(
  'no bubble exceeds Telegram 4096 limit',
  hugeOut.every((b) => b.length <= 4096),
  `max ${Math.max(...hugeOut.map((b) => b.length))}`,
);

// Empty / whitespace input yields nothing (route handles it).
check('empty reply -> 0 bubbles', splitIntoBubbles('   ').length === 0);

// No bubble is empty or whitespace-only.
check(
  'no empty bubbles',
  [two, one, longOut, capped, hugeOut].flat().every((b) => b.trim().length > 0),
);

// Delays are bounded so a reply can't stall forever.
const delays = ['a', 'hello there friend', 'x'.repeat(500)].map(bubbleDelayMs);
check(
  'bubble delays bounded (<=2200ms)',
  delays.every((d) => d >= 0 && d <= 2200),
  delays.join(','),
);

console.log('\n=== sample rendering ===');
const demo = splitIntoBubbles(
  "Haha yeah that's fair.\n\nHonestly I'd just go with the simpler option first — you can always change it later.",
);
demo.forEach((b, i) => console.log(`  [bubble ${i + 1}] ${b}`));

// ---------------------------------------------------------------------------
// 2. Live model check — are replies actually short now?
// ---------------------------------------------------------------------------
const apiKey = process.env.AI_API?.trim();
if (!apiKey) {
  console.log('\n(no AI_API set — skipping the live model check)');
} else {
  console.log('\n=== live model check (is she concise?) ===');

  const sys = (
    await import(`file://${resolve(tmp, 'persona.js').replace(/\\/g, '/')}`)
  ) && null;

  // Pull the real system prompt out of lib/config.ts the same way.
  const cfgTmp = mkdtempSync(resolve(tmpdir(), 'cfg-'));
  spawnSync(
    process.execPath,
    [tsc, resolve(root, 'lib/config.ts'), '--outDir', cfgTmp, '--module', 'esnext',
     '--target', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck'],
    { encoding: 'utf8' },
  );
  const { systemPrompt } = await import(
    `file://${resolve(cfgTmp, 'config.js').replace(/\\/g, '/')}`
  );

  const base = (process.env.AI_BASE_URL?.trim() || 'https://api.aicredits.in/v1').replace(/\/+$/, '');
  const model = process.env.AI_MODEL?.trim() || 'deepseek/deepseek-v4.1-flash';

  const probes = [
    "hey what's up?",
    'can you help me plan my week?',
    'what should I have for dinner',
  ];

  let totalLen = 0;
  let totalBubbles = 0;

  for (const p of probes) {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: p },
        ],
        temperature: 0.8,
        max_tokens: 400,
      }),
    });
    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() ?? '(no reply)';
    const bubbles = splitIntoBubbles(raw);
    totalLen += raw.length;
    totalBubbles += bubbles.length;

    console.log(`\n  Q: ${p}`);
    bubbles.forEach((b, i) => console.log(`   ${i + 1}. ${b}`));
    console.log(`   -> ${bubbles.length} bubble(s), ${raw.length} chars`);

    if (raw.length > 900) {
      console.log('   ⚠ reply is long for a casual chat');
    }
  }

  const avg = Math.round(totalLen / probes.length);
  console.log(`\n  average reply: ${avg} chars over ${(totalBubbles / probes.length).toFixed(1)} bubbles`);
  check('average reply under 700 chars', avg < 700, `avg ${avg}`);

  if (avg >= 700) failures += 0;
}

console.log(
  failures === 0
    ? '\n✔ ALL BUBBLE CHECKS PASSED'
    : `\n✖ ${failures} CHECK(S) FAILED`,
);
process.exitCode = failures === 0 ? 0 : 1;
