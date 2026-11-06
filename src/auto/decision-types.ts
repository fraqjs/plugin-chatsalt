import { z } from 'zod';

/** Provider-neutral questions. Score criteria are ordered from zero. */
export type DecisionQuestion =
  | { type: 'predicate'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type DecisionQuestions = Record<string, DecisionQuestion>;
export type DecisionInput = string | Record<string, unknown> | unknown[];

export const probabilitySchema = z.number().min(0).max(1);
const probabilitiesSchema = z.record(z.string(), probabilitySchema);
export const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), probability: probabilitySchema }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: probabilitySchema,
    probabilities: probabilitiesSchema,
  }),
  z.object({
    type: z.literal('score'),
    score: z.number().nonnegative(),
    confidence: probabilitySchema,
    probabilities: probabilitiesSchema,
  }),
]);
export const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }),
});
export type DecisionResponse = z.infer<typeof responseSchema>;
export type DecisionAnswer = z.infer<typeof answerSchema>;
export type ChoiceAnswer = Extract<DecisionAnswer, { type: 'choice' }>;
export type ScoreAnswer = Extract<DecisionAnswer, { type: 'score' }>;

export interface DecisionClient {
  readonly model: string;
  evaluate(input: DecisionInput, questions: DecisionQuestions): Promise<DecisionResponse>;
}

export interface DecisionAdapter {
  readonly baseURL: string;
  readonly path: string;
  encode(model: string, input: DecisionInput, questions: DecisionQuestions): unknown;
  decode(response: unknown): DecisionResponse;
}

/** Incomplete or refused judgments must never become permission to speak. */
export function validateAnswers(response: DecisionResponse, questions: DecisionQuestions): DecisionResponse {
  for (const [name, question] of Object.entries(questions)) {
    const answer = response.answers[name];
    if (!answer || answer.type !== question.type) {
      throw new Error(`Decision response is missing or has an invalid answer "${name}"`);
    }
    if (question.type === 'choice' && answer.type === 'choice') {
      if (!Object.hasOwn(question.criteria, answer.choice)) {
        throw new Error(`Decision response has an unknown choice for "${name}"`);
      }
    }
    if (question.type === 'score' && answer.type === 'score' && answer.score > question.criteria.length - 1) {
      throw new Error(`Decision response has an out-of-range score for "${name}"`);
    }
    if (question.type !== 'predicate' && answer.type !== 'predicate') {
      const keys = Object.keys(question.criteria);
      if (
        keys.length !== Object.keys(answer.probabilities).length ||
        keys.some((key) => !Object.hasOwn(answer.probabilities, key))
      ) {
        throw new Error(`Decision response has incomplete probabilities for "${name}"`);
      }
    }
  }
  return response;
}
