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

/** Splits text so it never exceeds Telegram's per-message character limit. */
function chunkText(text: string, size = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > size) {
    // Prefer to break on a paragraph, then a line, then a space.
    const window = remaining.slice(0, size);
    const breakAt = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    const cut = breakAt > size * 0.5 ? breakAt : size;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Sends a message, splitting long replies into several Telegram messages.
 * Returns the number of messages sent.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  options: { replyToMessageId?: number } = {},
): Promise<number> {
  const chunks = chunkText(text);
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

/** Shows "typing…" in the chat while the model is thinking. Best-effort. */
export async function sendTyping(chatId: number): Promise<void> {
  try {
    await callTelegram('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {
    // Purely cosmetic — never let a failed indicator break the reply.
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
