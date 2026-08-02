import { inmsg, inseg } from '@fraqjs/plugin-mock';

import { ActivityRegistry, summarizeMessage } from '../src/activity';

import assert from 'node:assert/strict';
import test from 'node:test';

test('keeps only the newest configured activity records', () => {
  const activity = new ActivityRegistry({ conversationLimit: 2, warningLimit: 1 });
  const conversation = {
    selfId: 1,
    scene: 'friend' as const,
    peerId: 2,
    senderId: 2,
    senderName: 'Alice',
    messageSeq: 1,
    input: 'hello',
    output: 'hi',
    outcome: 'replied' as const,
  };

  activity.recordConversation({ ...conversation, createdAt: 1 });
  activity.recordConversation({ ...conversation, messageSeq: 2, createdAt: 2 });
  activity.recordConversation({ ...conversation, messageSeq: 3, createdAt: 3 });
  activity.recordWarning({ kind: 'tool', message: 'first', createdAt: 1 });
  activity.recordWarning({ kind: 'generation', message: 'second', createdAt: 2 });

  assert.deepEqual(
    activity.listConversations().map((record) => record.messageSeq),
    [3, 2],
  );
  assert.deepEqual(
    activity.listWarnings().map((record) => record.message),
    ['second'],
  );
});

test('summarizes text and non-text message segments for the WebUI', () => {
  const message = {
    segments: inmsg`hello ${inseg.image({ summary: '' })} ${inseg.file({ fileName: 'notes.txt' })}`,
  } as Parameters<typeof summarizeMessage>[0];

  assert.equal(summarizeMessage(message), 'hello [图片] [文件 notes.txt]');
});

test('rejects invalid activity limits', () => {
  assert.throws(() => new ActivityRegistry({ conversationLimit: -1, warningLimit: 1 }), RangeError);
  assert.throws(() => new ActivityRegistry({ conversationLimit: 1, warningLimit: 1.5 }), RangeError);
});
