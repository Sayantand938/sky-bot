export default function Home() {
  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '64px 24px', lineHeight: 1.65 }}>
      <h1 style={{ fontSize: 30, marginBottom: 8 }}>🛰️ Sky Bot</h1>
      <p style={{ color: '#9aa4b2', marginTop: 0 }}>
        A conversational Telegram bot backed by AICredits · DeepSeek V4.1 Flash.
        Message it on Telegram: <strong>@sky_2026_10_08_bot</strong>
      </p>

      <h2 style={{ fontSize: 19, marginTop: 32 }}>Status</h2>
      <ul style={{ paddingLeft: 20 }}>
        <li>
          Config check: <code>/api/health</code>
        </li>
        <li>
          Webhook endpoint: <code>/api/telegram</code>
        </li>
        <li>
          Register the webhook: <code>/api/setup</code>
        </li>
      </ul>

      <h2 style={{ fontSize: 19, marginTop: 32 }}>Next steps</h2>
      <ol style={{ paddingLeft: 20 }}>
        <li>Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and AI_API in Vercel.</li>
        <li>
          Redeploy, then open <code>/api/health</code> and confirm <code>ready: true</code>.
        </li>
        <li>
          Open <code>/api/setup</code> once to point Telegram at this deployment.
        </li>
        <li>Message your bot on Telegram.</li>
      </ol>

      <p style={{ color: '#6b7280', fontSize: 13, marginTop: 40 }}>
        See README.md for the full walkthrough.
      </p>
    </main>
  );
}
