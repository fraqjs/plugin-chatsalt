/**
 * Minimal client for TypeSafe's System One API (the Jev decision model).
 *
 * @see https://docs.typesafe.ai/api/system-one
 */

export type JevContent = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: 'noul';
  instructions: JevContent;
  criteria?: { true?: JevContent; false?: JevContent };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: JevContent;
  /** Choice names mapped to descriptions of when each applies. */
  criteria: Record<string, JevContent | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: JevContent;
  /** Ordered level descriptions; each position is its score, starting at zero. */
  criteria: JevContent[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, JevContent>;
  probabilities: Record<string, number>;
}

export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevClientOptions {
  apiKey: string;
  model: string;
  /** API root ending in `/v1`, e.g. `https://api.typesafe.ai/v1`. */
  baseURL: string;
  timeoutMs: number;
  maxRetries: number;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

const RETRYABLE_STATUS = new Set([429, 529, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1';

/** Validates an API root such as `https://api.typesafe.ai/v1` and strips trailing slashes. */
export function normalizeJevBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Jev baseURL: ${baseURL}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Jev baseURL must use http or https: ${baseURL}`);
  }
  if (!url.pathname.endsWith('/v1') || url.search || url.hash) {
    throw new Error(`Jev baseURL must end with /v1, e.g. ${DEFAULT_JEV_BASE_URL}: ${baseURL}`);
  }
  return trimmed;
}

export class JevClient {
  private readonly endpoint: string;

  constructor(private readonly options: JevClientOptions) {
    this.endpoint = `${normalizeJevBaseURL(options.baseURL)}/systemone`;
  }

  get model(): string {
    return this.options.model;
  }

  async systemOne(state: JevContent, questions: Record<string, JevQuestion>): Promise<SystemOneResponse> {
    const body = JSON.stringify({ model: this.options.model, state, questions });
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
      }
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        lastError = error;
        continue; // network error or timeout
      }
      if (response.ok) {
        return (await response.json()) as SystemOneResponse;
      }
      const detail = await response.text().catch(() => '');
      lastError = new JevError(
        `Jev request failed with HTTP ${response.status}: ${detail.slice(0, 500)}`,
        response.status,
      );
      if (!RETRYABLE_STATUS.has(response.status)) {
        break;
      }
    }
    throw lastError instanceof Error ? lastError : new JevError(String(lastError));
  }
}
