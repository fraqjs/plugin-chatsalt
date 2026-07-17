import type { milky } from '@fraqjs/fraq';

export function shouldTriggerChat(selfId: number, message: milky.IncomingMessage): boolean {
  if (message.sender_id === selfId) {
    return false;
  }
  if (message.message_scene === 'temp') {
    return false;
  }
  if (message.message_scene === 'friend' && message.peer_id !== selfId) {
    return true;
  }
  // group
  if (message.message_scene === 'group') {
    const [first] = message.segments;
    if (!first) {
      return false;
    }
    if (first.type === 'mention' && first.data.user_id === selfId) {
      return true;
    }
    if (first.type === 'reply' && first.data.sender_id === selfId) {
      return true;
    }
  }
  return false;
}
