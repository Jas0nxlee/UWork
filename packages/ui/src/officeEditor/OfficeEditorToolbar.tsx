/**
 * 编辑位顶栏：保存 / 重新加载 / 返回预览 + 状态栏。
 *
 * 单独一个文件的原因：编辑位本体接近仓库 400 行上限，而顶栏后面还要放"修订模式"等开关；
 * 抽出来后这些控件都有地方落。
 */
export interface OfficeEditorToolbarProps {
  busy: boolean;
  dirty: boolean;
  status: string;
  /** 有未保存修改时的退出确认文案（返回 false 表示用户取消）。 */
  confirmExit?: () => boolean;
  onSave: () => void;
  onReload: () => void;
  onExit?: (() => void) | undefined;
  /** 右侧状态区前的附加控件（例如修订模式开关）。 */
  extra?: React.ReactNode;
}

export function OfficeEditorToolbar({
  busy,
  dirty,
  status,
  confirmExit,
  onSave,
  onReload,
  onExit,
  extra,
}: OfficeEditorToolbarProps) {
  return (
    // 必须 nowrap：状态文字长度会随导航/保存变化，一旦换行整块菜单栏就会"跳一下"（真机反馈）
    <div
      data-office-toolbar
      className="flex flex-nowrap items-center gap-1 overflow-hidden border-b border-border px-2 py-1.5 text-xs"
    >
      <button
        type="button"
        className="rounded border border-border px-2 py-1 font-medium hover:border-accent disabled:opacity-50"
        onClick={onSave}
        disabled={busy}
        title="写回原文件（先落备份，冲突则拒绝）"
      >
        保存到文件
      </button>
      <button
        type="button"
        className="rounded border border-border px-2 py-1 hover:border-accent disabled:opacity-50"
        onClick={onReload}
        disabled={busy}
      >
        重新加载
      </button>
      {onExit ? (
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:border-accent"
          onClick={() => {
            if (confirmExit && !confirmExit()) return;
            onExit();
          }}
        >
          返回预览
        </button>
      ) : null}
      {extra}
      <span
        className="ml-auto min-w-0 flex-1 truncate text-right text-foreground-subtle"
        title={status}
      >
        {dirty ? "● 未保存 · " : ""}
        {status}
      </span>
    </div>
  );
}
