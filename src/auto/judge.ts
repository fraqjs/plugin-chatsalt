import type { ChoiceAnswer, JevQuestion, NoulAnswer, ScoreAnswer, SystemOneResponse } from './jev';

/** A group message reduced to what Jev needs. */
export interface BufferedMessage {
  seq: number;
  senderId: number;
  /** Group card or nickname; "the bot" for the bot itself. */
  speaker: string;
  text: string;
  /** Speaker of the quoted message, if the message quotes one. */
  quotes: string | null;
  fromBot: boolean;
}

export interface JudgeProfile {
  names: string[];
  expertise: string;
  avoidTopics: string[];
}

export interface JudgeFlags {
  /** Whether the target text contains one of the bot's names (matched in code). */
  mentionsBotName: boolean;
  /** Whether the bot spoke within the messages sent as context. */
  botSpokeRecently: boolean;
}

export const BOT_SPEAKER = 'the bot';
const MAX_TEXT_LENGTH = 300;

function clip(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

export function buildJevState(
  profile: JudgeProfile,
  context: BufferedMessage[],
  target: BufferedMessage,
  flags: JudgeFlags,
): Record<string, unknown> {
  return {
    bot: {
      names: profile.names,
      expertise: profile.expertise,
      avoid_topics: profile.avoidTopics,
    },
    recent_messages: context.map((m) => ({ speaker: m.speaker, text: clip(m.text) })),
    target_message: {
      speaker: target.speaker,
      text: clip(target.text),
      quotes: target.quotes,
      mentions_bot_name: flags.mentionsBotName,
    },
    bot_spoke_recently: flags.botSpokeRecently,
  };
}

/**
 * What a message is for, named by the social response it calls for rather than by any community's
 * vocabulary; domain slang comes from {@link IntentHints}. `chatter` is the fallback and comes first, so
 * Jev's lean towards the first option errs on the quiet side.
 */
export const INTENTS = ['chatter', 'share_setback', 'share_success', 'discussion', 'question'] as const;
export type Intent = (typeof INTENTS)[number];

/** Domain-specific phrasings per intent, appended to the built-in, domain-neutral criteria. */
export type IntentHints = Partial<Record<Intent, string[]>>;

const INTENT_CRITERIA: Record<Intent, string> = {
  chatter:
    'Casual chatter, jokes, memes, emotes, greetings, reactions to other members, or daily-life small talk; ' +
    'also anything that fits no other option, e.g. "草", "哈哈哈", "晚上吃啥", "你说得对", "牛".',
  share_setback:
    'The speaker shares their own everyday failure, bad luck, or frustration without asking for help, ' +
    'e.g. "又挂了", "今天好倒霉", "加班到现在", "又失败了，好烦". Not a question, and not serious personal distress.',
  share_success:
    'The speaker shares their own accomplishment, progress, or good luck, ' +
    'e.g. "考过了", "终于上线了", "抽到了", "我做到了", "拿到 offer 了".',
  discussion:
    'Shares information or news for others, or states an opinion that invites reactions, ' +
    'e.g. "新版本出了", "下周有活动", "我觉得这个比那个好用", "这次更新好烂".',
  question:
    'A genuine request for information, help, or a recommendation, e.g. "这个怎么弄", "有人知道…吗", "有推荐的吗". ' +
    'Rhetorical questions and complaints phrased as questions do not count, e.g. "这谁设计的啊（恼）".',
};

function intentCriteria(hints: IntentHints): Record<Intent, string> {
  const criteria = { ...INTENT_CRITERIA };
  for (const intent of INTENTS) {
    const examples = hints[intent]?.filter((h) => h.trim());
    if (examples && examples.length > 0) {
      criteria[intent] += ` In this group, also e.g. ${examples.map((h) => JSON.stringify(h)).join(', ')}.`;
    }
  }
  return criteria;
}

/**
 * Questions follow TypeSafe's guidance: English instructions, one judgment each, boundary cases spelled
 * out in the criteria. In Choice questions the option leading to silence comes first, so Jev's bias
 * towards the first option errs on the quiet side.
 */
export function buildJevQuestions(flags: JudgeFlags, hints: IntentHints = {}): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    addressee: {
      type: 'choice',
      instructions: 'Who is `target_message.text` directed at?',
      criteria: {
        others:
          'Specific group members other than the bot, or a reply to another member. ' +
          'Includes chatting between friends, e.g. "@阿光 你也太强了", "哈哈你说得对".',
        group: 'The group in general, with no specific addressee, e.g. "有没有人知道…", "今天好累", "这个好难".',
        about_bot:
          'Talks ABOUT the bot in third person without asking it anything, e.g. "这 bot 好呆", "机器人又在说胡话".',
        bot:
          'Speaks TO the bot: calls it by one of `bot.names` and asks or tells it something, ' +
          'e.g. "<a name from bot.names> 你觉得呢", "bot 这个怎么弄". Quoting "the bot" also counts.',
      },
    },
    topic_fit: {
      type: 'score',
      instructions:
        'How closely is `target_message.text`, read together with `recent_messages`, about `bot.expertise`?',
      criteria: [
        'Unrelated to bot.expertise.',
        'Mentions something from bot.expertise only in passing; the main point is something else (jokes, daily life, other topics).',
        'Mainly about a topic in bot.expertise.',
        'Mainly about bot.expertise AND needs specific knowledge of it to answer or discuss well.',
      ],
    },
    intent: {
      type: 'choice',
      instructions: 'What is the main purpose of `target_message.text`?',
      criteria: intentCriteria(hints),
    },
    private_exchange: {
      type: 'noul',
      instructions:
        'Are `target_message` and the messages right before it in `recent_messages` a back-and-forth between specific people that an outsider would be interrupting?',
    },
    sensitive: {
      type: 'noul',
      instructions:
        'Is `target_message` or the conversation in `recent_messages` about any of `bot.avoid_topics`, an argument between members, or someone in real distress?',
    },
    wants_bot_quiet: {
      type: 'noul',
      instructions:
        'Does `target_message.text` tell the bot to stop talking, complain about the bot, or show annoyance at the bot?',
      criteria: {
        true: 'e.g. "bot 闭嘴", "又来了", "能不能把这 bot 踢了", "别刷屏了".',
        false: 'Anything else, including friendly teasing of the bot.',
      },
    },
  };
  if (flags.botSpokeRecently) {
    questions.responds_to_bot = {
      type: 'noul',
      instructions:
        'Is `target_message.text` a direct reaction to the latest message from "the bot" in `recent_messages`?',
      criteria: {
        true: 'It answers, questions, or reacts to what the bot just said, e.g. "真的假的？", "那 xx 呢", "谢谢".',
        false: 'It continues a different thread or starts a new topic.',
      },
    };
  }
  return questions;
}

