import type { ai } from '@fraqjs/plugin-ai';

/**
 * Provider options marking the end of a reusable prompt prefix. Only Anthropic takes explicit
 * breakpoints, at most four per request, using its default 5-minute cache lifetime; other providers
 * ignore these options and cache prefixes on their own.
 */
export const cacheBreakpoint = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
};

/**
 * `prepareStep` hook that keeps a cache breakpoint on the newest message of every tool-loop step, so
 * each step reads the previous step's prompt from the cache instead of paying for the whole thread
 * again. The first step needs nothing extra: the system prompt and the thread are already marked.
 *
 * Messages returned here carry forward to later steps, so the breakpoint placed for the previous step
 * is removed again; otherwise they would pile up past Anthropic's limit and the newest ones, which are
 * the useful ones, would be dropped. Only this hook sets `cacheControl` at the message level, which is
 * what makes the removal safe.
 */
export function cacheLatestStepMessage({ stepNumber, messages }: { stepNumber: number; messages: ai.ModelMessage[] }) {
  if (stepNumber === 0) {
    return undefined;
  }
  return {
    messages: messages.map((message, index): ai.ModelMessage => {
      const { cacheControl, ...anthropic } = message.providerOptions?.anthropic ?? {};
      const isLatest = index === messages.length - 1;
      if (!isLatest && cacheControl === undefined) {
        return message;
      }
      return {
        ...message,
        providerOptions: {
          ...message.providerOptions,
          anthropic: isLatest ? { ...anthropic, ...cacheBreakpoint.anthropic } : anthropic,
        },
      } as ai.ModelMessage;
    }),
  };
}
