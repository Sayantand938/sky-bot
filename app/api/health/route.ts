import { NextResponse } from 'next/server';
import { allowedChatIds, maxHistory, redisConfigured } from '@/lib/config';
import { memoryStats } from '@/lib/memory';

/**
 * Configuration check that never reveals secret values.
 * Open https://<your-app>.vercel.app/api/health after deploying.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function present(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

export async function GET(): Promise<NextResponse> {
  const checks = {
    TELEGRAM_BOT_TOKEN: present('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_WEBHOOK_SECRET: present('TELEGRAM_WEBHOOK_SECRET'),
    AI_API: present('AI_API'),
    SETUP_KEY: present('SETUP_KEY'),
    ALLOWED_CHAT_IDS: present('ALLOWED_CHAT_IDS'),
    // Not required: without it the bot runs on in-memory history, which is
    // fine locally but forgets everything on a cold start in production.
    UPSTASH_REDIS_REST_URL: present('UPSTASH_REDIS_REST_URL'),
    UPSTASH_REDIS_REST_TOKEN: present('UPSTASH_REDIS_REST_TOKEN'),
  };

  // The two values the bot cannot run without.
  const required = [checks.TELEGRAM_BOT_TOKEN, checks.AI_API];
  const ready = required.every(Boolean);

  // Report the effective window, not a copy of the default, so this can never
  // drift out of step with what the bot actually does.
  const durable = redisConfigured();

  // Count only — the IDs themselves stay private.
  const allow = allowedChatIds();

  return NextResponse.json(
    {
      ok: ready,
      ready,
      checks,
      config: {
        model: process.env.AI_MODEL?.trim() || 'deepseek/deepseek-v4.1-flash',
        baseUrl: process.env.AI_BASE_URL?.trim() || 'https://api.aicredits.in/v1',
        maxHistory: maxHistory(),
        memoryBackend: durable ? 'redis' : 'memory',
        allowList: allow
          ? `${allow.size} chat${allow.size === 1 ? '' : 's'}`
          : 'off',
      },
      memory: await memoryStats(),
      hint: ready
        ? durable
          ? 'Configuration looks good, and memory is durable (Redis). Register the webhook by calling /api/setup.'
          : 'The bot works, but memory is in-process only: it forgets everything on a cold start. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for durable memory.'
        : 'Set the missing variables in Vercel -> Project Settings -> Environment Variables, then redeploy.',
    },
    { status: ready ? 200 : 503 },
  );
}