export interface JudgeAnswers {
  model: string;
  inputTokens: number;
  addressee: ChoiceAnswer;
  topicFit: ScoreAnswer;
  intent: ChoiceAnswer;
  privateExchange: number;
  sensitive: number;
  wantsBotQuiet: number;
  respondsToBot?: number;
}

export function parseJevAnswers(response: SystemOneResponse): JudgeAnswers {
  const a = response.answers;
  const noul = (key: string) => (a[key] as NoulAnswer | undefined)?.noul;
  const required = (key: string) => {
    const value = noul(key);
    if (value === undefined) {
      throw new Error(`Jev response is missing answer "${key}"`);
    }
    return value;
  };
  if (a.addressee?.type !== 'choice' || a.topic_fit?.type !== 'score' || a.intent?.type !== 'choice') {
    throw new Error('Jev response is missing answer "addressee", "topic_fit" or "intent"');
  }
  return {
    model: response.model,
    inputTokens: response.usage.input_tokens,
    addressee: a.addressee,
    topicFit: a.topic_fit,
    intent: a.intent,
    privateExchange: required('private_exchange'),
    sensitive: required('sensitive'),
    wantsBotQuiet: required('wants_bot_quiet'),
    respondsToBot: noul('responds_to_bot'),
  };
}

export interface Thresholds {
  /** Minimum probability of `addressee = bot` to answer an implicit call. */
  addressed: number;
  /** Minimum `responds_to_bot` to continue the bot's conversation. */
  continuation: number;
  /** Minimum expected `topic_fit` score (0-3) to interject, unless an interject rule sets its own. */
  topicFit: number;
  /** Maximum `private_exchange` to interject. */
  privateExchange: number;
  /** At or above this `sensitive`, stay silent whatever else holds. */
  sensitive: number;
  /** At or above this `wants_bot_quiet`, mute auto mode in the group. */
  wantsBotQuiet: number;
}

export const defaultThresholds: Thresholds = {
  addressed: 0.75,
  continuation: 0.7,
  topicFit: 2.3,
  privateExchange: 0.4,
  sensitive: 0.6,
  wantsBotQuiet: 0.7,
};

