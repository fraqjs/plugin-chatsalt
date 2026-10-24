import type { Logger, milky } from '@fraqjs/fraq';

import { type ActivityRegistry, type AutoDecisionRecord, type AutoOutcome, summarizeMessage } from '../activity';
import { extractSenderName } from '../prompt';
import type { JevClient } from './jev';
import {
  BOT_SPEAKER,
  type BufferedMessage,
  buildJevQuestions,
  buildJevState,
  decide,
  type Intent,
  type IntentHints,
  type InterjectRules,
  type JudgeFlags,
  type JudgeProfile,
  parseJevAnswers,
  type ReplyReason,
  summarizeAnswers,
  type Thresholds,
  type Verdict,
} from './judge';

export interface AutoSchedulerOptions {
  groups: Set<number>;
  profile: JudgeProfile;
  thresholds: Thresholds;
  interject: InterjectRules;
  intentHints: IntentHints;
  /** An interjection target must be among this many latest messages when the burst settles. */
  interjectWithin: number;
  stateMessages: number;
  debounceMs: number;
  maxBurstWaitMs: number;
  /** Max interjections per group within any rolling hour. */
  perHour: number;
  /** Min gap between two interjections in a group. */
  minIntervalMs: number;
  /** Min gap between two interjections on the same member's messages. */
  perUserIntervalMs: number;
  muteOnComplaintMs: number;
}

/** Context-managed timer, cleared automatically when the plugin stops. */
export type TimerFactory = (delayMs: number, callback: () => void) => NodeJS.Timeout;

export interface AutoReply {
  reason: ReplyReason;
  intent: Intent;
  /** Whether the operator enabled `intent` in the interject rules, which sets how readily the bot responds. */
  intentEnabled: boolean;
  /** Seq of the newest message in the group when the burst settled; the target may precede it. */
  latestSeq: number;
}

/** Generates and sends (or, in shadow mode, only generates) an auto-mode reply. */
export type AutoRunner = (selfId: number, message: milky.IncomingGroupMessage, reply: AutoReply) => Promise<void>;

interface Judgment {
  message: milky.IncomingGroupMessage;
  record: AutoDecisionRecord;
  verdict?: Verdict;
}

interface GroupState {
  buffer: BufferedMessage[];
  burst: Promise<Judgment | undefined>[];
  burstSelfId: number;
  lullTimer?: NodeJS.Timeout;
  maxWaitTimer?: NodeJS.Timeout;
  busy: boolean;
  mutedUntil: number;
  interjections: number[];
  lastInterjectionByUser: Map<number, number>;
}

const REPLY_PRIORITY: ReplyReason[] = ['implicit_address', 'continuation', 'interjection'];

function hasJudgeableText(text: string): boolean {
  // Placeholders like [图片] and @mentions carry nothing Jev can judge on their own.
  return (
    text
      .replace(/\[[^\]]*\]/g, '')
      .replace(/@\S+/g, '')
      .trim().length > 0
  );
}

export class AutoScheduler {
  private readonly groups = new Map<number, GroupState>();
  private readonly lowerNames: string[];

  constructor(
    private readonly jev: JevClient,
    private readonly activity: ActivityRegistry,
    private readonly logger: Logger,
    private readonly run: AutoRunner,
    private readonly setTimer: TimerFactory,
    private readonly options: AutoSchedulerOptions,
  ) {
    this.lowerNames = options.profile.names.map((n) => n.toLowerCase()).filter(Boolean);
  }

  enabledFor(groupId: number): boolean {
    return this.options.groups.has(groupId);
  }

  private state(groupId: number): GroupState {
    let state = this.groups.get(groupId);
    if (!state) {
      state = {
        buffer: [],
        burst: [],
        burstSelfId: 0,
        busy: false,
        mutedUntil: 0,
        interjections: [],
        lastInterjectionByUser: new Map(),
      };
      this.groups.set(groupId, state);
    }
    return state;
  }

  private toBuffered(selfId: number, message: milky.IncomingGroupMessage): BufferedMessage {
    const fromBot = message.sender_id === selfId;
    const reply = message.segments.find((s): s is milky.IncomingReplySegment => s.type === 'reply');
    const quotes = reply
      ? reply.data.sender_id === selfId
        ? BOT_SPEAKER
        : this.findSpeaker(message.peer_id, reply.data.sender_id) || String(reply.data.sender_id)
      : null;
    const text = summarizeMessage({ ...message, segments: message.segments.filter((s) => s.type !== 'reply') });
    return {
      seq: message.message_seq,
      senderId: message.sender_id,
      speaker: fromBot ? BOT_SPEAKER : extractSenderName(message) || String(message.sender_id),
      text,
      quotes,
      fromBot,
    };
  }

