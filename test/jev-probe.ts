/**
 * Sends a few hand-written group chat samples to Jev and prints the answers and the resulting verdict,
 * to sanity-check questions and thresholds before turning auto mode on.
 *
 *   TYPESAFE_API_KEY=... [TYPESAFE_BASE_URL=https://.../v1] pnpm tsx test/jev-probe.ts
 *
 * Set PROBE_NO_HINTS=1 to compare against the domain-neutral criteria alone.
 */
import 'dotenv/config';

import { DEFAULT_JEV_BASE_URL, JevClient } from '../src/auto/jev';
import {
  BOT_SPEAKER,
  type BufferedMessage,
  buildJevQuestions,
  buildJevState,
  decide,
  defaultInterjectRules,
  defaultThresholds,
  type IntentHints,
  type JudgeProfile,
  parseJevAnswers,
  summarizeAnswers,
} from '../src/auto/judge';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  throw new Error('请设置 TYPESAFE_API_KEY');
}

const jev = new JevClient({
  apiKey,
  model: process.env.JEV_MODEL ?? 'jev-1.14.0',
  baseURL: process.env.TYPESAFE_BASE_URL ?? DEFAULT_JEV_BASE_URL,
  timeoutMs: 10_000,
  maxRetries: 2,
});

const profile: JudgeProfile = {
  names: ['纱露朵', '盐', 'salt', 'bot', '机器人'],
  expertise: 'maimai DX (舞萌) rhythm game: charts, difficulty constants, rating, song unlocks, play technique.',
  avoidTopics: ['politics', 'history', 'romance or sexual content'],
};

/** Rhythm game slang Jev would not otherwise recognize; the built-in criteria stay domain-neutral. */
const intentHints: IntentHints = {
  share_success: ['我把 xx 收了', '鸟了', '鸟加了', 'AP 了', 'FC 了', 'rating 推到 15000 了', '终于出了'],
  share_setback: ['又寄了', '这谱根本打不过', '手好酸'],
  question: ['这谱怎么打', '定数多少'],
};
const withHints = process.env.PROBE_NO_HINTS !== '1';

let seq = 0;
const m = (speaker: string, text: string, quotes: string | null = null): BufferedMessage => ({
  seq: ++seq,
  senderId: speaker === BOT_SPEAKER ? 0 : speaker.length,
  speaker,
  text,
  quotes,
  fromBot: speaker === BOT_SPEAKER,
});

/** Each sample: context, target, and the verdict a human would expect. */
const samples: Array<{ expect: string; context: BufferedMessage[]; target: BufferedMessage }> = [
  { expect: 'silent', context: [m('阿光', '今天好热'), m('小林', '是啊')], target: m('阿光', '晚上吃啥') },
  {
    expect: 'reply · interjection (question)',
    context: [m('阿光', '今天出勤了'), m('小林', '推分了吗')],
    target: m('阿光', '有没有人知道 PANDORA PARADOXXX 紫谱定数多少'),
  },
  {
    expect: 'reply · interjection (share_success)',
    context: [m('阿光', '今天出勤人好多'), m('小林', '排了半小时')],
    target: m('阿光', '我今天把Xaleid scopiX收了'),
  },
  {
    expect: 'silent (share_setback)',
    context: [m('阿光', '今天出勤了')],
    target: m('阿光', '这谱根本打不过，手好酸'),
  },
  {
    expect: 'silent (meme)',
    context: [m('阿光', '我又寄了')],
    target: m('小林', '这谱谁写的啊（恼）'),
  },
  {
    expect: 'reply · implicit_address',
    context: [m('阿光', '今天推了 14+')],
    target: m('小林', '纱露朵你觉得阿光厉害吗'),
  },
  {
    expect: 'reply · continuation',
    context: [m('阿光', '纱露朵早'), m(BOT_SPEAKER, '早上好的说喵，今天也要好好吃早饭呢')],
    target: m('阿光', '吃了吃了，你吃了啥'),
  },
  {
    expect: 'silent (private exchange)',
    context: [m('阿光', '@小林 你昨天几点下的'), m('小林', '十一点多吧')],
    target: m('阿光', '那你这 rating 涨了多少'),
  },
  {
    expect: 'mute',
    context: [m(BOT_SPEAKER, '纱露朵也想一起去的说喵'), m('阿光', '...')],
    target: m('小林', 'bot 能不能闭嘴'),
  },
];

for (const { expect, context, target } of samples) {
  const flags = {
    mentionsBotName: profile.names.some((n) => target.text.toLowerCase().includes(n.toLowerCase())),
    botSpokeRecently: context.some((x) => x.fromBot),
  };
  const startedAt = performance.now();
  const response = await jev.systemOne(
    buildJevState(profile, context, target, flags),
    buildJevQuestions(flags, withHints ? intentHints : {}),
  );
  const answers = parseJevAnswers(response);
  const verdict = decide(answers, flags, defaultThresholds, defaultInterjectRules);
  console.log(`\n${target.speaker}: ${target.text}`);
  console.log(`  expect  ${expect}`);
  const intent = verdict.action === 'reply' ? ` (${verdict.intent})` : '';
  console.log(
    `  verdict ${verdict.action} · ${verdict.reason}${intent}  (${Math.round(performance.now() - startedAt)} ms)`,
  );
  console.log(`  ${JSON.stringify(summarizeAnswers(answers))}`);
}
