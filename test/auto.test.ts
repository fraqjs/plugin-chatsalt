import type { Logger, milky } from '@fraqjs/fraq';

import { ActivityRegistry } from '../src/activity';
import type { JevClient, SystemOneResponse } from '../src/auto/jev';
import { decide, defaultThresholds, type JudgeAnswers, type JudgeFlags, type ReplyReason } from '../src/auto/judge';
import { AutoScheduler, type AutoSchedulerOptions } from '../src/auto/scheduler';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SELF = 10000;
const GROUP = 20000;

function answers(overrides: Partial<JudgeAnswers> & { toBot?: number; addresseeChoice?: string } = {}): JudgeAnswers {
  const toBot = overrides.toBot ?? 0.05;
  return {
    model: 'jev-test',
    inputTokens: 100,
    addressee: {
      type: 'choice',
      choice: overrides.addresseeChoice ?? 'group',
      confidence: 0.5,
      probabilities: { others: 0.1, group: 0.85 - toBot, about_bot: 0.05, bot: toBot },
    },
    topicFit: { type: 'score', score: 0.2, confidence: 0.8, legend: {}, probabilities: {} },
    invitesInput: 0.1,
    privateExchange: 0.1,
    sensitive: 0.05,
    wantsBotQuiet: 0.02,
    ...overrides,
  };
}

const quietFlags: JudgeFlags = { mentionsBotName: false, botSpokeRecently: false };

