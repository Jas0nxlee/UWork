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
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { RibbonItem } from "./officeRibbonModel.js";

export interface RibbonDropdownState {
  openId: string | null;
  toggle: (id: string) => void;
  close: () => void;
  /**
   * 正在取值（图片/超链接这类要填一句话的命令）。放在上下文里是**必须的**：
   * 这些按钮常常被收进「»」面板里，而面板一点就关、按钮随之卸载——对话框跟着组件一起消失，
   * 表现就是"折叠状态下点图片没反应"（真机踩过）。现在对话框挂在功能区根部，面板关不关都不影响。
   */
  promptItem: RibbonItem | null;
  openPrompt: (item: RibbonItem) => void;
  closePrompt: () => void;
}

const RibbonDropdownContext = createContext<RibbonDropdownState>({
  openId: null,
  toggle: () => undefined,
  close: () => undefined,
  promptItem: null,
  openPrompt: () => undefined,
  closePrompt: () => undefined,
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
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 面板最大高度：夹在视口里，装不下就在面板内部滚动（不设上限会超出屏幕、最下面的项点不到）。 */
  const [maxHeight, setMaxHeight] = useState(320);

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
    // 面板打开时若**别处**滚动就关掉，避免面板与触发器错位。
    // 但面板自己的滚动（面板内容高、要滚着看）不能算——早先一刀切用捕获监听，
    // 结果"一滚就关"，看起来就是"折叠菜单滚不动也点不着"（用户反馈）。
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || anchorRef.current?.contains(target))) {
        return;
      }
      onClose();
    };
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [anchorRef, minWidth, onClose, open]);

  useLayoutEffect(() => {
    if (!open || !position) return;
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.maxHeight = "none";
    // 夹到视口内：装不下就在面板内部滚（而不是超出屏幕让下面的项点不到）
    const available = window.innerHeight - position.top - 8;
    panel.style.maxHeight = `${Math.max(160, Math.min(340, available))}px`;
    setMaxHeight(panel.clientHeight);
  }, [open, position, children]);

  if (!open || !position) return null;
  return createPortal(
    <div
      ref={panelRef}
      data-ribbon-dropdown
      className="fixed z-50 rounded border border-white/15 py-1 shadow-xl"
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        maxHeight,
        overflowY: "auto",
        color: position.color,
        backgroundColor: position.background,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
