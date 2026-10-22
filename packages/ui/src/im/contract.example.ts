import { createMessagesSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { MessagesSidePaneProps } from "./contract.js";

/** workspaceKey 由现有 workspace 所有者提供，UI 不重新构造远端 identity。 */
export function exampleMessagesPaneProps(
  workspacePath: string,
  workspaceKey: string,
): MessagesSidePaneProps {
  return { tab: createMessagesSidePaneTab({ workspacePath, workspaceKey }) };
}
