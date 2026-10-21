/**
 * 画布上的**右键菜单**状态：在哪儿弹、弹在哪个对象上。
 *
 * 为什么存在：选中对象**不再自动弹**右栏窗格（真机反馈"只要弹出，主编辑界面就太小了"），
 * 所以"设置形状格式"得从右键菜单/顶部按钮开。单独成文件是为了守画布那个组件的 400 行。
 */
import { useCallback, useState } from "react";

export interface CanvasContextMenuState {
  /** 相对**画布框**的坐标（不是视口坐标）。 */
  x: number;
  y: number;
  /** 右键点中的对象名。 */
  name: string;
}

export function useCanvasContextMenu(input: {
  frameRef: React.RefObject<HTMLDivElement | null>;
  hitTest: (clientX: number, clientY: number) => string | null;
  onSelect: (name: string | null) => void;
}) {
  const [menu, setMenu] = useState<CanvasContextMenuState | null>(null);

  const onContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const name = input.hitTest(event.clientX, event.clientY);
      if (!name) {
        setMenu(null);
        return;
      }
      const frame = input.frameRef.current;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      // 菜单要留在画布框里（贴右边/下边时往回缩一点），否则会被裁掉
      setMenu({
        x: Math.max(4, Math.min(rect.width - 176, event.clientX - rect.left)),
        y: Math.max(4, Math.min(rect.height - 132, event.clientY - rect.top)),
        name,
      });
      input.onSelect(name);
    },
    [input],
  );

  return { menu, setMenu, onContextMenu };
}
