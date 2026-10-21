/**
 * 检索结果的**高亮切片**（纯展示逻辑）。
 *
 * 注意这里不再有"本地搜索"：会话内检索已经改成打服务端的全历史检索
 * （见 `useImSearch.ts` 与 msgbus 的 `/messages/search`）——只在已加载的那一页里过滤，
 * 几百条之后就等于搜不到东西，却看起来像有搜索。这个文件只负责把命中的词切成高亮片段。
 */

/** 命中片段：`match` 为真的一段需要高亮。 */
export interface ImHighlightSegment {
  text: string;
  match: boolean;
}

const MAX_SEGMENTS = 200;

/** 把正文按查询词切成"高亮 / 不高亮"交替片段（大小写不敏感，空白查询返回整段）。 */
export function splitHighlight(text: string, query: string): ImHighlightSegment[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const lower = needle.toLowerCase();
  const segments: ImHighlightSegment[] = [];
  let cursor = 0;
  while (cursor < text.length && segments.length < MAX_SEGMENTS) {
    const index = haystack.indexOf(lower, cursor);
    if (index === -1) break;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), match: false });
    segments.push({ text: text.slice(index, index + needle.length), match: true });
    cursor = index + needle.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}
