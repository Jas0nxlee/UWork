/**
 * 功能区下拉的**面板**与**单一打开源**。
 *
 * 三个真机反馈促成的设计：
 *  - "字体下拉被困在上面栏中"：面板用普通绝对定位会被功能区的 `overflow-x-auto` 裁掉 → **portal 到 body + fixed**；
 *  - "portal 后文字颜色不对"：脱离主题作用域后 token 失效 → 面板**从触发器继承前景色/背景色**；
 *  - "能同时拉开多个下拉"：把"当前打开的下拉 id"提升为功能区唯一状态（本文件的 Context），
 *    打开任意一个天然关掉上一个，不依赖点击事件传播的细节。
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export interface RibbonDropdownState {
  openId: string | null;
  toggle: (id: string) => void;
  close: () => void;
}

const RibbonDropdownContext = createContext<RibbonDropdownState>({
  openId: null,
  toggle: () => undefined,
  close: () => undefined,
});

export function RibbonDropdownProvider({
  value,
  children,
}: {
  value: RibbonDropdownState;
  children: ReactNode;
}) {
  return <RibbonDropdownContext.Provider value={value}>{children}</RibbonDropdownContext.Provider>;
}

export function useRibbonDropdown(): RibbonDropdownState {
  return useContext(RibbonDropdownContext);
}

/** 面板：portal 到 body + fixed 定位，位置按触发器 rect 计算并做视口夹取/上下翻转。 */
export function DropdownPanel({
  open,
  anchorRef,
  onClose,
  minWidth = 208,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  minWidth?: number;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    width: number;
    color: string;
    background: string;
  } | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const measure = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(minWidth, rect.width);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const panelHeight = 288;
      const below = rect.bottom + 4;
      const top =
        below + panelHeight <= window.innerHeight - 8
          ? below
          : Math.max(8, rect.top - panelHeight - 4);
      // portal 到 body 会脱离主题作用域（应用的 color token 定义在容器上）——所以从触发器继承前景色，
      // 并从最近的有背景色的祖先取背景色，保证面板与功能区同一套配色（真机反馈：下拉文字颜色不对）。
      const anchorStyle = getComputedStyle(anchor);
      let background = anchorStyle.backgroundColor;
      let node: HTMLElement | null = anchor.parentElement;
      while (
        node &&
        (!background || background === "rgba(0, 0, 0, 0)" || background === "transparent")
      ) {
        background = getComputedStyle(node).backgroundColor;
        node = node.parentElement;
      }
      setPosition({
        left,
        top,
        width,
        color: anchorStyle.color,
        background: background && background !== "rgba(0, 0, 0, 0)" ? background : "#1f1f1f",
      });
    };
    measure();
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if ((event.target as HTMLElement)?.closest?.("[data-ribbon-dropdown]")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    // 面板打开时若容器滚动就关掉，避免面板与触发器错位
    document.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [anchorRef, minWidth, onClose, open]);

  if (!open || !position) return null;
  return createPortal(
    <div
      data-ribbon-dropdown
      className="fixed z-50 max-h-72 overflow-auto rounded border border-white/15 py-1 shadow-xl"
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        color: position.color,
        backgroundColor: position.background,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
