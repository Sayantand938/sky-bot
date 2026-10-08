/**
 * Central place where environment variables are read and validated.
 * Every value has a safe default so the app only fails when it truly must.
 */

function required(name: string, value: string | undefined, hint: string): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ${hint}\n` +
        `Locally: add it to .env.local — on Vercel: Project Settings -> Environment Variables.`,
    );
  }
  return value.trim();
}

function optionalNumber(name: string, value: string | undefined, fallback: number): number {
  if (!value || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.warn(`[config] ${name}="${value}" is not a number; falling back to ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/** Telegram bot token from @BotFather. */
export function telegramBotToken(): string {
  return required(
    'TELEGRAM_BOT_TOKEN',
    process.env.TELEGRAM_BOT_TOKEN,
    'Get it from @BotFather with /newbot or /token.',
  );
}

/**
 * The shared secret used to verify that an incoming webhook call really comes
 * from Telegram. Optional: when unset the route still works, but it cannot
 * prove the caller is Telegram, so it logs a warning instead.
 */
export function webhookSecret(): string | undefined {
  const value = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** AICredits API key. */
export function aiApiKey(): string {
  return required(
    'AI_API',
    process.env.AI_API,
    'Your AICredits key, for example sk-live-...',
  );
}

export function aiBaseUrl(): string {
  return (process.env.AI_BASE_URL?.trim() || 'https://api.aicredits.in/v1').replace(/\/+$/, '');
}

export function aiModel(): string {
  return process.env.AI_MODEL?.trim() || 'deepseek/deepseek-v4.1-flash';
}

export function systemPrompt(): string {
  return (
    process.env.AI_SYSTEM_PROMPT?.trim() ||
    'You are a friendly, helpful assistant chatting over Telegram. ' +
      'Keep answers concise and in plain text (no markdown tables), ' +
      'and ask a clarifying question when the request is ambiguous.'
  );
}

/** How many previous user/assistant messages to replay as context. */
export function maxHistory(): number {
  const value = optionalNumber('AI_MAX_HISTORY', process.env.AI_MAX_HISTORY, 10);
  return Math.max(0, Math.min(50, Math.floor(value)));
}

export function aiTemperature(): number {
  const value = optionalNumber('AI_TEMPERATURE', process.env.AI_TEMPERATURE, 0.7);
  return Math.max(0, Math.min(2, value));
}

export function aiMaxTokens(): number {
  const value = optionalNumber('AI_MAX_TOKENS', process.env.AI_MAX_TOKENS, 1024);
  return Math.max(1, Math.floor(value));
}

/** Optional guard for the /api/setup route. */
export function setupKey(): string | undefined {
  const value = process.env.SETUP_KEY?.trim();
  return value && value.length > 0 ? value : undefined;
}
