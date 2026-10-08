import { NextResponse } from 'next/server';
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
  };

  // The two values the bot cannot run without.
  const required = [checks.TELEGRAM_BOT_TOKEN, checks.AI_API];
  const ready = required.every(Boolean);

  return NextResponse.json(
    {
      ok: ready,
      ready,
      checks,
      config: {
        model: process.env.AI_MODEL?.trim() || 'deepseek/deepseek-v4.1-flash',
        baseUrl: process.env.AI_BASE_URL?.trim() || 'https://api.aicredits.in/v1',
        maxHistory: process.env.AI_MAX_HISTORY?.trim() || '10',
      },
      memory: memoryStats(),
      hint: ready
        ? 'Configuration looks good. Register the webhook by calling /api/setup.'
        : 'Set the missing variables in Vercel -> Project Settings -> Environment Variables, then redeploy.',
    },
    { status: ready ? 200 : 503 },
  );
}