/**
 * When the bot may interject on an intent: the minimum probability Jev must give it, and optionally a
 * topic requirement replacing the global `thresholds.topicFit`. A bare number is the probability alone.
 */
export type InterjectRule = number | { probability: number; topicFit?: number };

/**
 * Intents the bot may interject on. An intent left out is never a reason to interject; an intent listed
 * here is one the operator wants the bot to respond to, so the chat model is not told to hold back on it.
 */
export type InterjectRules = Partial<Record<Intent, InterjectRule>>;

export const defaultInterjectRules: InterjectRules = {
  question: 0.6,
  share_success: 0.6,
};

export function resolveInterjectRule(rule: InterjectRule, t: Thresholds): { probability: number; topicFit: number } {
  return typeof rule === 'number'
    ? { probability: rule, topicFit: t.topicFit }
    : { probability: rule.probability, topicFit: rule.topicFit ?? t.topicFit };
}

export type ReplyReason = 'implicit_address' | 'continuation' | 'interjection';
export type SilenceReason = 'mute' | 'sensitive' | 'none';

export type Verdict =
  | {
      action: 'reply';
      reason: ReplyReason;
      /**
       * Jev's top intent for the message, which decides how the bot responds. It may differ from the intent
       * that passed the interject rules (say, with a rule's minimum set to 0), so the chat model is always
       * told what the message actually looks like, not what the rules assumed.
       */
      intent: Intent;
      /**
       * Whether the operator listed `intent` in the interject rules. If so the chat model is encouraged to
       * respond; if the message only got through on another intent's rule, it is told to be cautious.
       */
      intentEnabled: boolean;
    }
  | { action: 'silent' | 'mute'; reason: SilenceReason };

function topIntent(answers: JudgeAnswers): Intent {
  const choice = answers.intent.choice as Intent;
  return INTENTS.includes(choice) ? choice : 'chatter';
}

/** Pure decision over Jev's answers; rules change here without new Jev requests. */
export function decide(answers: JudgeAnswers, flags: JudgeFlags, t: Thresholds, interject: InterjectRules): Verdict {
  const intent = topIntent(answers);
  const intentEnabled = interject[intent] !== undefined;
  // "别刷屏了" may target a member; only treat it as aimed at the bot when the bot is involved.
  const botInvolved =
    flags.botSpokeRecently ||
    flags.mentionsBotName ||
    answers.addressee.choice === 'bot' ||
    answers.addressee.choice === 'about_bot';
  if (botInvolved && answers.wantsBotQuiet >= t.wantsBotQuiet) {
    return { action: 'mute', reason: 'mute' };
  }
  if (answers.sensitive >= t.sensitive) {
    return { action: 'silent', reason: 'sensitive' };
  }
  if ((answers.addressee.probabilities.bot ?? 0) >= t.addressed) {
    return { action: 'reply', reason: 'implicit_address', intent, intentEnabled };
  }
  if (answers.respondsToBot !== undefined && answers.respondsToBot >= t.continuation) {
    return { action: 'reply', reason: 'continuation', intent, intentEnabled };
  }
  if (answers.privateExchange >= t.privateExchange || answers.addressee.choice === 'others') {
    return { action: 'silent', reason: 'none' };
  }
  const allowed = Object.entries(interject).some(([key, rule]) => {
    if (rule === undefined) {
      return false;
    }
    const { probability, topicFit } = resolveInterjectRule(rule, t);
    return (answers.intent.probabilities[key] ?? 0) >= probability && answers.topicFit.score >= topicFit;
  });
  if (allowed) {
    return { action: 'reply', reason: 'interjection', intent, intentEnabled };
  }
  return { action: 'silent', reason: 'none' };
}

/** Compact numbers for logs and the WebUI. */
export function summarizeAnswers(answers: JudgeAnswers): Record<string, number | string> {
  const round = (n: number) => Math.round(n * 100) / 100;
  const summary: Record<string, number | string> = {
    addressee: answers.addressee.choice,
    to_bot: round(answers.addressee.probabilities.bot ?? 0),
    topic_fit: round(answers.topicFit.score),
    intent: `${answers.intent.choice}(${round(answers.intent.probabilities[answers.intent.choice] ?? 0)})`,
    private_exchange: round(answers.privateExchange),
    sensitive: round(answers.sensitive),
    wants_bot_quiet: round(answers.wantsBotQuiet),
  };
  if (answers.respondsToBot !== undefined) {
    summary.responds_to_bot = round(answers.respondsToBot);
  }
  return summary;
}
