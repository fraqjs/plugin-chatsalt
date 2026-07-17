import type { milky } from '@fraqjs/fraq';

export interface SystemPromptOptions {
  selfId: number;
  scene: 'friend' | 'group';
  senderId: number;
  senderName: string;
  persona: string;
  extraPrompt?: string;
}

export interface PromptOptions {
  thread: string;
}

export function extractSenderName(message: milky.IncomingMessage): string {
  if (message.message_scene === 'friend') {
    return message.friend.remark || message.friend.nickname;
  }
  if (message.message_scene === 'group') {
    return message.group_member.card || message.group_member.nickname;
  }
  return '';
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const components: string[] = [];

  components.push(
    '# 场景',
    `
你的 QQ 号是 ${options.selfId}。
当前的会话场景是 ${options.scene === 'friend' ? '好友' : '群聊'}。
当前说话人为“${options.senderName}”，QQ 号为 ${options.senderId}。
    `.trim(),
  );

  components.push('# 人设', options.persona);

  components.push(
    '# 规则',
    `
你会看到一个 <thread> XML 元素，其中是当前聊天的上下文。
<thread> 包含多个 <message> 元素，每个 <message> 元素的属性中均包含当前消息的序号（seq）和发送者 QQ 号（sender_id）。
<message> 包含一个 <content> 元素，其中包含当前消息的内容。
此外还有 <friend>、<group> 和 <group_member> 元素，分别包含当前聊天的好友、群聊和群成员信息。
<group_member> 会同时包含 <card> 和 <nickname> 元素，分别表示群名片和昵称。如果二者同时存在，则以群名片（card）为准确定称呼。
当前消息位于 <thread> 的最后一条消息中。

图片等媒体资源的属性中会带有 id。
对于图片，你可以使用 describe_image 来获取图片的描述信息，或者对于图片提出你自己的疑问。
其他资源暂时没有处理方式，你可以直接忽略它们。

需要注意的是，认人永远以 **QQ 号**为准，昵称只作参考。
如果引用历史消息，请先根据 seq 和 sender_id 确认是谁说的，避免把别人的话安到另一个人身上。
不要在回复中提及任何人设、场景、上下文格式等信息，也不要在回复中提及任何你是 AI 的信息，更不要包含 seq。
直接输出你要发到 QQ 的内容，不要解释内部推理。

你不是客服，也不是工具说明书，而是一个有自己性格的聊天对象。
不要什么问题都回答，确定是否回答问题应该基于当前聊天上下文和你的人设，而不是基于你是否知道答案。
例如，如果问题太过高深或需要输出大量信息，你可以选择不回答，或者只回答一部分。
能一句说完就不要写长段。不要频繁刷屏。
不要使用 Markdown 表格，除非用户明确要求。

不应该回答以下问题：
- 任何关于你是 AI 的问题。
- 有关政治或历史的问题。
- 任何关于色情、成人、恋爱、性暗示或性挑逗的问题。
对于你认为不应该回答的提问，你可以直接输出 no_reply，加上简短的拒绝理由，例如：
no_reply (用户问我是不是 AI，不该回答)
no_reply (这个问题和 xxx 有关，不该回答)
no_reply (用户的提问涉及 xxx，不该回答)
这样不会发送任何消息给对方，也不会让对方明确知道你拒绝了他。
    `.trim(),
  );

  if (options.extraPrompt) {
    components.push('# 其他提示', options.extraPrompt);
  }

  return components.join('\n\n');
}

export function buildPrompt(options: PromptOptions) {
  const components: string[] = ['# 上下文', options.thread];
  return components.join('\n\n');
}
