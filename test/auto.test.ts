import type { Logger, milky } from '@fraqjs/fraq';

import { ActivityRegistry } from '../src/activity';
import type { JevClient, SystemOneResponse } from '../src/auto/jev';
import {
  buildJevQuestions,
  decide,
  defaultInterjectRules,
  defaultThresholds,
  INTENTS,
  type Intent,
  type JudgeAnswers,
  type JudgeFlags,
} from '../src/auto/judge';
import { type AutoReply, AutoScheduler, type AutoSchedulerOptions } from '../src/auto/scheduler';
import { buildPromptMessage, buildSystemPrompt } from '../src/prompt';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SELF = 10000;
const GROUP = 20000;

function intentAnswer(probabilities: Partial<Record<Intent, number>>) {
  const full = Object.fromEntries(INTENTS.map((i) => [i, probabilities[i] ?? 0]));
  const choice = INTENTS.reduce((best, i) => (full[i] > full[best] ? i : best), INTENTS[0]);
  return { type: 'choice' as const, choice, confidence: 0.5, probabilities: full };
}

function answers(
  overrides: Partial<JudgeAnswers> & {
    toBot?: number;
    addresseeChoice?: string;
    intents?: Partial<Record<Intent, number>>;
  } = {},
): JudgeAnswers {
  const { toBot = 0.05, addresseeChoice = 'group', intents = { chatter: 0.9 }, ...rest } = overrides;
  return {
    model: 'jev-test',
    inputTokens: 100,
    addressee: {
      type: 'choice',
      choice: addresseeChoice,
      confidence: 0.5,
      probabilities: { others: 0.1, group: 0.85 - toBot, about_bot: 0.05, bot: toBot },
    },
    topicFit: { type: 'score', score: 0.2, confidence: 0.8, legend: {}, probabilities: {} },
    intent: intentAnswer(intents),
    privateExchange: 0.1,
    sensitive: 0.05,
    wantsBotQuiet: 0.02,
    ...rest,
  };
}

const inDomain = { type: 'score' as const, score: 2.8, confidence: 0.7, legend: {}, probabilities: {} };
const quietFlags: JudgeFlags = { mentionsBotName: false, botSpokeRecently: false };

describe('decide', () => {
  const d = (a: JudgeAnswers, flags = quietFlags, interject = defaultInterjectRules) =>
    decide(a, flags, defaultThresholds, interject);

  it('stays silent on ordinary chatter', () => {
    assert.deepEqual(d(answers()), { action: 'silent', reason: 'none' });
  });

  it('answers an implicit call and carries the intent', () => {
    const v = d(answers({ toBot: 0.9, addresseeChoice: 'bot', intents: { question: 0.8 } }));
    assert.deepEqual(v, { action: 'reply', reason: 'implicit_address', intent: 'question', intentEnabled: true });
  });

  it('interjects on enabled intents in the expertise only', () => {
    const achievement = answers({ topicFit: inDomain, intents: { share_success: 0.85 } });
    assert.deepEqual(d(achievement), {
      action: 'reply',
      reason: 'interjection',
      intent: 'share_success',
      intentEnabled: true,
    });
    assert.equal(d({ ...achievement, topicFit: { ...inDomain, score: 1 } }).action, 'silent');
    assert.equal(d({ ...achievement, privateExchange: 0.8 }).action, 'silent');
    assert.equal(d(answers({ topicFit: inDomain, intents: { discussion: 0.85 } })).action, 'silent');
  });

  it('reports the actual top intent, not enabled, when a rule lets another one pass', () => {
    // A minimum of 0 lets every in-domain message through; the reply must still be framed as chatter.
    const v = d(answers({ topicFit: inDomain, intents: { chatter: 0.9 } }), quietFlags, { question: 0 });
    assert.deepEqual(v, { action: 'reply', reason: 'interjection', intent: 'chatter', intentEnabled: false });
  });

  it('applies a per-intent topic requirement', () => {
    const offTopicChatter = answers({ intents: { chatter: 0.9 } }); // topic_fit 0.2
    assert.equal(d(offTopicChatter, quietFlags, { chatter: 0.6 }).action, 'silent');
    assert.deepEqual(d(offTopicChatter, quietFlags, { chatter: { probability: 0.6, topicFit: 0 } }), {
      action: 'reply',
      reason: 'interjection',
      intent: 'chatter',
      intentEnabled: true,
    });
    // Still never butts into a private exchange.
    const privateChatter = { ...offTopicChatter, privateExchange: 0.9 };
    assert.equal(d(privateChatter, quietFlags, { chatter: { probability: 0.6, topicFit: 0 } }).action, 'silent');
  });

  it('only mutes when the bot is involved', () => {
    const complaint = answers({ wantsBotQuiet: 0.95 });
    assert.equal(d(complaint).action, 'silent');
    assert.equal(d(complaint, { ...quietFlags, botSpokeRecently: true }).action, 'mute');
  });

  it('lets sensitivity veto an implicit call', () => {
    assert.deepEqual(d(answers({ toBot: 0.9, sensitive: 0.9 })), { action: 'silent', reason: 'sensitive' });
  });
});

