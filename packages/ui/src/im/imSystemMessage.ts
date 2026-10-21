/**
 * 系统消息文案。
 *
 * 服务端只记"谁做了什么"（JSON 载荷），文案在客户端按语言渲染——仓库有 zh-CN / en-US 两套，
 * 把中文写进库里等于把语言钉死在服务端，以后加语言得改数据。
 *
 * 姓名解析交给调用方（`nameOf`）：成员可能已经退群，通讯录里查不到时退回 id，
 * 这里是唯一一处需要"人话姓名"的地方，但"查不到怎么办"由上层决定。
 */
import { parseImSystemMessage, type ImSystemAction } from "@zcode/shared";

export type ImSystemMessageText = {
  text: string;
  /** 载荷认不出时把原文透出去，别显示空白 */ unparsed?: string;
};

export function describeSystemMessage(
  body: string,
  nameOf: (id: string) => string | undefined,
  t: (id: string, values?: Record<string, string | number>) => string,
): ImSystemMessageText {
  const action = parseImSystemMessage(body);
  if (!action) return { text: body, unparsed: body };
  return { text: renderAction(action, nameOf, t) };
}

function renderAction(
  action: ImSystemAction,
  nameOf: (id: string) => string | undefined,
  t: (id: string, values?: Record<string, string | number>) => string,
): string {
  const actor = nameOf(action.actorId) ?? action.actorId;
  switch (action.action) {
    case "group_created":
      return t("im.system.groupCreated", { actor, title: action.title });
    case "members_added": {
      const names = action.memberIds.map((id) => nameOf(id) ?? id).join(t("common.listSeparator"));
      return t("im.system.membersAdded", { actor, names });
    }
    case "member_removed": {
      const name = nameOf(action.memberId) ?? action.memberId;
      // 自己移出自己 = 退群：文案不同，因为服务端把它们记成了两个动作。
      return action.actorId === action.memberId
        ? t("im.system.memberLeft", { actor })
        : t("im.system.memberRemoved", { actor, name });
    }
    case "member_left":
      return t("im.system.memberLeft", { actor });
    case "title_changed":
      return t("im.system.titleChanged", { actor, title: action.title });
    default:
      // 服务端加了新动作而客户端还没跟上：不要把 JSON 甩给用户，给一句兜底。
      return t("im.system.unsupported");
  }
}
