import type { milky } from '@fraqjs/fraq';

export type ConversationOutcome = 'replied' | 'rejected';
export type WarningKind = 'generation' | 'rejected' | 'tool';

export interface ConversationRecord {
  id: number;
  createdAt: number;
  selfId: number;
  scene: 'friend' | 'group';
  peerId: number;
  senderId: number;
  senderName: string;
  messageSeq: number;
  input: string;
  output: string;
  outcome: ConversationOutcome;
}

export interface WarningRecord {
  id: number;
  createdAt: number;
  kind: WarningKind;
  message: string;
  detail?: string;
  selfId?: number;
  scene?: 'friend' | 'group';
  peerId?: number;
  senderId?: number;
  senderName?: string;
  messageSeq?: number;
}

export interface ActivityRegistryOptions {
  conversationLimit: number;
  warningLimit: number;
}

type NewConversationRecord = Omit<ConversationRecord, 'id' | 'createdAt'> & { createdAt?: number };
type NewWarningRecord = Omit<WarningRecord, 'id' | 'createdAt'> & { createdAt?: number };

function pushBounded<T>(records: T[], record: T, limit: number): void {
  if (limit === 0) {
    return;
  }
  records.unshift(record);
  if (records.length > limit) {
    records.length = limit;
  }
}

export function summarizeMessage(message: milky.IncomingMessage): string {
  const content = message.segments
    .map((segment) => {
      switch (segment.type) {
        case 'text':
          return segment.data.text;
        case 'mention':
          return `@${segment.data.name || segment.data.user_id}`;
        case 'mention_all':
          return '@全体成员';
        case 'reply':
          return `[回复 ${segment.data.sender_name || segment.data.sender_id}]`;
        case 'image':
          return segment.data.summary || '[图片]';
        case 'record':
          return '[语音]';
        case 'video':
          return '[视频]';
        case 'file':
          return `[文件 ${segment.data.file_name}]`;
        case 'forward':
          return `[合并转发 ${segment.data.title}]`;
        case 'market_face':
          return segment.data.summary || '[表情]';
        case 'markdown':
          return segment.data.content;
        case 'face':
          return '[表情]';
        case 'light_app':
          return `[小程序 ${segment.data.app_name}]`;
        case 'xml':
          return '[XML 消息]';
      }
      return '[消息]';
    })
    .join('')
    .trim();
  return content || '[空消息]';
}

export class ActivityRegistry {
  private readonly conversations: ConversationRecord[] = [];
  private readonly warnings: WarningRecord[] = [];
  private nextConversationId = 1;
  private nextWarningId = 1;

  constructor(private readonly options: ActivityRegistryOptions) {}

  recordConversation(record: NewConversationRecord): ConversationRecord {
    const stored = {
      ...record,
      id: this.nextConversationId++,
      createdAt: record.createdAt ?? Date.now(),
    };
    pushBounded(this.conversations, stored, this.options.conversationLimit);
    return stored;
  }

  recordWarning(record: NewWarningRecord): WarningRecord {
    const stored = {
      ...record,
      id: this.nextWarningId++,
      createdAt: record.createdAt ?? Date.now(),
    };
    pushBounded(this.warnings, stored, this.options.warningLimit);
    return stored;
  }

  listConversations(): readonly ConversationRecord[] {
    return [...this.conversations];
  }

  listWarnings(): readonly WarningRecord[] {
    return [...this.warnings];
  }
}