describe('intent question', () => {
  const criteriaOf = (questions: ReturnType<typeof buildJevQuestions>) => {
    const intent = questions.intent;
    assert.equal(intent?.type, 'choice');
    return intent.type === 'choice' ? (intent.criteria as Record<string, string>) : {};
  };

  it('keeps built-in examples free of any one community', () => {
    const all = JSON.stringify(buildJevQuestions({ mentionsBotName: false, botSpokeRecently: true }));
    for (const word of ['谱', '定数', '鸟加', '纱露朵', 'rating']) {
      assert.ok(!all.includes(word), `built-in questions mention ${word}`);
    }
  });

  it('appends configured hints to their intent only', () => {
    const criteria = criteriaOf(
      buildJevQuestions({ mentionsBotName: false, botSpokeRecently: false }, { share_success: ['鸟加了', 'AP 了'] }),
    );
    assert.match(criteria.share_success ?? '', /In this group, also e\.g\. "鸟加了", "AP 了"\./);
    assert.doesNotMatch(criteria.question ?? '', /鸟加/);
  });
});

describe('auto prompt', () => {
  const build = (intent: Intent, targetIsLatest = true, intentEnabled = true) => {
    const message = buildPromptMessage({
      selfId: SELF,
      scene: 'group',
      peerId: GROUP,
      senderId: 1,
      senderName: 'a',
      messageSeq: 5,
      targetIsLatest,
      thread: ['<message/>'],
      auto: { reason: 'interjection', intent, intentEnabled, expertise: 'maimai' },
    });
    const parts = message.content as Array<{ text: string }>;
    return parts.at(-1)?.text ?? '';
  };

  it('frames the reply by intent and asks for a reason on no_reply', () => {
    assert.match(build('share_success'), /祝贺/);
    assert.doesNotMatch(build('chatter'), /祝贺/);
    assert.match(build('question'), /no_reply \(/);
  });

  it('encourages enabled intents and holds back on the rest', () => {
    const open = build('chatter', true, true);
    assert.match(open, /像普通群友一样自然地接一句/);
    assert.doesNotMatch(open, /并不需要你回应/);
    assert.match(build('chatter', true, false), /并不需要你回应/);
    assert.match(build('share_success', true, false), /通常不需要你回应/);
  });

  it('keeps the expertise limit to knowledge intents and the no-fabrication rule everywhere', () => {
    assert.match(build('question'), /只聊和你擅长领域有关的内容/);
    assert.match(build('discussion'), /只聊和你擅长领域有关的内容/);
    assert.doesNotMatch(build('chatter'), /只聊和你擅长领域有关的内容/);
    for (const intent of ['chatter', 'share_success', 'share_setback'] as const) {
      assert.match(build(intent), /不要编造/);
    }
  });

  it('points at an older target by seq', () => {
    assert.match(build('question', false), /seq 为 5 的消息。它之后/);
  });

  it('tells the date and forbids denying unknown things', () => {
    const message = buildPromptMessage({
      selfId: SELF,
      scene: 'group',
      peerId: GROUP,
      senderId: 1,
      senderName: 'a',
      messageSeq: 5,
      thread: ['<message/>'],
      now: new Date(2026, 9, 25),
    });
    const parts = message.content as Array<{ text: string }>;
    assert.match(parts.at(-1)?.text ?? '', /今天是 2026 年 10 月 25 日/);
    assert.match(build('question'), /断言某样东西不存在/);
  });
});

describe('system prompt', () => {
  it('warns about the training cutoff regardless of the security prompt', () => {
    const prompt = buildSystemPrompt({
      persona: 'p',
      disableBuiltinSecurityPrompt: true,
      memoryEnabled: false,
      webSearchEnabled: false,
      webPageEnabled: false,
      githubEnabled: false,
    });
    assert.match(prompt, /# 知识时效/);
    assert.match(prompt, /不要断言它不存在/);
  });
});

function groupMessage(seq: number, senderId: number, text: string): milky.IncomingGroupMessage {
  return {
    message_scene: 'group',
    peer_id: GROUP,
    message_seq: seq,
    sender_id: senderId,
    time: 0,
    segments: [{ type: 'text', data: { text } }],
    group: {} as milky.IncomingGroupMessage['group'],
    group_member: { card: `user${senderId}`, nickname: '' } as milky.IncomingGroupMessage['group_member'],
  };
}

interface FakeAnswer {
  toBot?: number;
  topic?: number;
  intents?: Partial<Record<Intent, number>>;
  quiet?: number;
}

/** A fake Jev whose answers depend on the target text. */
function fakeJev(byText: (text: string) => FakeAnswer): JevClient {
  return {
    model: 'jev-test',
    async systemOne(state: { target_message: { text: string } }): Promise<SystemOneResponse> {
      const p = byText(state.target_message.text);
      const toBot = p.toBot ?? 0.05;
      return {
        model: 'jev-test',
        usage: { input_tokens: 100, output_tokens: 0 },
        answers: {
          addressee: {
            type: 'choice',
            choice: toBot > 0.5 ? 'bot' : 'group',
            confidence: 0.5,
            probabilities: { others: 0.05, group: 0.9 - toBot, about_bot: 0.05, bot: toBot },
          },
          topic_fit: { type: 'score', score: p.topic ?? 0.2, confidence: 0.6, legend: {}, probabilities: {} },
          intent: intentAnswer(p.intents ?? { chatter: 0.9 }),
          private_exchange: { type: 'noul', noul: 0.1 },
          sensitive: { type: 'noul', noul: 0.05 },
          wants_bot_quiet: { type: 'noul', noul: p.quiet ?? 0.02 },
          responds_to_bot: { type: 'noul', noul: 0.1 },
        },
      };
    },
  } as unknown as JevClient;
}

const achievement: FakeAnswer = { topic: 2.8, intents: { share_success: 0.9 } };
const question: FakeAnswer = { topic: 2.8, intents: { question: 0.9 } };

const logger = { warn() {}, error() {}, info() {}, debug() {} } as unknown as Logger;

function setup(jev: JevClient, overrides: Partial<AutoSchedulerOptions> = {}) {
  const activity = new ActivityRegistry({ conversationLimit: 10, warningLimit: 10, autoDecisionLimit: 50 });
  const runs: Array<{ seq: number } & AutoReply> = [];
  const scheduler = new AutoScheduler(
    jev,
    activity,
    logger,
    async (_selfId, message, reply) => {
      runs.push({ seq: message.message_seq, ...reply });
    },
    (ms, cb) => setTimeout(cb, ms),
    {
      groups: new Set([GROUP]),
      profile: { names: ['纱露朵'], expertise: 'maimai', avoidTopics: [] },
      thresholds: defaultThresholds,
      interject: defaultInterjectRules,
      intentHints: {},
      interjectWithin: 3,
      stateMessages: 8,
      debounceMs: 20,
      maxBurstWaitMs: 200,
      perHour: 3,
      minIntervalMs: 0,
      perUserIntervalMs: 0,
      muteOnComplaintMs: 60_000,
      ...overrides,
    },
  );
  return { scheduler, activity, runs };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AutoScheduler', () => {
  it('replies once per burst, preferring an implicit call over an interjection', async () => {
    const jev = fakeJev((text) => (text.includes('纱露朵') ? { toBot: 0.9 } : text.includes('定数') ? question : {}));
    const { scheduler, runs, activity } = setup(jev);
    scheduler.observe(SELF, groupMessage(1, 1, '纱露朵在吗'), false);
    scheduler.observe(SELF, groupMessage(2, 2, '这谱定数多少'), false);
    scheduler.observe(SELF, groupMessage(3, 3, '哈哈'), false);
    await wait(80);
    assert.deepEqual(runs, [
      { seq: 1, reason: 'implicit_address', intent: 'chatter', intentEnabled: false, latestSeq: 3 },
    ]);
    const outcomes = Object.fromEntries(activity.listAutoDecisions().map((d) => [d.messageSeq, d.outcome]));
    assert.deepEqual(outcomes, { 1: 'selected', 2: 'superseded', 3: 'superseded' });
  });

  it('congratulates an achievement followed by a few reactions', async () => {
    const jev = fakeJev((text) => (text.includes('收了') ? achievement : {}));
    const { scheduler, runs } = setup(jev);
    scheduler.observe(SELF, groupMessage(1, 1, '我今天把Xaleid scopiX收了'), false);
    scheduler.observe(SELF, groupMessage(2, 2, '牛'), false);
    scheduler.observe(SELF, groupMessage(3, 3, '恭喜'), false);
    await wait(80);
    assert.deepEqual(runs, [
      { seq: 1, reason: 'interjection', intent: 'share_success', intentEnabled: true, latestSeq: 3 },
    ]);
  });

  it('does not interject on a message the chat has moved past', async () => {
    const jev = fakeJev((text) => (text.includes('定数') ? question : {}));
    const { scheduler, runs } = setup(jev, { interjectWithin: 2 });
    scheduler.observe(SELF, groupMessage(1, 1, '这谱定数多少'), false);
    scheduler.observe(SELF, groupMessage(2, 2, '14.7 吧'), false);
    scheduler.observe(SELF, groupMessage(3, 1, '谢谢'), false);
    await wait(80);
    assert.deepEqual(runs, []);
  });

  it('enforces the hourly and per-member budgets', async () => {
    const hourly = setup(
      fakeJev(() => question),
      { perHour: 1 },
    );
    hourly.scheduler.observe(SELF, groupMessage(1, 1, '这谱定数多少'), false);
    await wait(60);
    hourly.scheduler.observe(SELF, groupMessage(2, 2, '那另一首呢'), false);
    await wait(60);
    assert.equal(hourly.runs.length, 1);
    assert.equal(hourly.activity.listAutoDecisions()[0]?.outcome, 'budget');

    const perUser = setup(
      fakeJev(() => achievement),
      { perUserIntervalMs: 60_000 },
    );
    perUser.scheduler.observe(SELF, groupMessage(1, 1, '收了一首'), false);
    await wait(60);
    perUser.scheduler.observe(SELF, groupMessage(2, 1, '又收了一首'), false);
    await wait(60);
    perUser.scheduler.observe(SELF, groupMessage(3, 2, '我也收了'), false);
    await wait(60);
    assert.deepEqual(
      perUser.runs.map((r) => r.seq),
      [1, 3],
    );
  });

  it('skips judging during a direct trigger and after a complaint', async () => {
    const jev = fakeJev((text) => (text.includes('闭嘴') ? { quiet: 0.95 } : { toBot: 0.9 }));
    const { scheduler, runs, activity } = setup(jev);
    scheduler.observe(SELF, groupMessage(1, 1, '纱露朵在吗'), false);
    scheduler.observe(SELF, groupMessage(2, 1, '@纱露朵 你好'), true);
    await wait(60);
    assert.deepEqual(runs, []);
    assert.equal(activity.listAutoDecisions()[0]?.outcome, 'direct');

    scheduler.recordBotMessage(GROUP, 3, '你好呀');
    scheduler.observe(SELF, groupMessage(4, 2, 'bot 闭嘴'), false);
    await wait(60);
    scheduler.observe(SELF, groupMessage(5, 3, '纱露朵你好'), false);
    await wait(60);
    assert.deepEqual(runs, []);
    assert.equal(activity.listWarnings()[0]?.kind, 'auto');
  });

  it('ignores groups outside the allowlist and placeholder-only messages', async () => {
    const { scheduler, runs, activity } = setup(fakeJev(() => ({ toBot: 0.9 })));
    scheduler.observe(SELF, { ...groupMessage(1, 1, '纱露朵'), peer_id: 999 }, false);
    scheduler.observe(SELF, groupMessage(2, 1, '[图片]'), false);
    await wait(60);
    assert.deepEqual(runs, []);
    assert.equal(activity.listAutoDecisions().length, 0);
  });
});
