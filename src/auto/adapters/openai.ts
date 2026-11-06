import { z } from 'zod';

import { type DecisionAdapter, probabilitySchema, responseSchema } from '../decision-types';

const distributionSchema = z.array(
  z.object({
    value: z.union([z.string(), z.number().int().nonnegative()]),
    probability: probabilitySchema,
  }),
);
const wireSchema = z.object({
  model: z.string(),
  usage: z.object({ input_tokens: z.number() }),
  answers: z.array(
    z.discriminatedUnion('type', [
      z.object({ name: z.string(), type: z.literal('predicate'), probability: probabilitySchema }),
      z.object({
        name: z.string(),
        type: z.literal('choice'),
        choice: z.string(),
        confidence: probabilitySchema,
        probabilities: distributionSchema,
      }),
      z.object({
        name: z.string(),
        type: z.literal('score'),
        score: z.number(),
        confidence: probabilitySchema,
        probabilities: distributionSchema,
      }),
      z.object({ name: z.string(), type: z.literal('refusal') }),
    ]),
  ),
});

/** OpenAI Decisions: named arrays, predicate probabilities, and indexed score levels. */
export const openAIDecisionsAdapter: DecisionAdapter = {
  baseURL: 'https://api.openai.com/v1',
  path: '/decisions',
  encode(model, input, questions) {
    return {
      model,
      input: typeof input === 'string' ? input : [{ role: 'user', content: [{ type: 'input_json', data: input }] }],
      questions: Object.entries(questions).map(([name, question]) => {
        const common = { name, type: question.type, instructions: question.instructions };
        switch (question.type) {
          case 'predicate':
            return {
              ...common,
              instructions: [
                question.instructions,
                ...(question.criteria?.true === undefined ? [] : [`True criteria: ${question.criteria.true}`]),
                ...(question.criteria?.false === undefined ? [] : [`False criteria: ${question.criteria.false}`]),
              ].join('\n'),
            };
          case 'choice':
            return {
              ...common,
              choices: Object.entries(question.criteria).map(([value, description]) => ({
                value,
                ...(description === null ? {} : { description }),
              })),
            };
          case 'score':
            return {
              ...common,
              levels: question.criteria.map((description, index) => ({ label: String(index), description })),
            };
        }
        throw new Error(`Unsupported decision question "${name}"`);
      }),
    };
  },
  decode(data) {
    const response = wireSchema.parse(data);
    const names = new Set<string>();
    const answers = response.answers.map((answer) => {
      if (names.has(answer.name)) throw new Error(`Duplicate decision answer "${answer.name}"`);
      names.add(answer.name);
      if (answer.type === 'refusal') throw new Error(`Decision refused for "${answer.name}"`);
      if (answer.type === 'predicate') return [answer.name, answer];
      const probabilities = Object.fromEntries(
        answer.probabilities.map(({ value, probability }) => [String(value), probability]),
      );
      if (Object.keys(probabilities).length !== answer.probabilities.length) {
        throw new Error(`Duplicate decision probability for "${answer.name}"`);
      }
      return [answer.name, { ...answer, probabilities }];
    });
    return responseSchema.parse({ ...response, answers: Object.fromEntries(answers) });
  },
};