  private findSpeaker(groupId: number, userId: number): string | undefined {
    return this.groups.get(groupId)?.buffer.findLast((m) => m.senderId === userId)?.speaker;
  }

  private push(state: GroupState, entry: BufferedMessage) {
    if (state.buffer.some((m) => m.seq === entry.seq)) {
      return;
    }
    state.buffer.push(entry);
    state.buffer.sort((a, b) => a.seq - b.seq);
    const keep = this.options.stateMessages + 20;
    if (state.buffer.length > keep) {
      state.buffer.splice(0, state.buffer.length - keep);
    }
  }

  /** Records a message the bot sent, in case the protocol does not echo it as an event. */
  recordBotMessage(groupId: number, seq: number, text: string) {
    if (!this.enabledFor(groupId)) {
      return;
    }
    this.push(this.state(groupId), { seq, senderId: 0, speaker: BOT_SPEAKER, text, quotes: null, fromBot: true });
  }

  /**
   * Feeds every message of an enabled group. Messages that trigger a direct reply are only buffered; they
   * cancel the pending burst, since the bot is about to speak anyway.
   */
  observe(selfId: number, message: milky.IncomingGroupMessage, directlyTriggered: boolean) {
    if (!this.enabledFor(message.peer_id)) {
      return;
    }
    const state = this.state(message.peer_id);
    const entry = this.toBuffered(selfId, message);
    this.push(state, entry);
    if (entry.fromBot) {
      return;
    }
    if (directlyTriggered) {
      this.cancelBurst(state, 'direct');
      return;
    }
    if (Date.now() < state.mutedUntil || !hasJudgeableText(entry.text)) {
      return;
    }

    const index = state.buffer.indexOf(entry);
    const context = state.buffer.slice(Math.max(0, index - this.options.stateMessages), index);
    state.burst.push(this.judge(selfId, message, entry, context));
    state.burstSelfId = selfId;

    if (state.lullTimer) {
      clearTimeout(state.lullTimer);
    }
    state.lullTimer = this.setTimer(this.options.debounceMs, () => void this.settle(message.peer_id));
    state.maxWaitTimer ??= this.setTimer(this.options.maxBurstWaitMs, () => void this.settle(message.peer_id));
  }

  /** Marks the group busy while a direct reply is generated, so auto mode does not talk over it. */
  async runExclusive<T>(groupId: number, fn: () => Promise<T>): Promise<T> {
    if (!this.enabledFor(groupId)) {
      return fn();
    }
    const state = this.state(groupId);
    state.busy = true;
    try {
      return await fn();
    } finally {
      state.busy = false;
    }
  }

