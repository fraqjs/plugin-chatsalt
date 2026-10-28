import { type milky, seg } from '@fraqjs/fraq';

import faceTable from './faces.json';

const faceNames = new Map<number, string>(
  Object.entries(faceTable as Record<string, string>).map(([id, name]) => [Number(id), name]),
);

/** Common small faces recommended to the model when `richText.recommendedFaces` is not configured. */
export const DEFAULT_RECOMMENDED_FACES: readonly number[] = [
  111, // 可怜
  479, // 不对不对
  478, // 对的对的
  264, // 捂脸
  181, // 戳一戳
  277, // 汪汪
  344, // 大怨种
  297, // 拜谢
];

export function faceName(faceId: number): string | undefined {
  return faceNames.get(faceId);
}

export interface MilkyParseOptions {
  scene: 'friend' | 'group';
  /** Users the model may mention, mapped to their display names. Ignored outside groups. */
  mentions: ReadonlyMap<number, string>;
}

export interface MilkyParseResult {
  segments: milky.OutgoingSegment[];
  /** The reply as plain text, with faces as `[name]` and mentions as `@name`. */
  plain: string;
  /** Codes that were malformed or not allowed, and were dropped. */
  dropped: string[];
}

function textSegment(text: string): milky.OutgoingTextSegment {
  return { type: 'text', data: { text } };
}

const MILKY_CODE = /\[milky:([^\]]*)\]/g;
const KNOWN_CODE = /^(face|mention)-(\d+)$/;

/**
 * Turns `[milky:face-ID]` and `[milky:mention-QQ]` codes in the model's reply into message segments.
 * Codes that are malformed, name an unknown face, or mention someone not allowed are dropped, so the
 * syntax never reaches the chat.
 */
export function parseMilkyCodes(text: string, options: MilkyParseOptions): MilkyParseResult {
  const segments: milky.OutgoingSegment[] = [];
  const plain: string[] = [];
  const dropped: string[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) {
      segments.push(textSegment(buffer));
      buffer = '';
    }
  };

  let last = 0;
  for (const match of text.matchAll(MILKY_CODE)) {
    buffer += text.slice(last, match.index);
    plain.push(text.slice(last, match.index));
    last = match.index + match[0].length;

    const [, type, rawId] = KNOWN_CODE.exec(match[1] ?? '') ?? [];
    const id = Number(rawId);
    if (type === 'face' && faceNames.has(id)) {
      flush();
      segments.push({ type: 'face', data: { face_id: String(id), is_large: false } });
      plain.push(`[${faceName(id) ?? '表情'}]`);
    } else if (type === 'mention' && options.scene === 'group' && options.mentions.has(id)) {
      flush();
      segments.push(seg.mention(id));
      plain.push(`@${options.mentions.get(id) || id}`);
    } else {
      dropped.push(match[0]);
    }
  }
  buffer += text.slice(last);
  plain.push(text.slice(last));
  flush();

  return { segments: trimBoundaryText(segments), plain: plain.join('').trim(), dropped };
}

function trimBoundaryText(segments: milky.OutgoingSegment[]): milky.OutgoingSegment[] {
  const result = [...segments];
  const first = result[0];
  if (first?.type === 'text') {
    const text = first.data.text.trimStart();
    if (text) {
      result[0] = textSegment(text);
    } else {
      result.shift();
    }
  }
  const last = result.at(-1);
  if (last?.type === 'text') {
    const text = last.data.text.trimEnd();
    if (text) {
      result[result.length - 1] = textSegment(text);
    } else {
      result.pop();
    }
  }
  return result;
}
