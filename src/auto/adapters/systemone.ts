import { z } from 'zod';

import { type DecisionAdapter, probabilitySchema, responseSchema } from '../decision-types';

const wireSchema = z.object({
  model: z.string(),
  answers: z.record(
    z.string(),
    z.union([
      z.object({ type: z.literal('noul'), noul: probabilitySchema }),
      z.object({ type: z.enum(['choice', 'score']) }).passthrough(),
    ]),
  ),
  usage: z.object({ input_tokens: z.number() }),
});

/** TypeSafe System One: keyed questions/answers and `noul` predicates. */
export const systemOneAdapter: DecisionAdapter = {
  baseURL: 'https://api.typesafe.ai/v1',
  path: '/systemone',
  encode(model, state, questions) {
    return {
      model,
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([name, question]) => [
          name,
          { ...question, type: question.type === 'predicate' ? 'noul' : question.type },
        ]),
      ),
    };
  },
  decode(data) {
    const response = wireSchema.parse(data);
    return responseSchema.parse({
      ...response,
      answers: Object.fromEntries(
        Object.entries(response.answers).map(([name, answer]) => [
          name,
          answer.type === 'noul' ? { type: 'predicate', probability: answer.noul } : answer,
        ]),
      ),
    });
  },
};