  private async judge(
    selfId: number,
    message: milky.IncomingGroupMessage,
    target: BufferedMessage,
    context: BufferedMessage[],
  ): Promise<Judgment | undefined> {
    const flags: JudgeFlags = {
      mentionsBotName: this.lowerNames.some((name) => target.text.toLowerCase().includes(name)),
      botSpokeRecently: context.some((m) => m.fromBot),
    };
    const base = {
      selfId,
      groupId: message.peer_id,
      senderId: message.sender_id,
      senderName: target.speaker,
      messageSeq: message.message_seq,
      input: target.text,
      outcome: 'pending' as AutoOutcome,
    };
    const startedAt = performance.now();
    try {
      const response = await this.jev.systemOne(
        buildJevState(this.options.profile, context, target, flags),
        buildJevQuestions(flags, this.options.intentHints),
      );
      const answers = parseJevAnswers(response);
      const verdict = decide(answers, flags, this.options.thresholds, this.options.interject);
      const record = this.activity.recordAutoDecision({
        ...base,
        verdict: verdict.action,
        reason: verdict.reason,
        answers: summarizeAnswers(answers),
        model: answers.model,
        inputTokens: answers.inputTokens,
        latencyMs: performance.now() - startedAt,
      });
      return { message, record, verdict };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Jev judgment failed for message ${message.message_seq} in group ${message.peer_id}`, error);
      this.activity.recordAutoDecision({
        ...base,
        verdict: 'error',
        reason: 'error',
        outcome: 'ignored',
        latencyMs: performance.now() - startedAt,
        error: detail,
      });
      return undefined;
    }
  }

  private clearTimers(state: GroupState) {
    clearTimeout(state.lullTimer);
    clearTimeout(state.maxWaitTimer);
    state.lullTimer = undefined;
    state.maxWaitTimer = undefined;
  }

  private cancelBurst(state: GroupState, outcome: AutoOutcome) {
    this.clearTimers(state);
    const burst = state.burst;
    state.burst = [];
    void Promise.all(burst).then((judgments) => {
      for (const j of judgments) {
        if (j && j.record.outcome === 'pending') {
          j.record.outcome = outcome;
        }
      }
    });
  }

  private async settle(groupId: number) {
    const state = this.state(groupId);
    this.clearTimers(state);
    const burst = state.burst;
    const selfId = state.burstSelfId;
    state.burst = [];
    const judgments = (await Promise.all(burst)).filter((j): j is Judgment => j !== undefined);
    if (judgments.length === 0) {
      return;
    }
    const finish = (outcome: AutoOutcome, except?: Judgment) => {
      for (const j of judgments) {
        if (j !== except && j.record.outcome === 'pending') {
          j.record.outcome = outcome;
        }
      }
    };

    // A complaint mutes the group, whatever else the burst contains.
    const complaint = judgments.find((j) => j.verdict?.action === 'mute');
    if (complaint) {
      state.mutedUntil = Date.now() + this.options.muteOnComplaintMs;
      complaint.record.outcome = 'muted';
      finish('muted');
      this.activity.recordWarning({
        selfId,
        scene: 'group',
        peerId: groupId,
        senderId: complaint.message.sender_id,
        senderName: complaint.record.senderName,
        messageSeq: complaint.message.message_seq,
        kind: 'auto',
        message: '自动模式已在本群静音',
        detail: `${complaint.record.input}（静音至 ${new Date(state.mutedUntil).toLocaleString('zh-CN')}）`,
      });
      return;
    }

    const chosen = this.choose(state, judgments);
    if (!chosen) {
      finish('ignored');
      return;
    }
    const { judgment, reason, intent, intentEnabled } = chosen;
    if (state.busy || Date.now() < state.mutedUntil) {
      judgment.record.outcome = state.busy ? 'busy' : 'muted';
      finish('superseded', judgment);
      return;
    }
    if (reason === 'interjection' && !this.takeBudget(state, judgment.message.sender_id)) {
      judgment.record.outcome = 'budget';
      finish('superseded', judgment);
      return;
    }
    judgment.record.outcome = 'selected';
    finish('superseded', judgment);

    state.busy = true;
    try {
      const latestSeq = state.buffer.at(-1)?.seq ?? judgment.message.message_seq;
      await this.run(selfId, judgment.message, {
        reason,
        intent,
        intentEnabled,
        latestSeq: Math.max(latestSeq, judgment.message.message_seq),
      });
    } catch (error) {
      this.logger.error('自动模式对话处理失败', error);
    } finally {
      state.busy = false;
    }
  }

  private choose(
    state: GroupState,
    judgments: Judgment[],
  ): { judgment: Judgment; reason: ReplyReason; intent: Intent; intentEnabled: boolean } | undefined {
    // Interjecting on a message the chat has long moved past reads as a delayed reaction.
    const recentSeqs = new Set(state.buffer.slice(-this.options.interjectWithin).map((m) => m.seq));
    for (const reason of REPLY_PRIORITY) {
      const latest = judgments.findLast(
        (j) =>
          j.verdict?.action === 'reply' &&
          j.verdict.reason === reason &&
          (reason !== 'interjection' || recentSeqs.has(j.message.message_seq)),
      );
      if (latest?.verdict?.action === 'reply') {
        const { intent, intentEnabled } = latest.verdict;
        return { judgment: latest, reason, intent, intentEnabled };
      }
    }
    return undefined;
  }

  private takeBudget(state: GroupState, senderId: number): boolean {
    const now = Date.now();
    state.interjections = state.interjections.filter((t) => now - t < 3_600_000);
    const last = state.interjections.at(-1);
    const lastForUser = state.lastInterjectionByUser.get(senderId);
    if (state.interjections.length >= this.options.perHour) {
      return false;
    }
    if (last !== undefined && now - last < this.options.minIntervalMs) {
      return false;
    }
    if (lastForUser !== undefined && now - lastForUser < this.options.perUserIntervalMs) {
      return false;
    }
    state.interjections.push(now);
    state.lastInterjectionByUser.set(senderId, now);
    return true;
  }

  /** Whether a newer message than `seq` has arrived in the group, i.e. a reply should quote its target. */
  hasNewerMessage(groupId: number, seq: number): boolean {
    return this.groups.get(groupId)?.buffer.some((m) => m.seq > seq) ?? false;
  }
}
