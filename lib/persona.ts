import {
  busyChance,
  busyDelayMaxMs,
  busyDelayMinMs,
  reactionChance,
  readDelayMaxMs,
  readDelayMinMs,
  replyJitterMaxMs,
  replyJitterMinMs,
} from './config';

/**
 * Turns one model reply into the sequence of separate Telegram messages a
 * person would actually send.
 *
 * The model is told to separate its thoughts with a blank line, but we never
 * trust that blindly — replies arrive that are one long paragraph, or that use
 * blank lines for ordinary paragraphing. So this module decides the final
 * bubbles, using several signals:
 *
 *   1. Blank lines the model wrote  -> the primary, intended split.
 *   2. A long single block          -> split on sentence boundaries.
 *   3. Anything above Telegram's cap -> split on words as a last resort.
 *
 * Every bubble is also trimmed of markdown, because Telegram renders the plain
 * text we send and stray `**` or `- ` bullets look like typos in a chat.
 */

/** Telegram's hard limit per message. */
const TELEGRAM_HARD_LIMIT = 4096;

/**
 * Above this, a bubble feels like an essay rather than a text message.
 * Deliberately tight: real people send short texts. A 250-character paragraph
 * on a phone is already four lines — longer than most people type in one go.
 */
const PREFERRED_MAX = 220;

/** Don't split into slivers; merge anything shorter than this into a neighbour. */
const MIN_BUBBLE = 12;

/** Upper bound on bubbles, so a rambling reply can't spam the chat. */
const MAX_BUBBLES = 4;

/**
 * Strips markdown that would show up as literal punctuation in Telegram.
 * Deliberately conservative: we only remove formatting that is unambiguous.
 */