describe('decide', () => {
  it('stays silent on ordinary chatter', () => {
    assert.deepEqual(decide(answers(), quietFlags, defaultThresholds), { action: 'silent', reason: 'none' });
  });

  it('answers an implicit call', () => {
    const v = decide(answers({ toBot: 0.9, addresseeChoice: 'bot' }), quietFlags, defaultThresholds);
    assert.deepEqual(v, { action: 'reply', reason: 'implicit_address' });
  });

  it('interjects only when topic, question and openness all hold', () => {
    const inDomain = answers({
      topicFit: { type: 'score', score: 2.8, confidence: 0.7, legend: {}, probabilities: {} },
      invitesInput: 0.9,
    });
    assert.equal(decide(inDomain, quietFlags, defaultThresholds).action, 'reply');
    assert.equal(decide({ ...inDomain, privateExchange: 0.8 }, quietFlags, defaultThresholds).action, 'silent');
    assert.equal(decide({ ...inDomain, invitesInput: 0.3 }, quietFlags, defaultThresholds).action, 'silent');
  });

  it('only mutes when the bot is involved', () => {
    const complaint = answers({ wantsBotQuiet: 0.95 });
    assert.equal(decide(complaint, quietFlags, defaultThresholds).action, 'silent');
    assert.equal(decide(complaint, { ...quietFlags, botSpokeRecently: true }, defaultThresholds).action, 'mute');
  });

  it('lets sensitivity veto an implicit call', () => {
    const v = decide(answers({ toBot: 0.9, sensitive: 0.9 }), quietFlags, defaultThresholds);
    assert.deepEqual(v, { action: 'silent', reason: 'sensitive' });
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

/** A fake Jev whose answers depend on the target text. */
function fakeJev(byText: (text: string) => Partial<Record<string, number>>): JevClient {
  return {
    model: 'jev-test',
    async systemOne(state: { target_message: { text: string } }): Promise<SystemOneResponse> {
      const p: Record<string, number | undefined> & { to_bot: number; topic: number; invites: number } = {
        to_bot: 0.05,
        topic: 0.2,
        invites: 0.1,
        ...byText(state.target_message.text),
      };
      return {
        model: 'jev-test',
        usage: { input_tokens: 100, output_tokens: 0 },
        answers: {
          addressee: {
            type: 'choice',
            choice: p.to_bot > 0.5 ? 'bot' : 'group',
            confidence: 0.5,
            probabilities: { others: 0.05, group: 0.9 - p.to_bot, about_bot: 0.05, bot: p.to_bot },
          },
          topic_fit: { type: 'score', score: p.topic, confidence: 0.6, legend: {}, probabilities: {} },
          invites_input: { type: 'noul', noul: p.invites },
          private_exchange: { type: 'noul', noul: 0.1 },
          sensitive: { type: 'noul', noul: 0.05 },
          wants_bot_quiet: { type: 'noul', noul: p.quiet ?? 0.02 },
          responds_to_bot: { type: 'noul', noul: p.responds ?? 0.1 },
        },
      };
    },
  } as unknown as JevClient;
}

const logger = { warn() {}, error() {}, info() {}, debug() {} } as unknown as Logger;

function setup(jev: JevClient, overrides: Partial<AutoSchedulerOptions> = {}) {
  const activity = new ActivityRegistry({ conversationLimit: 10, warningLimit: 10, autoDecisionLimit: 50 });
  const runs: Array<{ seq: number; reason: ReplyReason }> = [];
  const scheduler = new AutoScheduler(
    jev,
    activity,
    logger,
    async (_selfId, message, reason) => {
      runs.push({ seq: message.message_seq, reason });
    },
    (ms, cb) => setTimeout(cb, ms),
    {
      groups: new Set([GROUP]),
      profile: { names: ['纱露朵'], expertise: 'maimai', avoidTopics: [] },
      thresholds: defaultThresholds,
      stateMessages: 8,
      debounceMs: 20,
      maxBurstWaitMs: 200,
      perHour: 3,
      minIntervalMs: 0,
      muteOnComplaintMs: 60_000,
      ...overrides,
    },
  );
  return { scheduler, activity, runs };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('AutoScheduler', () => {
  it('replies once per burst, preferring an implicit call over an interjection', async () => {
    const jev = fakeJev((text) =>
      text.includes('纱露朵') ? { to_bot: 0.9 } : text.includes('定数') ? { topic: 2.8, invites: 0.9 } : {},
    );
    const { scheduler, runs, activity } = setup(jev);
    scheduler.observe(SELF, groupMessage(1, 1, '纱露朵在吗'), false);
    scheduler.observe(SELF, groupMessage(2, 2, '这谱定数多少'), false);
    scheduler.observe(SELF, groupMessage(3, 3, '哈哈'), false);
    await wait(80);
    assert.deepEqual(runs, [{ seq: 1, reason: 'implicit_address' }]);
    const outcomes = Object.fromEntries(activity.listAutoDecisions().map((d) => [d.messageSeq, d.outcome]));
    assert.deepEqual(outcomes, { 1: 'selected', 2: 'superseded', 3: 'superseded' });
  });

  it('does not interject on a question that is no longer the newest message', async () => {
    const jev = fakeJev((text) => (text.includes('定数') ? { topic: 2.8, invites: 0.9 } : {}));
    const { scheduler, runs } = setup(jev);
    scheduler.observe(SELF, groupMessage(1, 1, '这谱定数多少'), false);
    scheduler.observe(SELF, groupMessage(2, 2, '14.7 吧'), false);
    await wait(80);
    assert.deepEqual(runs, []);
  });

  it('enforces the hourly interjection budget', async () => {
    const jev = fakeJev(() => ({ topic: 2.8, invites: 0.9 }));
    const { scheduler, runs, activity } = setup(jev, { perHour: 1 });
    scheduler.observe(SELF, groupMessage(1, 1, '这谱定数多少'), false);
    await wait(60);
    scheduler.observe(SELF, groupMessage(2, 2, '那另一首呢'), false);
    await wait(60);
    assert.equal(runs.length, 1);
    assert.equal(activity.listAutoDecisions()[0]?.outcome, 'budget');
  });

  it('skips judging during a direct trigger and after a complaint', async () => {
    const jev = fakeJev((text) => (text.includes('闭嘴') ? { quiet: 0.95 } : { to_bot: 0.9 }));
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
    const jev = fakeJev(() => ({ to_bot: 0.9 }));
    const { scheduler, runs, activity } = setup(jev);
    scheduler.observe(SELF, { ...groupMessage(1, 1, '纱露朵'), peer_id: 999 }, false);
    scheduler.observe(SELF, groupMessage(2, 1, '[图片]'), false);
    await wait(60);
    assert.deepEqual(runs, []);
    assert.equal(activity.listAutoDecisions().length, 0);
  });
});
