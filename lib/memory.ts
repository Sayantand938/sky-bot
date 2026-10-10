import { maxHistory, memoryTtlSeconds, redisConfigured, redisToken, redisUrl } from './config';

/**
 * Per-chat conversation memory.
 *
 * Two backends, one interface:
 *
 *  - **Upstash Redis** (when UPSTASH_REDIS_REST_URL and _TOKEN are set).
 *    Durable and shared across every serverless instance, so history survives
 *    cold starts and two concurrent instances agree on what was said.
 *
 *  - **In-memory Map** (fallback). Used when Redis is not configured — notably
 *    local development — and also as the degradation path when Redis errors.
 *    It has the limits described below, which is why Redis is preferred.
 *
 * Fail-soft is a deliberate policy: memory is an enhancement, not a
 * correctness requirement. If Redis is unreachable we log and continue with
 * whatever context we have rather than showing the user an error. The worst
 * outcome is that she briefly forgets; she never stops replying.
 *
 * In-memory caveats (only apply on the fallback path):
 *  - Serverless instances are ephemeral, so a cold start begins empty.
 *  - Each warm instance keeps its own copy.
 */

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type Store = Map<number, ChatMessage[]>;

// Attach the in-memory store to globalThis so Next.js hot reload in `next dev`
// does not create a brand new store on every recompile.
const globalForMemory = globalThis as unknown as { __tgBotMemory?: Store };

const store: Store = globalForMemory.__tgBotMemory ?? new Map<number, ChatMessage[]>();
globalForMemory.__tgBotMemory = store;

/** Idle chats are dropped so a long-lived instance cannot grow without bound. */
const CHAT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_TRACKED_CHATS = 500;

const lastSeen = new Map<number, number>();

/** Redis key for one chat's transcript. */
function historyKey(chatId: number): string {
  return `sky:history:${chatId}`;
}

/**
 * Rounds a message window down to an even number.
 *
 * Turns are always appended as a user+assistant pair, so an odd window would
 * let LTRIM drop the leading user message and leave the transcript starting
 * with an unprompted reply — which reads to the model as a malformed
 * conversation. An even window cannot do that. `AI_MAX_HISTORY=1` is the one
 * value that cannot be made even, so it is raised to 2 rather than dropped.
 */
function evenWindow(limit: number): number {
  if (limit <= 0) return 0;
  const even = limit - (limit % 2);
  return even > 0 ? even : 2;
}

// ---------------------------------------------------------------------------
// Upstash REST transport
// ---------------------------------------------------------------------------

type RedisCommand = (string | number)[];

/**
 * Sends a pipeline of commands to Upstash in a single HTTP request.
 *
 * The REST API accepts a JSON array of command arrays. Returns one
 * `{ result }` entry per command. Throws on transport or protocol failure so
 * the callers below can decide how to degrade.
 */
async function pipeline(commands: RedisCommand[]): Promise<Array<{ result?: unknown; error?: string }>> {
  const url = redisUrl();
  const token = redisToken();
  if (!url || !token) throw new Error('redis not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`redis HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) throw new Error('redis returned a non-array payload');
    return payload as Array<{ result?: unknown; error?: string }>;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

function evictStale(): void {
  const now = Date.now();
  for (const [chatId, seenAt] of lastSeen) {
    if (now - seenAt > CHAT_TTL_MS) {
      store.delete(chatId);
      lastSeen.delete(chatId);
    }
  }
  // Still too many? Drop the least recently used chats first.
  if (store.size > MAX_TRACKED_CHATS) {
    const oldestFirst = [...lastSeen.entries()].sort((a, b) => a[1] - b[1]);
    const excess = store.size - MAX_TRACKED_CHATS;
    for (let i = 0; i < excess && i < oldestFirst.length; i += 1) {
      const chatId = oldestFirst[i][0];
      store.delete(chatId);
      lastSeen.delete(chatId);
    }
  }
}

function memoryGet(chatId: number): ChatMessage[] {
  evictStale();
  lastSeen.set(chatId, Date.now());
  return store.get(chatId) ?? [];
}

/** Applies the same trimming rules the Redis path uses. */
function trimToWindow(history: ChatMessage[]): ChatMessage[] {
  const limit = evenWindow(maxHistory());
  while (history.length > limit) {
    history.shift();
  }
  // Never begin with a dangling assistant reply. The even limit should already
  // guarantee this; the loop is belt-and-braces for hand-edited history.
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }
  return history;
}

function memoryAppend(chatId: number, userText: string, assistantText: string): void {
  lastSeen.set(chatId, Date.now());
  const history = store.get(chatId) ?? [];
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: assistantText });
  store.set(chatId, trimToWindow(history));
  evictStale();
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Returns the stored history for a chat, oldest message first.
 *
 * Never throws: if Redis fails, it falls back to the in-memory store and the
 * caller simply gets less context than it hoped for.
 */
