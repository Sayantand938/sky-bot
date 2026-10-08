import { maxHistory } from './config';

/**
 * Simple in-memory, per-chat conversation memory.
 *
 * Scope and limits — worth knowing before you rely on it:
 *  - Serverless instances are ephemeral. A Vercel cold start (or a new region
 *    instance) starts with an empty store, so history can disappear between
 *    messages. The bot stays correct, it just forgets the earlier turns.
 *  - Each warm instance keeps its own copy, so two concurrent instances for the
 *    same chat do not share history.
 *  - One instance persists across concurrent chats because Next.js reuses the
 *    module between invocations while it stays warm.
 *
 * For durable memory, swap this module for Redis/Upstash — keep the same three
 * exported functions and nothing else in the app has to change. See README.
 */

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type Store = Map<number, ChatMessage[]>;

// Attach the store to globalThis so Next.js hot reload in `next dev` does not
// create a brand new store on every recompile.
const globalForMemory = globalThis as unknown as { __tgBotMemory?: Store };

const store: Store = globalForMemory.__tgBotMemory ?? new Map<number, ChatMessage[]>();
globalForMemory.__tgBotMemory = store;

/** Idle chats are dropped so a long-lived instance cannot grow without bound. */
const CHAT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_TRACKED_CHATS = 500;

const lastSeen = new Map<number, number>();

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

/** Returns the stored history for a chat, oldest message first. */
export function getHistory(chatId: number): ChatMessage[] {
  evictStale();
  lastSeen.set(chatId, Date.now());
  return store.get(chatId) ?? [];
}

/**
 * Appends one turn and trims the transcript to the configured window.
 * Trimming happens in pairs so history never starts with a dangling reply.
 */
export function appendTurn(chatId: number, userText: string, assistantText: string): void {
  lastSeen.set(chatId, Date.now());

  const history = store.get(chatId) ?? [];
  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: assistantText });

  const limit = maxHistory();
  while (history.length > limit) {
    history.shift();
  }
  // If trimming left an assistant message at the front, drop it as well.
  while (history.length > 0 && history[0].role !== 'user') {
    history.shift();
  }

  store.set(chatId, history);
  evictStale();
}

/** Forgets a single chat — used by the /reset command. */
export function clearHistory(chatId: number): void {
  store.delete(chatId);
  lastSeen.delete(chatId);
}

/** Small diagnostics helper for /api/health. */
export function memoryStats(): { chats: number } {
  evictStale();
  return { chats: store.size };
}
