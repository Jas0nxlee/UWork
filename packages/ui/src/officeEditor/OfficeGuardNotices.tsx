/**
 * 两条护栏提示（都只在"真会出问题"时出现）：
 *   - 不能写回：远端服务端没有二进制写回能力，不进编辑（免得编了半天存不了）；
 *   - 需要确认：文档含**真会丢内容**的特性（脚注/尾注）——列出清单让用户决定。
 * 修订与批注**不在这里**：它们按 Word 的样子显示在正文里（见 docxRevisions.ts）。
 */
import { summarizeFindings, type DocxPreflightResult } from "./docxPreflight.js";

export function OfficeGuardNotices({
  writeBlocked,
  pending,
  onAccept,
  onExit,
}: {
  writeBlocked: string | null;
  pending: DocxPreflightResult | null;
  onAccept: () => void;
  onExit?: (() => void) | undefined;
}) {
  return (
    <>
      {writeBlocked ? (
        <div className="border-b border-border bg-surface px-3 py-3 text-xs">
          <div className="pb-1 font-medium">这份文件现在不能应用内编辑</div>
          <div className="pb-2 text-foreground-subtle">{writeBlocked}</div>
          <div className="text-foreground-subtle">
            只读预览与对话卡片审阅不受影响；等远端服务端升级出二进制写回后再来。
          </div>
        </div>
      ) : null}
      {pending ? (
        <div className="border-b border-amber-500/40 bg-amber-500/10 px-2 py-2 text-xs text-amber-200">
          <div className="pb-1 font-medium">这份文档有以下特性，应用内编辑会让它们发生变化：</div>
          <ul className="list-disc pb-2 pl-5">
            {summarizeFindings(pending.findings).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              className="rounded border border-amber-400 px-2 py-1 hover:bg-amber-500/20"
              onClick={onAccept}
            >
              按上述方式编辑
            </button>
            {onExit ? (
              <button
                type="button"
                className="rounded border border-border px-2 py-1 hover:bg-surface"
                onClick={onExit}
              >
                只看只读预览
              </button>
            ) : null}
            <span className="text-amber-200/80">
              想保住这些特性（例如逐条接受/拒绝修订），请用对话卡片或侧栏的审阅面板。
            </span>
          </div>
          <div className="pt-1 text-amber-200/70">文档还没打开，点上面的按钮才会载入</div>
        </div>
      ) : null}
    </>
  );
}
