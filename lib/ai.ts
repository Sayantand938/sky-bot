import {
  aiApiKey,
  aiBaseUrl,
  aiMaxTokens,
  aiModel,
  aiTemperature,
  systemPrompt,
} from './config';
import type { ChatMessage } from './memory';

/**
 * Thin client for the AICredits chat-completions API.
 * The endpoint is OpenAI-compatible, so the request/response shape below is
 * the standard one. Docs: see API DOCUMENTATION.md.
 */

type ApiRole = 'system' | 'user' | 'assistant';

type ApiMessage = {
  role: ApiRole;
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { role?: string; content?: string | null };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
};

export class AiError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

/**
 * Calls the model with the given conversation and returns the reply text.
 * Throws AiError with a message that is safe to show the Telegram user.
 */
export async function generateReply(history: ChatMessage[]): Promise<string> {
  const messages: ApiMessage[] = [
    { role: 'system', content: systemPrompt() },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  const controller = new AbortController();
  // Stay comfortably below the route's maxDuration so we can answer the user
  // with a real error instead of being killed by the platform.
  const timeout = setTimeout(() => controller.abort(), 55_000);

  let response: Response;
  try {
    response = await fetch(`${aiBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aiApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: aiModel(),
        messages,
        temperature: aiTemperature(),
        max_tokens: aiMaxTokens(),
        stream: false,
      }),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiError('The AI request timed out. Please try again.');
    }
    console.error('[ai] network failure:', error);
    throw new AiError('Could not reach the AI service. Please try again.');
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();

  if (!response.ok) {
    console.error(`[ai] HTTP ${response.status}:`, raw.slice(0, 500));
    if (response.status === 401 || response.status === 403) {
      throw new AiError('The AI API key was rejected. Check the AI_API value.', 401);
    }
    if (response.status === 429) {
      throw new AiError('The AI service is rate-limiting requests. Try again shortly.', 429);
    }
    throw new AiError('The AI service returned an error. Please try again.', 502);
  }

  let data: ChatCompletionResponse;
  try {
    data = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    console.error('[ai] non-JSON response:', raw.slice(0, 500));
    throw new AiError('The AI service sent an unexpected response.', 502);
  }

  if (data.error?.message) {
    console.error('[ai] API error payload:', data.error);
    throw new AiError('The AI service reported an error. Please try again.', 502);
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    console.error('[ai] empty completion:', raw.slice(0, 500));
    throw new AiError('The AI returned an empty reply. Please try again.', 502);
  }

  return text;
}
