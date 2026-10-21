import { memo } from "react";
import type { IImService } from "@zcode/services";
import type { ImDirectoryUser } from "@zcode/shared";
import { logger } from "@/logger.js";
import { ImDirectoryList } from "./ImDirectoryList.js";

/**
 * 通讯录：占列表位置（与消息列表同一套视觉）。
 *
 * 点一个人直接开单聊——所以"建会话"这件事收在这里，而不是让面板去写 service 调用：
 * 面板只需要知道"打开了哪条会话"。
 */
export const ImDirectoryPane = memo(function ImDirectoryPane({
  service,
  users,
  onOpened,
}: {
  service: IImService | null;
  users: ImDirectoryUser[];
  onOpened: (conversationId: string) => void;
}) {
  return (
    <ImDirectoryList
      users={users}
      onPick={(user) => {
        if (!service) return;
        void service
          .createDm(user.id)
          .then((conversation) => onOpened(conversation.id))
          .catch((error: unknown) => logger.warn("[im] 发起单聊失败", error));
      }}
    />
  );
});