export async function getHistory(chatId: number): Promise<ChatMessage[]> {
  if (!redisConfigured()) return memoryGet(chatId);

  try {
    const [entry] = await pipeline([['LRANGE', historyKey(chatId), 0, -1]]);
    if (entry?.error) throw new Error(entry.error);

    const raw = Array.isArray(entry?.result) ? (entry.result as unknown[]) : [];

    const parsed: ChatMessage[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      try {
        const message = JSON.parse(item) as ChatMessage;
        if (
          message &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string'
        ) {
          parsed.push(message);
        }
      } catch {
        // A corrupt entry is skipped rather than poisoning the whole history.
        console.warn('[memory] skipping an unparseable history entry.');
      }
    }

    return parsed;
  } catch (error) {
    console.error('[memory] redis read failed; using in-memory history instead:', error);
    return memoryGet(chatId);
  }
}

/**
 * Appends one turn and trims the transcript to the configured window.
 *
 * Trimming happens in pairs so history never starts with a dangling reply.
 * Pipelined into a single round trip: write, trim, refresh expiry, and record
 * activity. Never throws — a failed write costs durability, not the reply.
 */
export async function appendTurn(
  chatId: number,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (!redisConfigured()) {
    memoryAppend(chatId, userText, assistantText);
    return;
  }

  const key = historyKey(chatId);
  const limit = evenWindow(maxHistory());

  try {
    const entries = [
      JSON.stringify({ role: 'user', content: userText } satisfies ChatMessage),
      JSON.stringify({ role: 'assistant', content: assistantText } satisfies ChatMessage),
    ];

    // LTRIM keeps the newest `limit` entries. Turns are appended in pairs, so
    // an even limit guarantees the surviving list begins with a user message
    // rather than a dangling reply — see evenWindow().
    await pipeline([
      ['RPUSH', key, ...entries],
      ['LTRIM', key, -limit, -1],
      ['EXPIRE', key, memoryTtlSeconds()],
    ]);

    // Keep the in-memory copy warm too, so a Redis blip mid-conversation still
    // has something to fall back on.
    memoryAppend(chatId, userText, assistantText);
  } catch (error) {
    console.error('[memory] redis write failed; keeping the turn in memory only:', error);
    memoryAppend(chatId, userText, assistantText);
  }
}

/** Forgets a single chat — used by the /reset command. */
export async function clearHistory(chatId: number): Promise<void> {
  store.delete(chatId);
  lastSeen.delete(chatId);

  if (!redisConfigured()) return;

  try {
    await pipeline([['DEL', historyKey(chatId)]]);
  } catch (error) {
    // Worth surfacing: /reset promises the user their history is gone, and on
    // this path it may not be. Still not fatal to the reply.
    console.error('[memory] redis delete failed; history may not be cleared:', error);
  }
}

/** Small diagnostics helper for /api/health and the webhook's GET. */
export async function memoryStats(): Promise<{ chats: number; backend: 'redis' | 'memory' }> {
  evictStale();

  if (!redisConfigured()) {
    return { chats: store.size, backend: 'memory' };
  }

  try {
    // Count only this bot's chat keys, so /api/health stays accurate even if
    // the database is shared with something else.
    const [entry] = await pipeline([
      ['EVAL', "return #redis.call('keys', ARGV[1])", '0', 'sky:history:*'],
    ]);
    if (entry?.error) throw new Error(entry.error);
    const counted = typeof entry?.result === 'number' ? entry.result : 0;
    return { chats: counted, backend: 'redis' };
  } catch (error) {
    console.error('[memory] redis stats failed:', error);
    return { chats: store.size, backend: 'memory' };
  }
}
