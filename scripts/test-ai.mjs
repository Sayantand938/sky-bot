/**
 * Smoke-tests the AICredits endpoint with your key, independent of Telegram.
 *
 *   node scripts/test-ai.mjs
 *
 * Reads AI_API / AI_BASE_URL / AI_MODEL from .env.local, then .env.
 * Prints the model's reply, or the raw error body if the call fails.
 */

import { readFileSync, existsSync } from 'node:fs';
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

const apiKey = process.env.AI_API?.trim();
const baseUrl = (process.env.AI_BASE_URL?.trim() || 'https://api.aicredits.in/v1').replace(/\/+$/, '');
const model = process.env.AI_MODEL?.trim() || 'deepseek/deepseek-v4.1-flash';

if (!apiKey) {
  console.error('✖ AI_API is not set in .env.local or .env');
  process.exit(1);
}

console.log(`→ POST ${baseUrl}/chat/completions`);
console.log(`→ model: ${model}`);
console.log(`→ key:   ${apiKey.slice(0, 12)}…${apiKey.slice(-4)} (${apiKey.length} chars)\n`);

const started = Date.now();
let response;
try {
  response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a friendly assistant. Reply briefly.' },
        { role: 'user', content: 'Say hello and tell me in one short sentence what you are.' },
      ],
      temperature: 0.7,
      max_tokens: 128,
      stream: false,
    }),
  });
} catch (error) {
  console.error('✖ Network failure:', error.message);
  process.exit(1);
}

const raw = await response.text();
const elapsed = Date.now() - started;

if (!response.ok) {
  console.error(`✖ HTTP ${response.status} after ${elapsed}ms`);
  console.error(raw.slice(0, 1200));
  process.exit(1);
}

let data;
try {
  data = JSON.parse(raw);
} catch {
  console.error('✖ Response was not JSON:');
  console.error(raw.slice(0, 1200));
  process.exit(1);
}

const text = data?.choices?.[0]?.message?.content?.trim();
if (!text) {
  console.error('✖ No completion text. Full payload:');
  console.error(JSON.stringify(data, null, 2).slice(0, 1200));
  process.exit(1);
}

console.log(`✔ Reply in ${elapsed}ms:\n`);
console.log(text);
console.log(`\nUsage: ${JSON.stringify(data.usage ?? {})}`);