function stripMarkdown(text: string): string {
  return (
    text
      // **bold** / __bold__
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      // *italic* / _italic_ (single, and not mid-word underscores)
      .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
      // `code`
      .replace(/`([^`]+)`/g, '$1')
      // Leading bullet markers on their own lines -> plain sentences
      .replace(/^\s*[-*•]\s+/gm, '')
      .replace(/^\s*#{1,6}\s+/gm, '')
      // Collapse 3+ newlines to a blank line
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Splits a block into sentences, keeping terminal punctuation. */
function splitSentences(block: string): string[] {
  const parts = block
    .split(/(?<=[.!?…])\s+(?=[A-Z0-9"'(])/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [block.trim()];
}

/** Splits on words when even a sentence is too long for Telegram. */
function splitByWords(text: string, limit = TELEGRAM_HARD_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const at = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    const cut = at > limit * 0.5 ? at : limit;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out;
}

/**
 * Breaks an over-long block into text-sized bubbles at sentence boundaries,
 * packing as many sentences as fit under PREFERRED_MAX.
 */
function splitLongBlock(block: string): string[] {
  const sentences = splitSentences(block);

  // A single enormous "sentence" (no punctuation) — fall back to words.
  if (sentences.length === 1 && sentences[0].length > PREFERRED_MAX) {
    return splitByWords(sentences[0], PREFERRED_MAX);
  }

  const out: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;

    if (candidate.length <= PREFERRED_MAX) {
      current = candidate;
      continue;
    }

    if (current) out.push(current);
    // A sentence that alone exceeds the limit gets word-split.
    if (sentence.length > PREFERRED_MAX) {
      const pieces = splitByWords(sentence, PREFERRED_MAX);
      out.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1] ?? '';
    } else {
      current = sentence;
    }
  }

  if (current) out.push(current);
  return out;
}

/** Merges a too-short bubble into the previous one, so we don't send "Ok." alone. */
function mergeShortBubbles(bubbles: string[]): string[] {
  const out: string[] = [];

  for (const bubble of bubbles) {
    const prev = out[out.length - 1];

    if (prev !== undefined && bubble.length < MIN_BUBBLE) {
      const merged = `${prev} ${bubble}`.trim();
      if (merged.length <= PREFERRED_MAX) {
        out[out.length - 1] = merged;
        continue;
      }
    }

    // Also fold a short previous bubble forward into a short current one.
    if (
      prev !== undefined &&
      prev.length < MIN_BUBBLE &&
      `${prev} ${bubble}`.trim().length <= PREFERRED_MAX
    ) {
      out[out.length - 1] = `${prev} ${bubble}`.trim();
      continue;
    }

    out.push(bubble);
  }

  return out;
}

/**
 * Public entry point: model reply text -> ordered list of chat bubbles.
 * Always returns at least one non-empty bubble.
 */
export function splitIntoBubbles(rawReply: string): string[] {
  const text = stripMarkdown(rawReply);
  if (!text) return [];

  // 1. Honour the model's own blank-line breaks.
  let blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\n+/g, ' ').trim())
    .filter(Boolean);

  // 2. Break down any block that is still essay-length.
  blocks = blocks.flatMap((block) =>
    block.length > PREFERRED_MAX ? splitLongBlock(block) : [block],
  );

  // 3. Tidy, then enforce Telegram's hard limit.
  blocks = mergeShortBubbles(blocks);
  blocks = blocks.flatMap((b) =>
    b.length > TELEGRAM_HARD_LIMIT ? splitByWords(b) : [b],
  );

  // 4. Cap the number of bubbles, merging any overflow into the last one.
  if (blocks.length > MAX_BUBBLES) {
    const head = blocks.slice(0, MAX_BUBBLES - 1);
    const tail = blocks.slice(MAX_BUBBLES - 1).join(' ').trim();
    blocks = [...head, ...splitByWords(tail)];
  }

  return blocks.map((b) => b.trim()).filter(Boolean);
}

/**
 * A short, human-feeling pause between bubbles.
 *
 * Real people don't paste four paragraphs in the same instant, so we stagger
 * the sends. It scales with length but is capped, because Telegram renders
 * "typing…" during the gap and a long stall feels broken rather than human.
 */
export function bubbleDelayMs(bubble: string): number {
  const base = 350;
  const perChar = 12;
  const spread = 250;
  const jitter = Math.floor(Math.random() * spread);
  return Math.min(base + bubble.length * perChar + jitter, 2200);
}

/** True when a reply reads as several messages rather than one. */
export function isMultiBubble(bubbles: string[]): boolean {
  return bubbles.length > 1;
}

// ---------------------------------------------------------------------------
// Human timing
// ---------------------------------------------------------------------------

/** Injectable randomness, so tests can be deterministic. */
export type Random = () => number;

const realRandom: Random = () => Math.random();

/** Uniform integer in [min, max]. */
function between(min: number, max: number, random: Random = realRandom): number {
  if (max <= min) return Math.max(0, Math.round(min));
  return Math.round(min + random() * (max - min));
}

/**
 * How long she waits before starting to type — the pause where she notices the
 * message. Always applied, so even an instant model reply feels attended to.
 */
export function readDelayMs(random: Random = realRandom): number {
  return between(readDelayMinMs(), readDelayMaxMs(), random);
}

/**
 * The full delay between the user's message and her reply being sent.
 *
 * This is where "human" actually lives. The delay is deliberately unpredictable:
 * a fast model call still waits, and occasionally she is busy and takes much
 * longer. Nothing here correlates with how long the model took, which is the
 * point — a human's reply time does not track their CPU load.
 *
 * `budgetMs` caps the total so a slow model plus a long pause cannot run the
 * function past the platform's timeout.
 */
export function replyDelayMs(
  options: { random?: Random; budgetMs?: number } = {},
): number {
  const random = options.random ?? realRandom;

  let total = between(replyJitterMinMs(), replyJitterMaxMs(), random);

  // Occasionally she was doing something else.
  if (random() < busyChance()) {
    total += between(busyDelayMinMs(), busyDelayMaxMs(), random);
  }

  if (options.budgetMs !== undefined) {
    total = Math.min(total, Math.max(0, options.budgetMs));
  }

  return total;
}

// ---------------------------------------------------------------------------
// Typos and corrections
// ---------------------------------------------------------------------------

/**
 * Introduces a plausible typo into a bubble.
 *
 * Deliberately conservative: only adjacent-character transpositions and one
 * doubled letter. Those are what real thumbs produce, and they stay readable, so
 * the correction reads as a person fixing a slip rather than as a broken bot.
 *
 * Returns null when no safe typo site exists — callers must handle that rather
 * than assume a typo was made.
 */
export function introduceTypo(bubble: string, random: Random = realRandom): string | null {
  // Only meaningful on a bubble with enough words to hide the slip in.
  const words = bubble.split(/\s+/);
  if (words.length < 3) return null;

  // Never touch the first word or the last: it hides the typo mid-sentence,
  // which is where real slips happen.
  const candidates: number[] = [];
  for (let i = 1; i < words.length - 1; i += 1) {
    if (words[i].length >= 4 && /^[A-Za-z]+$/.test(words[i])) candidates.push(i);
  }
  if (candidates.length === 0) return null;

  const index = candidates[Math.floor(random() * candidates.length)];
  const word = words[index];

  // Transpose two adjacent inner characters: "because" -> "becuase".
  const at = 1 + Math.floor(random() * (word.length - 2));
  const swapped = word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);

  // A transposition that happens to be identical (double letters) is not a typo.
  if (swapped === word) return null;

  const next = [...words];
  next[index] = swapped;
  return next.join(' ');
}

/**
 * How long after sending a mistaken bubble the correction arrives.
 *
 * A person notices almost immediately, so this is short — but not instant, or
 * the edit lands before the first message has been read and nobody sees it.
 */
export function correctionDelayMs(random: Random = realRandom): number {
  return between(1200, 3600, random);
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/** Emoji she might send instead of words, for messages that need no answer. */
const REACTIONS = ['👍', '❤️', '😂', '🔥', '🙌', '😮', '👀'];

/**
 * Decides whether a message deserves an emoji reaction instead of a written
 * reply, and which one.
 *
 * Only ever fires for short messages — reacting with 👍 to a paragraph would
 * read as being brushed off, which is the opposite of the intent.
 */
export function pickReaction(
  userText: string,
  random: Random = realRandom,
): string | null {
  const text = userText.trim();

  // Long or question-shaped messages always deserve a real answer.
  if (text.length > 60) return null;
  if (text.includes('?')) return null;

  if (random() >= reactionChance()) return null;
  return REACTIONS[Math.floor(random() * REACTIONS.length)];
}

// ---------------------------------------------------------------------------
// Back-channels
// ---------------------------------------------------------------------------

/** Small acknowledgements she might send as their own bubble before answering. */
const BACKCHANNELS = ['hmm', 'oh nice', 'wait', 'ok so', 'hah', 'oh', 'right?'];

/**
 * Chooses an optional short back-channel bubble to send before the real answer.
 *
 * This is the "hmm" that arrives while someone is still thinking. Only used on
 * longer replies, where a human would plausibly stall for a moment first.
 */
export function pickBackchannel(
  reply: string,
  random: Random = realRandom,
): string | null {
  if (reply.length < 120) return null;
  if (random() >= 0.18) return null;
  return BACKCHANNELS[Math.floor(random() * BACKCHANNELS.length)];
}
