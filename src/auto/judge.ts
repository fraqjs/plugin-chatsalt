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
 * Questions follow TypeSafe's guidance: English instructions, one judgment each, boundary cases spelled
 * out in the criteria. In Choice questions the option leading to silence comes first, so Jev's bias
 * towards the first option errs on the quiet side.
 */
export function buildJevQuestions(flags: JudgeFlags): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    addressee: {
      type: 'choice',
      instructions: 'Who is `target_message.text` directed at?',
      criteria: {
        others:
          'Specific group members other than the bot, or a reply to another member. ' +
          'Includes chatting between friends, e.g. "@阿光 你也太强了", "哈哈你说得对".',
        group: 'The group in general, with no specific addressee, e.g. "有没有人知道…", "今天好累", "这谱好难".',
        about_bot:
          'Talks ABOUT the bot in third person without asking it anything, e.g. "这 bot 好呆", "机器人又在说胡话".',
        bot:
          'Speaks TO the bot: calls it by one of `bot.names` and asks or tells it something, ' +
          'e.g. "纱露朵你觉得呢", "bot 这谱定数多少". Quoting "the bot" also counts.',
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
    invites_input: {
      type: 'noul',
      instructions:
        'Does `target_message.text` ask a genuine question or describe a problem that a knowledgeable person could answer?',
      criteria: {
        true: 'A real request for information, help, or a recommendation, e.g. "这谱怎么打", "定数多少", "有推荐的吗".',
        false:
          'Exclamations, jokes, memes, rhetorical questions, bragging, complaints, or emotes, e.g. "这谱谁写的啊（恼）", "草", "我又出了".',
      },
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
  invitesInput: number;
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
  if (a.addressee?.type !== 'choice' || a.topic_fit?.type !== 'score') {
    throw new Error('Jev response is missing answer "addressee" or "topic_fit"');
  }
  return {
    model: response.model,
    inputTokens: response.usage.input_tokens,
    addressee: a.addressee,
    topicFit: a.topic_fit,
    invitesInput: required('invites_input'),
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
  /** Minimum expected `topic_fit` score (0-3) to interject. */
  topicFit: number;
  /** Minimum `invites_input` to interject. */
  invitesInput: number;
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
  invitesInput: 0.7,
  privateExchange: 0.4,
  sensitive: 0.6,
  wantsBotQuiet: 0.7,
};

export type ReplyReason = 'implicit_address' | 'continuation' | 'in_domain_question';
export type SilenceReason = 'mute' | 'sensitive' | 'none';

export type Verdict = { action: 'reply'; reason: ReplyReason } | { action: 'silent' | 'mute'; reason: SilenceReason };

/** Pure decision over Jev's answers; rules change here without new Jev requests. */
export function decide(answers: JudgeAnswers, flags: JudgeFlags, t: Thresholds): Verdict {
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
    return { action: 'reply', reason: 'implicit_address' };
  }
  if (answers.respondsToBot !== undefined && answers.respondsToBot >= t.continuation) {
    return { action: 'reply', reason: 'continuation' };
  }
  if (
    answers.topicFit.score >= t.topicFit &&
    answers.invitesInput >= t.invitesInput &&
    answers.privateExchange < t.privateExchange &&
    answers.addressee.choice !== 'others'
  ) {
    return { action: 'reply', reason: 'in_domain_question' };
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
    invites_input: round(answers.invitesInput),
    private_exchange: round(answers.privateExchange),
    sensitive: round(answers.sensitive),
    wants_bot_quiet: round(answers.wantsBotQuiet),
  };
  if (answers.respondsToBot !== undefined) {
    summary.responds_to_bot = round(answers.respondsToBot);
  }
  return summary;
}
