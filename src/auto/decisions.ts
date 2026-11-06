import { openAIDecisionsAdapter } from './adapters/openai';
import { systemOneAdapter } from './adapters/systemone';
import {
  type DecisionAdapter,
  type DecisionClient,
  type DecisionInput,
  type DecisionQuestions,
  validateAnswers,
} from './decision-types';

export interface DecisionsOptions {
  type: 'systemone' | 'decisions';
  apiKey: string;
  model: string;
  /** API root ending in /v1. Defaults to the selected provider's API root. */
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}

const RETRYABLE_STATUS = new Set([429, 529, 500, 502, 503, 504]);

export function normalizeDecisionBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid decisions baseURL: ${baseURL}`);
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !url.pathname.endsWith('/v1') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'Decisions baseURL must be an http(s) API root ending in /v1, without credentials, query or fragment.',
    );
  }
  return trimmed;
}

/** Shared transport; only adapters know provider wire formats. */
export class DecisionsClient implements DecisionClient {
  private readonly adapter: DecisionAdapter;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: DecisionsOptions) {
    if (!options || !['systemone', 'decisions'].includes(options.type)) {
      throw new Error('auto.decisions.type must be systemone or decisions.');
    }
    if (!options.apiKey?.trim()) throw new Error('auto.decisions.apiKey is required.');
    if (!options.model?.trim()) throw new Error('auto.decisions.model is required.');
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxRetries = options.maxRetries ?? 2;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error('auto.decisions.timeoutMs must be a positive integer no greater than 2147483647.');
    }
    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0) {
      throw new Error('auto.decisions.maxRetries must be a nonnegative integer.');
    }
    this.adapter = options.type === 'systemone' ? systemOneAdapter : openAIDecisionsAdapter;
    this.endpoint = `${normalizeDecisionBaseURL(options.baseURL ?? this.adapter.baseURL)}${this.adapter.path}`;
  }

  get model(): string {
    return this.options.model;
  }

  async evaluate(input: DecisionInput, questions: DecisionQuestions) {
    const body = JSON.stringify(this.adapter.encode(this.model, input, questions));
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 2_000)));
      let response: Response;
      let data: unknown;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        // Read bodies within the timeout/retry boundary as well as response headers.
        data = response.ok ? await response.json() : (await response.text()).slice(0, 500);
      } catch (error) {
        lastError = error;
        continue;
      }
      if (response.ok) return validateAnswers(this.adapter.decode(data), questions);
      lastError = new DecisionError(
        `${this.options.type} request failed with HTTP ${response.status}: ${data}`,
        response.status,
      );
      if (!RETRYABLE_STATUS.has(response.status)) break;
    }
    throw lastError instanceof Error ? lastError : new DecisionError(String(lastError));
  }
}
