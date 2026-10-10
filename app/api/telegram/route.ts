import { NextResponse, type NextRequest } from 'next/server';
import { AiError, generateReply } from '@/lib/ai';
import { botName, webhookSecret } from '@/lib/config';
import { appendTurn, clearHistory, getHistory, memoryStats } from '@/lib/memory';
import { bubbleDelayMs, splitIntoBubbles } from '@/lib/persona';
import {
  sendBubbles,
  sendMessage,
  sendTyping,
  type TelegramMessage,
  type TelegramUpdate,
} from '@/lib/telegram';

/**
 * Telegram webhook endpoint.
 *
 * Configure this URL with:  https://<your-app>.vercel.app/api/telegram
 * (or just call GET /api/setup once, which registers it for you).
 *
 * Flow: verify the secret header -> acknowledge Telegram -> think -> reply.
 */

// The bot owns its own state (in-memory history), so never cache this route.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function helpText(): string {
  return [
    `I'm ${botName()} — just text me like you'd text a friend.`,
    '',
    'A few commands if you need them:',
    '/reset - forget our conversation and start fresh',
    '/whoami - show your Telegram chat ID',
    '/help - this message',
  ].join('\n');
}

/** Constant-time-ish comparison so the secret cannot be probed by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isCommand(text: string, command: string): boolean {
  // Tolerates "/reset", "/reset@MyBot" and trailing arguments.
  const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const bare = firstWord.split('@')[0];
  return bare === command;
}

async function handleCommand(
  message: TelegramMessage,
  text: string,
): Promise<boolean> {
  const chatId = message.chat.id;

  const name = message.from?.first_name;

  if (isCommand(text, '/start')) {
    // Two short bubbles, the way a friend would actually greet you.
    await sendBubbles(
      chatId,
      [
        name ? `Hey ${name}! 👋` : 'Hey! 👋',
        `I'm ${botName()}. Just talk to me like a friend — no commands needed.`,
      ],
      { delayMs: () => 700 },
    );
    return true;
  }

  if (isCommand(text, '/help')) {
    await sendMessage(chatId, helpText());
    return true;
  }

  if (isCommand(text, '/reset')) {
    await clearHistory(chatId);
    await sendMessage(chatId, "Okay, clean slate — what's on your mind?");
    return true;
  }

  if (isCommand(text, '/whoami')) {
    await sendMessage(chatId, `Your chat ID is ${chatId}.`);
    return true;
  }

  return false;
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = (message.text ?? message.caption ?? '').trim();

  if (text === '') {
    // Stickers, photos without captions, voice notes, joins, etc.
    if (message.chat.type === 'private') {
      await sendMessage(chatId, "I can't see that one — text me instead?");
    }
    return;
  }

  if (await handleCommand(message, text)) return;

  // In groups, only respond when explicitly addressed (/bot or @mention).
  if (message.chat.type !== 'private') {
    const mentioned = message.entities?.some(
      (entity) => entity.type === 'mention' || entity.type === 'bot_command',
    );
    const repliedToBot = message.reply_to_message?.from?.is_bot === true;
    if (!mentioned && !repliedToBot) return;
  }

  await sendTyping(chatId);

  // Build the prompt from prior turns plus this new message.
  const history = [...(await getHistory(chatId)), { role: 'user' as const, content: text }];

  try {
    const reply = await generateReply(history);

    // Store the full reply as one turn, so context stays coherent even though
    // the user sees it as several bubbles.
    await appendTurn(chatId, text, reply);

    // Send it the way a person texts: separate short messages, paced out.
    const bubbles = splitIntoBubbles(reply);
    if (bubbles.length === 0) {
      await sendMessage(chatId, "Hmm, I lost my train of thought — say that again?", {
        replyToMessageId: message.message_id,
      });
    } else {
      await sendBubbles(chatId, bubbles, {
        replyToMessageId: message.message_id,
        delayMs: bubbleDelayMs,
      });
    }
  } catch (error) {
    const isAiError = error instanceof AiError;
    if (!isAiError) {
      console.error('[telegram] unexpected handler error:', error);
    }
    const userFacing = isAiError
      ? error.message
      : 'Something went wrong while generating a reply. Please try again.';
    try {
      await sendMessage(chatId, `⚠️ ${userFacing}`);
    } catch (sendError) {
      console.error('[telegram] could not deliver the error notice:', sendError);
    }
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // --- 1. Authenticate the caller -----------------------------------------
  const expected = webhookSecret();
  if (expected) {
    const provided = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(provided, expected)) {
      console.warn('[telegram] rejected a request with a bad or missing secret token.');
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
  } else {
    console.warn(
      '[telegram] TELEGRAM_WEBHOOK_SECRET is not set, so this endpoint cannot verify ' +
        'that the caller is Telegram. Set it before going live.',
    );
  }

  // --- 2. Parse the update ------------------------------------------------
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }

  const message = update.message ?? update.edited_message ?? update.channel_post;
  if (!message) {
    // Receipts, reactions, polls, etc. — nothing to answer, but still a success.
    return NextResponse.json({ ok: true, skipped: true });
  }

  // --- 3. Do the work, then answer Telegram -------------------------------
  // Vercel freezes the function once a response is returned, so the AI call
  // must finish *before* we reply to Telegram. Telegram's webhook timeout is
  // generous enough for this, and keeping it synchronous means no work is lost.
  try {
    await handleMessage(message);
  } catch (error) {
    console.error('[telegram] handler threw:', error);
    // Still return 200: a 5xx makes Telegram retry the same update repeatedly.
  }

  return NextResponse.json({ ok: true });
}

/** Telegram occasionally probes the URL with GET; make that harmless. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    message: 'Telegram webhook is live. Updates must be delivered via POST.',
    memory: await memoryStats(),
  });
}
