/**
 * Tests the human-texture logic added in Tiers A and B.
 *
 * These helpers take an injectable random function, so a fixed value stands in
 * for Math.random and the assertions are exact rather than statistical. There is
 * no network and no model call, so this runs in milliseconds.
 *
 * The persona helpers are re-implemented nowhere: this imports the real module
 * through the TypeScript path-alias-aware loader that Next itself uses, so the
 * tests exercise the same code the bot runs.
 *
 * Run:  node scripts/test-human.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * The helpers live in TypeScript with extensionless relative imports, which Node
 * cannot resolve directly. Rather than duplicate the logic here (which would
 * test a copy, not the real thing) we transpile the two modules in-memory with
 * the TypeScript compiler and evaluate them.
 */
const driver = `
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = ${JSON.stringify(root)};

// Mirror how the app and the other test scripts see configuration: read the env
// files first, so assertions below test the configured values rather than the
// built-in fallbacks.
for (const file of ['.env.local', '.env']) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) continue;
  for (const line of fs.readFileSync(full, 'utf8').split(/\\r?\\n/)) {
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

const cache = new Map();

// Minimal require hook: transpile .ts on demand and resolve extensionless
// relative imports to the sibling .ts file.
function loadTs(file) {
  const full = file.endsWith('.ts') ? file : file + '.ts';
  if (cache.has(full)) return cache.get(full).exports;

  const source = fs.readFileSync(full, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const mod = { exports: {} };
  cache.set(full, mod);
  const dir = path.dirname(full);
  const localRequire = (spec) => {
    if (spec.startsWith('.')) return loadTs(path.resolve(dir, spec));
    return require(spec);
  };
  new Function('exports', 'require', 'module', '__filename', '__dirname', js)(
    mod.exports, localRequire, mod, full, dir,
  );
  return mod.exports;
}

const persona = loadTs(path.join(root, 'lib/persona.ts'));
const config = loadTs(path.join(root, 'lib/config.ts'));

function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

const out = {};

{
  const samples = [];
  for (const r of [0, 0.25, 0.5, 0.75, 1]) samples.push(persona.readDelayMs(() => r));
  out.readMin = Math.min(...samples);
  out.readMax = Math.max(...samples);
}

{
  const many = [];
  for (let i = 0; i < 200; i += 1) many.push(persona.replyDelayMs());
  out.jitterDistinct = new Set(many).size;
  out.jitterCap = persona.replyDelayMs({ random: () => 1, budgetMs: 5000 });
  out.jitterNeverNegative = many.every((v) => v >= 0);
}

{
  out.splitHintChance = config.splitHintChance();
  out.hintLine = config.bubbleHintLine();
  out.hintBrevity = /blank line/i.test(out.hintLine);
  out.hintCap = /at most 2 or 3/i.test(out.hintLine);
}

{
  out.reactShort = persona.pickReaction('nice one', seq([0, 0]));
  out.reactQuestion = persona.pickReaction('are you around?', seq([0, 0]));
  out.reactLong = persona.pickReaction('a'.repeat(120), seq([0, 0]));
}

{
  out.backLong = persona.pickBackchannel('x'.repeat(200), seq([0, 0]));
  out.backShort = persona.pickBackchannel('short reply', seq([0, 0]));
}

{
  out.backchannelMin = persona.backchannelDelayMs(() => 0);
  out.backchannelMax = persona.backchannelDelayMs(() => 1);
}

{
  out.debounceMs = config.debounceMs();
  out.reactionChance = config.reactionChance();
  out.busyChance = config.busyChance();
  out.maxHistory = config.maxHistory();
}

console.log(JSON.stringify(out));
`;

let out;
try {
  const result = spawnSync(process.execPath, ['-e', driver], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error('✖ could not load lib/persona.ts:\n', (result.stderr || '').slice(0, 2000));
    process.exit(1);
  }
  out = JSON.parse(result.stdout.trim().split('\n').pop());
} catch (error) {
  console.error('✖ harness error:', error.message);
  process.exit(1);
}

console.log('read delay (Tier A)');
check('read delay is never negative', out.readMin >= 0, `min=${out.readMin}`);
check('read delay stays within the configured ceiling', out.readMax <= 2600, `max=${out.readMax}`);
check('read delay varies with randomness', out.readMin < out.readMax);

console.log('\nreply jitter (Tier A)');
check('reply jitter is not a constant', out.jitterDistinct > 20, `distinct=${out.jitterDistinct}`);
check('reply jitter is never negative', out.jitterNeverNegative);
check('reply jitter respects the budget cap', out.jitterCap <= 5000, `got=${out.jitterCap}`);

console.log('\nsplit hint (Tier B)');
check('split hint chance is sane', out.splitHintChance >= 0 && out.splitHintChance <= 1, `got=${out.splitHintChance}`);
check('hint asks for blank-line breaks', out.hintBrevity, `got=${JSON.stringify(out.hintLine)}`);
check('hint caps the bubble count', out.hintCap);

console.log('\nreactions (Tier B)');
check('a short statement can get a reaction', typeof out.reactShort === 'string');
check('a question never gets a bare reaction', out.reactQuestion === null);
check('a long message never gets a bare reaction', out.reactLong === null);

console.log('\nback-channel (Tier B)');
check('a long reply may get a back-channel', typeof out.backLong === 'string');
check('a short reply never gets one', out.backShort === null);

console.log('\nback-channel stall (Tier B)');
check('stall is not instant', out.backchannelMin >= 1000, `min=${out.backchannelMin}`);
check('stall is not glacial', out.backchannelMax <= 4000, `max=${out.backchannelMax}`);

console.log('\nconfig plumbing');
check('debounce window is enabled by default', out.debounceMs > 0, `got=${out.debounceMs}`);
check('reaction chance is sane', out.reactionChance > 0 && out.reactionChance <= 0.5, `got=${out.reactionChance}`);
check('busy chance is sane', out.busyChance >= 0 && out.busyChance <= 1, `got=${out.busyChance}`);
check('memory window is still 40', out.maxHistory === 40, `got=${out.maxHistory}`);

console.log(
  `\n${failed === 0 ? '✔ ALL HUMAN-TEXTURE CHECKS PASSED' : `✖ ${failed} CHECK(S) FAILED`} (${passed} passed)`,
);
process.exitCode = failed === 0 ? 0 : 1;
