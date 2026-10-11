import { telegramBotToken } from './config';

/**
 * Minimal Telegram Bot API client — just the methods this bot needs.
 * Implemented with fetch so the project needs no extra dependency.
 */

/**
 * Telegram's real API root. TELEGRAM_API_ROOT exists only so the end-to-end
 * test in scripts/test-webhook.mjs can point the client at a local fake
 * server; leave it unset in every real deployment.
 */
const API_ROOT = (process.env.TELEGRAM_API_ROOT?.trim() || 'https://api.telegram.org').replace(
  /\/+$/,
  '',
);
const TELEGRAM_MAX_LENGTH = 4096;

export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

export type TelegramChat = {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  first_name?: string;
  username?: string;
};

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
  reply_to_message?: TelegramMessage;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

type ApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
};

async function callTelegram<T>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const url = `${API_ROOT}/bot${telegramBotToken()}/${method}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch (error) {
    console.error(`[telegram] ${method} network failure:`, error);
    throw new Error(`Telegram request failed: ${method}`);
  }

  const raw = await response.text();
  let data: ApiEnvelope<T>;
  try {
    data = JSON.parse(raw) as ApiEnvelope<T>;
  } catch {
    console.error(`[telegram] ${method} non-JSON response:`, raw.slice(0, 300));
    throw new Error(`Telegram returned a non-JSON response for ${method}`);
  }

  if (!data.ok) {
    console.error(
      `[telegram] ${method} failed (${data.error_code ?? response.status}): ${data.description}`,
    );
    throw new Error(`Telegram error in ${method}: ${data.description ?? 'unknown'}`);
  }

  return data.result as T;
}

/** Counts UTF-16 units the way Telegram does, for the hard cap. */
function fitsTelegram(text: string): boolean {
  return text.length <= TELEGRAM_MAX_LENGTH;
}

/**
 * Sends a plain message, hard-splitting only if it exceeds Telegram's limit.
 * Prefer `sendBubbles` for model replies — this is for fixed system text.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  options: { replyToMessageId?: number } = {},
): Promise<number> {
  // Hard-split as a safety net only; persona splitting happens upstream.
  const chunks: string[] = [];
  let remaining = text;
  while (!fitsTelegram(remaining)) {
    const window = remaining.slice(0, TELEGRAM_MAX_LENGTH);
    const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = at > TELEGRAM_MAX_LENGTH * 0.5 ? at : TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);

  let sent = 0;
  for (const [index, chunk] of chunks.entries()) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: chunk,
      // Only the first chunk quotes the user's message.
      ...(index === 0 && options.replyToMessageId
        ? { reply_to_message_id: options.replyToMessageId }
        : {}),
      link_preview_options: { is_disabled: true },
    });
    sent += 1;
  }

  return sent;
}

/**
 * Sends a model reply as a sequence of chat bubbles, the way a person texts:
 * each bubble arrives on its own, after a short pause, with the "typing…"
 * indicator showing in between.
 *
 * Only the first bubble quotes the user's message; the rest follow naturally.
 * Returns the number of bubbles actually sent.
 */
export async function sendBubbles(
  chatId: number,
  bubbles: string[],
  options: {
    replyToMessageId?: number;
    /** Called before each bubble, to pace the send. */
    delayMs?: (bubble: string, index: number) => number;
    /** Awaits a real pause. Injectable so tests don't sleep. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<number> {
  const realSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  const sleep = options.sleep ?? realSleep;

  let sent = 0;

  for (const [index, bubble] of bubbles.entries()) {
    const isFirst = index === 0;

    if (!isFirst && options.delayMs) {
      // Show "typing…" during the pause so the gap reads as composing.
      await sendTyping(chatId);
      await sleep(Math.max(0, options.delayMs(bubble, index)));
    }

    try {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: bubble,
        ...(isFirst && options.replyToMessageId
          ? { reply_to_message_id: options.replyToMessageId }
          : {}),
        link_preview_options: { is_disabled: true },
      });
      sent += 1;
    } catch (error) {
      // If one bubble fails, stop rather than sending the rest out of order.
      console.error(`[telegram] bubble ${index + 1}/${bubbles.length} failed:`, error);
      if (isFirst) throw error;
      break;
    }
  }

  return sent;
}

/** Shows "typing…" in the chat while the model is thinking. Best-effort. */
export async function sendTyping(chatId: number): Promise<void> {
  try {
    await callTelegram('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {
    // Purely cosmetic — never let a failed indicator break the reply.
  }
}

/** Telegram's typing indicator lapses after about five seconds. */
const TYPING_LAPSE_MS = 4000;

/**
 * Keeps "typing…" alive for the duration of an async operation.
 *
 * Without this the indicator expires during a slow model call and the reply
 * simply appears from nowhere — which looks broken rather than human. Returns a
 * stop function; safe to call more than once.
 */
export function keepTyping(chatId: number): () => void {
  let stopped = false;

  void sendTyping(chatId);
  const timer = setInterval(() => {
    if (!stopped) void sendTyping(chatId);
  }, TYPING_LAPSE_MS);

  // Don't hold the serverless invocation open just for the indicator.
  if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Reacts to a message with an emoji instead of replying to it.
 *
 * Best-effort: reactions are a nicety, so a failure here is swallowed and the
 * caller carries on as though nothing happened.
 */
export async function setMessageReaction(
  chatId: number,
  messageId: number,
  emoji: string,
): Promise<boolean> {
  try {
    await callTelegram('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
    return true;
  } catch (error) {
    console.error('[telegram] setMessageReaction failed:', error);
    return false;
  }
}

/** Registers the webhook URL with Telegram. */
export async function setWebhook(
  url: string,
  secretToken?: string,
): Promise<{ description?: string }> {
  const payload: Record<string, unknown> = {
    url,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: true,
    max_connections: 40,
  };
  if (secretToken) payload.secret_token = secretToken;

  return callTelegram<{ description?: string }>('setWebhook', payload);
}

/** Reads back the currently registered webhook. */
export async function getWebhookInfo(): Promise<Record<string, unknown>> {
  return callTelegram<Record<string, unknown>>('getWebhookInfo', {});
}

/** Removes the webhook (useful when switching back to long polling). */
export async function deleteWebhook(): Promise<unknown> {
  return callTelegram('deleteWebhook', { drop_pending_updates: true });
}

/** Confirms the token works and returns the bot's own account info. */
export async function getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
  return callTelegram<{ id: number; username?: string; first_name?: string }>('getMe', {});
}
