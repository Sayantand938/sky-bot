import { NextResponse, type NextRequest } from 'next/server';
import { AiError, generateReply } from '@/lib/ai';
import {
  allowedChatIds,
  botName,
  debounceMs,
  webhookSecret,
} from '@/lib/config';
import {
  appendTurn,
  claimReplySlot,
  clearHistory,
  drainBurstMessages,
  getHistory,
  memoryStats,
  queueBurstMessage,
} from '@/lib/memory';
import {
  backchannelDelayMs,
  bubbleDelayMs,
  pickBackchannel,
  pickReaction,
  readDelayMs,
  replyDelayMs,
  splitIntoBubbles,
} from '@/lib/persona';
import {
  keepTyping,
  sendBubbles,
  sendMessage,
  sendTyping,
  setMessageReaction,
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

/**
 * Ceiling on ALL the artificial pauses in one reply, in milliseconds.
 *
 * Derived from the route's platform limit rather than picked by feel:
 *
 *   60s route cap
 *   -40s model request timeout   (AI_TIMEOUT_MS, see lib/ai.ts)
 *   - 7s bubble pacing           (up to 3 inter-bubble delays at the 2.2s cap)
 *   - 3s safety                  (Redis reads/writes, Telegram round trips)
 *   = 10s for every human pause in the reply
 *
 * Every pause draws from this one pool, so no combination of random branches can
 * push the function past its limit. If AI_TIMEOUT_MS or MAX_BUBBLES is raised,
 * this number must come down to match — the sum is what matters, not each part.
 */
const HUMAN_PAUSE_BUDGET_MS = 10_000;

/**
 * Cap on how long she waits for the rest of a burst to arrive, in milliseconds.
 *
 * Bounded independently of AI_DEBOUNCE_MS so a large configured window cannot
 * eat the route's whole time budget before the model has even been called.
 */
const BURST_WAIT_MS = 3_000;

/** Pauses without blocking the event loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when the model answered quickly enough that adding a human pause still
 * leaves the reply feeling prompt.
 *
 * When the model was already slow the pause is skipped: doubling down on an
 * already-late reply reads as the bot being broken, not as a person thinking.
 */
function modelWasFast(startedAt: number): boolean {
  return Date.now() - startedAt < 6_000;
}

/**
 * Tracks how much of the human-pause budget is left for one reply.
 *
 * A small object rather than a number so each stage decrements the same pool:
 * a long read delay leaves less for the jitter, and a busy pause consumes most
 * of it. This is what keeps the total bounded no matter which random branches
 * fire.
 */
function createPauseBudget(totalMs: number) {
  let remaining = totalMs;
  return {
    /** Waits for `ms`, trimmed to whatever is left. Returns what it actually waited. */
    async spend(ms: number): Promise<number> {
      const actual = Math.max(0, Math.min(ms, remaining));
      remaining -= actual;
      if (actual > 0) await sleep(actual);
      return actual;
    },
    get left(): number {
      return remaining;
    },
  };
}

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

  // Allow-list: when ALLOWED_CHAT_IDS is set, only those chats are answered.
  // Silence, not a rejection notice: a stranger probing the bot gets nothing
  // back, and none of the credits are spent — not even on the error paths.
  const allowed = allowedChatIds();
  if (allowed && !allowed.has(chatId)) return;

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

  // Every artificial pause in this reply draws from one shared budget, so no
  // combination of random branches can push the function past its time limit.
  const budget = createPauseBudget(HUMAN_PAUSE_BUDGET_MS);
  const startedAt = Date.now();

  // Debounce: in a burst of quick messages, only the first one answers. The
  // others are queued so the eventual reply still sees everything you said.
  //
  // The claim must outlive the wait below, or it expires mid-wait and a message
  // arriving in that gap claims a fresh slot and answers a second time — the
  // duplicate-reply bug. The claim is therefore extended past the whole window
  // plus the burst wait, with margin for the round trips in between.
  const windowMs = debounceMs();
  const burstWaitMs = Math.min(windowMs, BURST_WAIT_MS);
  const claimMs = windowMs + burstWaitMs + 2_000;

  const shouldReply = await claimReplySlot(chatId, claimMs);

  if (!shouldReply) {
    await queueBurstMessage(chatId, text);
    return;
  }

  // Let the rest of the burst arrive before composing, so a three-message
  // thought gets one answer that responds to all of it rather than to "hey".
  if (windowMs > 0) await budget.spend(burstWaitMs);
  const burst = await drainBurstMessages(chatId);

  // A short pause first: she noticed the message before she started composing.
  await budget.spend(readDelayMs());

  // Start the model call and the typing indicator together, so the indicator
  // covers the whole wait rather than lapsing mid-thinking.
  const stopTyping = keepTyping(chatId);

  // Everything the user sent in this burst becomes one combined prompt.
  const combined = burst.length > 0 ? [text, ...burst].join('\n') : text;

  // Build the prompt from prior turns plus this new message.
  const history = [...(await getHistory(chatId)), { role: 'user' as const, content: combined }];

  try {
    const reply = await generateReply(history);

    // Store the full reply as one turn, so context stays coherent even though
    // the user sees it as several bubbles.
    await appendTurn(chatId, combined, reply);

    // Human variance: a random pause that has nothing to do with how long the
    // model took. This is what stops her looking like a metronome. Capped by
    // whatever is left of the budget, and skipped entirely if the model was slow
    // — a slow answer should not then be delayed further.
    if (modelWasFast(startedAt)) await budget.spend(replyDelayMs());

    // Sometimes a short message just gets a reaction rather than words.
    const reaction = pickReaction(text);
    if (reaction && (await setMessageReaction(chatId, message.message_id, reaction))) {
      return;
    }

    stopTyping();

    // Send it the way a person texts: separate short messages, paced out.
    const bubbles = splitIntoBubbles(reply);
    if (bubbles.length === 0) {
      await sendMessage(chatId, "Hmm, I lost my train of thought — say that again?", {
        replyToMessageId: message.message_id,
      });
    } else {
      // A short stall before a long answer — the "hmm" someone sends while
      // they are still putting their thoughts together.
      const backchannel = pickBackchannel(reply);
      if (backchannel) {
        await sendMessage(chatId, backchannel, { replyToMessageId: message.message_id });
        await sleep(backchannelDelayMs());
        await sendBubbles(chatId, bubbles, { delayMs: bubbleDelayMs });
      } else {
        await sendBubbles(chatId, bubbles, {
          replyToMessageId: message.message_id,
          delayMs: bubbleDelayMs,
        });
      }
    }

    // Anything sent WHILE she was composing was queued by the suppressed
    // handlers. Answer it now, referencing the fact they added something, so the
    // user gets a natural follow-up instead of a second answer to the same
    // question. This is the last step, so the burst queue is drained exactly
    // once per reply.
    const lateArrivals = await drainBurstMessages(chatId);
    if (lateArrivals.length > 0) {
      await answerLateArrivals(chatId, lateArrivals, message.message_id);
    }
  } catch (error) {
    stopTyping();
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

/**
 * Answers messages that arrived while the previous reply was being composed.
 *
 * These were queued by handlers that lost the reply-slot claim, so nobody has
 * answered them yet. Crucially they are answered as a FOLLOW-UP — the earlier
 * turn is already in history, so the model sees the new text as an addition
 * rather than a repeat of what it just replied to. Without this the same
 * question could be answered twice, which is the bug this exists to prevent.
 */
async function answerLateArrivals(
  chatId: number,
  arrivals: string[],
  replyToMessageId: number,
): Promise<void> {
  const text = arrivals.join('\n');

  try {
    const history = [...(await getHistory(chatId)), { role: 'user' as const, content: text }];
    const reply = await generateReply(history);
    await appendTurn(chatId, text, reply);

    const bubbles = splitIntoBubbles(reply);
    if (bubbles.length > 0) {
      await sendBubbles(chatId, bubbles, { replyToMessageId, delayMs: bubbleDelayMs });
    }
  } catch (error) {
    // The user has already had one answer; a failed follow-up is not worth an
    // error notice on top of it.
    console.error('[telegram] could not answer a message sent mid-reply:', error);
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
