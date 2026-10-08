import { NextResponse, type NextRequest } from 'next/server';
import { setupKey, webhookSecret } from '@/lib/config';
import { getMe, getWebhookInfo, setWebhook } from '@/lib/telegram';

/**
 * One-shot helper for wiring the bot to your deployment.
 *
 *   curl "https://<your-app>.vercel.app/api/setup?key=<SETUP_KEY>"
 *
 * It registers <origin>/api/telegram as the webhook. Call it again any time the
 * domain changes. Lock it down by setting SETUP_KEY in your environment.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Derives the deployment's public origin, preferring VERCEL_URL so a
 * preview/production domain is used even behind a proxy.
 */
function resolveOrigin(request: NextRequest): string {
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl.replace(/^https?:\/\//, '')}`;
  return request.nextUrl.origin;
}

async function run(request: NextRequest): Promise<NextResponse> {
  const expectedKey = setupKey();
  if (expectedKey) {
    const provided =
      request.nextUrl.searchParams.get('key') ?? request.headers.get('x-setup-key') ?? '';
    if (provided !== expectedKey) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
  }

  const origin = resolveOrigin(request);
  const webhookUrl = `${origin}/api/telegram`;
  const secret = webhookSecret();

  if (!secret) {
    console.warn('[setup] TELEGRAM_WEBHOOK_SECRET is not set; registering without one.');
  }

  try {
    const me = await getMe();
    await setWebhook(webhookUrl, secret);
    const info = await getWebhookInfo();

    return NextResponse.json({
      ok: true,
      bot: { id: me.id, username: me.username, name: me.first_name },
      webhook: webhookUrl,
      secretTokenSet: Boolean(secret),
      info,
      next: `Open Telegram and send a message to @${me.username ?? 'your bot'}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error('[setup] failed:', error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return run(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return run(request);
}
