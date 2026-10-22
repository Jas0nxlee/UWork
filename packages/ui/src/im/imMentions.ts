/**
 * @提及的展示与解析（纯逻辑）。
 *
 * 一条判断：**"谁被提到了"由服务端记 id，不由正文解析**（改名会让解析失效），
 * 但**正文里的高亮必须按文本走**——用户看到的就是那串字。所以这里只做两件事：
 * 把正文切成"普通片段 / @片段"，以及判断某条消息是否提到了"我"。
 *
 * `all` 是 @全体的保留 id（服务端约定）。
 */
import type { ImMessage } from "@zcode/shared";

export const MENTION_ALL_ID = "all";
export const MENTION_ALL_LABEL = "全体";

export interface ImMentionSegment {
  text: string;
  /** 命中的片段（渲染时高亮）。 */
  mention: boolean;
  /** 是否提到了"我"（用更醒目的一档样式）。 */
  mine: boolean;
}

/**
 * 把正文切成片段。`@` 后面跟到空白/标点为止算一个提及（中文名里不含空格，够用），
 * 最大 24 字符——避免 `a@b` 这种把整段都吞进去。
 */
export function splitMentions(text: string, selfName: string | null): ImMentionSegment[] {
  const segments: ImMentionSegment[] = [];
  let cursor = 0;
  const pattern = /@([^\s@,.，。!！?？:：;；"'（）()【】[\]]{1,24})/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[1] ?? "";
    const start = match.index;
    // `@` 必须出现在开头或空白之后：`a@b.com` 里的 @ 是邮箱，不是提及。
    const before = start === 0 ? "" : (text[start - 1] ?? "");
    if (before !== "" && !/\s/u.test(before)) {
      pattern.lastIndex = start + 1;
      continue;
    }
    if (start > cursor)
      segments.push({ text: text.slice(cursor, start), mention: false, mine: false });
    const mine = selfName !== null && (token === MENTION_ALL_LABEL || token === selfName);
    segments.push({ text: match[0], mention: true, mine });
    cursor = start + match[0].length;
  }
  if (cursor < text.length)
    segments.push({ text: text.slice(cursor), mention: false, mine: false });
  return segments.length > 0 ? segments : [{ text, mention: false, mine: false }];
}

/** 这条消息是否提到了我（服务端记的 id 为准；`all` 也算）。 */
export function mentionsMe(
  message: Pick<ImMessage, "mentions">,
  selfUserId: string | null,
): boolean {
  if (!selfUserId) return false;
  return message.mentions.includes(selfUserId) || message.mentions.includes(MENTION_ALL_ID);
}
