/**
 * 应用内 DOCX 编辑器（内核侧 spike）。
 *
 * 为什么能在内核里跑而插件里跑不起来：插件页面在沙箱里（`connect-src 'none'`、无文件原语、
 * 引擎必须从 http(s) 加载），而这里直接读 `IFileService`、引擎由 Vite 的 `?url` 变成 dev/prod
 * 服务器上的真实 http(s) 地址（SuperDoc 的壳对引擎地址做 http(s) 白名单，见
 * UWork-plugin/specs/office-in-core-research.md）。
 *
 * 保存约定（与 office 插件一致，业务规则来自 specs/office-editor-plugin.md）：
 * 显式保存、写前比对 (size, mtimeMs)、先落 sibling 备份、原子替换；冲突时**拒绝写入**并提示。
 */
import type { IFileService } from "@zcode/services";
// 壳的样式仍从 npm 包引（纯 CSS）；**壳的 JS 走静态托管**，见 loadSuperDocShell 的注释。
import "superdoc/style.css";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 引擎地址：必须是一个**真实 http(s) 基址**（SuperDoc 壳只认 http(s)，并在其后拼
 * `/dist-cdn/docx-engine.es.js` 与 `/dist-cdn/style.css`）。
 *
 * 资产由 `packages/ui/scripts/copy-superdoc-assets.mjs` 原样复制到 `public/superdoc/`，
 * 交给 Vite 当静态文件托管。**不要**改成从 node_modules 直接 import：dev server 会把 10.6 MB 的
 * worker 当源码处理（内联 sourcemap 后 48.6 MB），导致 module worker 起不来（真机报 "worker not start"）。
 *
 * 生产（file:// 页面）下相对路径取不到模块，需要主进程 loopback 静态服务——见
 * UWork-plugin/specs/office-in-core-research.md 的 C3 交付章节。
 */
const SUPERDOC_BASE_URL = `${import.meta.env.BASE_URL}superdoc`.replace(/\/{2,}/g, "/");
/** 引擎基址：壳会在其后拼 `/dist-cdn/docx-engine.es.js` 与 `/dist-cdn/style.css`。 */
const ENGINE_BASE_URL = SUPERDOC_BASE_URL;

/** 实例只用到 destroy/导出方法；其余按 unknown 处理，避免跟着 SuperDoc 的类型版本走。 */
type SuperDocInstance = { destroy?: () => void } & Record<string, unknown>;
type SuperDocConstructor = new (options: Record<string, unknown>) => SuperDocInstance;

/**
 * 加载 SuperDoc 壳（官方 CDN 产物，UMD，挂在 globalThis.SuperDoc）。
 *
 * 为什么不用 npm 的 ESM 壳：它内部是 `import("@superdoc/docx-engine")` 的**裸导入**，会被打包器静态
 * 解析成 node_modules 里的路径，绕过我们静态托管的引擎；那个副本的 worker 资产在 `dist/assets/` 下并不
 * 存在（真机报 `Failed to fetch dynamically imported module .../docx-engine/dist/assets/browser-worker-…`）。
 * CDN 壳改从 globalThis.SUPERDOC_ENGINE_CDN_BASE_URL 取基址，正好吃我们 public/ 下的静态资产。
 */
async function loadSuperDocShell(): Promise<SuperDocConstructor> {
  const existing = (globalThis as Record<string, unknown>).SuperDoc;
  if (typeof existing === "function") return existing as SuperDocConstructor;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${SUPERDOC_BASE_URL}/superdoc.min.js`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("SuperDoc 壳加载失败（静态资产缺失？）"));
    document.head.appendChild(script);
  });
  const loaded = (globalThis as Record<string, unknown>).SuperDoc;
  if (typeof loaded !== "function") throw new Error("SuperDoc 壳未暴露全局构造器");
  return loaded as SuperDocConstructor;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + step)));
  }
  return btoa(binary);
}

/** 实例的导出 API 名随版本变化（2.23 上只有 `export`/`save`，没有 `exportDocx`）：逐个试并归一成 Blob。 */
async function exportDocxBlob(editor: unknown): Promise<Blob | null> {
  const methods = ["exportDocx", "export", "save", "getFile"] as const;
  for (const name of methods) {
    const candidate = (editor as Record<string, unknown> | null)?.[name];
    if (typeof candidate !== "function") continue;
    try {
      const value = await (candidate as (options?: unknown) => Promise<unknown>).call(
        editor,
        name === "save" ? { format: "docx" } : undefined,
      );
      if (value instanceof Blob) return value;
      const wrapped = value as { blob?: unknown; file?: unknown } | null;
      if (wrapped?.blob instanceof Blob) return wrapped.blob;
      if (wrapped?.file instanceof Blob) return wrapped.file;
      if (value instanceof ArrayBuffer) return new Blob([value], { type: DOCX_MIME });
      if (value instanceof Uint8Array) {
        return new Blob([value as unknown as BlobPart], { type: DOCX_MIME });
      }
    } catch {
      // 该名字不是导出 API：继续试下一个
    }
  }
  return null;
}

export interface OfficeEditorPaneProps {
  fileService: IFileService;
  path: string;
  onExit?: () => void;
}

export function OfficeEditorPane({ fileService, path, onExit }: OfficeEditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<SuperDocInstance | null>(null);
  const revisionRef = useRef<{ size: number; mtimeMs: number } | null>(null);
  const [status, setStatus] = useState("正在加载文档…");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const dispose = useCallback(() => {
    try {
      (editorRef.current as unknown as { destroy?: () => void } | null)?.destroy?.();
    } catch {
      // 退出/重载时销毁失败不影响用户
    }
    editorRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    dispose();
    setDirty(false);
    setStatus("正在加载文档…");

    void (async () => {
      try {
        const [preview, fileStat] = await Promise.all([
          fileService.readBinaryPreview({ path }),
          fileService.stat({ path }),
        ]);
        if (cancelled || !hostRef.current) return;
        revisionRef.current =
          typeof fileStat.mtimeMs === "number"
            ? { size: preview.totalBytes, mtimeMs: fileStat.mtimeMs }
            : null;

        (globalThis as Record<string, unknown>).SUPERDOC_ENGINE_CDN_BASE_URL = ENGINE_BASE_URL;
        setStatus("加载 Office 编辑器…");
        const SuperDocCtor = await loadSuperDocShell();
        const bytes = base64ToBytes(preview.dataBase64);
        const file = new File([bytes as unknown as BlobPart], path.split("/").pop() ?? "document.docx", {
          type: DOCX_MIME,
        });
        setStatus("启动 Office 编辑器…");
        const editor = new SuperDocCtor({
          selector: "#office-editor-host",
          document: file,
          // 默认按修订记录改动：编辑结果在 Word 里仍是"未接受的修订"，与 office 插件的审阅流程同一套词汇。
          modules: { trackChanges: {} },
          onReady: () => {
            if (!cancelled) setStatus("编辑器就绪 · 改动默认记为修订；点「保存到文件」写回原文件");
          },
          onContentError: (payload: { error?: unknown }) => {
            if (!cancelled) setStatus(`文档内容错误：${String(payload?.error ?? "")}`);
          },
          onException: (payload: { error?: unknown }) => {
            if (!cancelled) setStatus(`编辑器异常：${String(payload?.error ?? "")}`);
          },
        });
        editorRef.current = editor;
        (globalThis as Record<string, unknown>).__officeEditor = editor;

        // 脏标记：SuperDoc 没有内容变更事件，宿主上监听输入类事件即可（保存前仍会做 revision 校验）。
        const host = hostRef.current;
        const markDirty = () => setDirty(true);
        for (const eventName of ["keydown", "paste", "cut", "drop", "input"] as const) {
          host.addEventListener(eventName, markDirty, true);
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(`编辑器启动失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      dispose();
    };
  }, [dispose, fileService, path]);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || busy) return;
    setBusy(true);
    try {
      setStatus("导出 docx…");
      const blob = await exportDocxBlob(editor);
      if (!blob) throw new Error("编辑器没有返回文档内容");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      setStatus(`写回文件（${Math.round(bytes.length / 1024)} KiB）…`);
      const result = await fileService.writeBinaryFile({
        path,
        dataBase64: bytesToBase64(bytes),
        ...(revisionRef.current ? { expectedRevision: revisionRef.current } : {}),
        backup: "sibling",
      });
      revisionRef.current = result.revision;
      setDirty(false);
      const backupName = result.backup ? result.backup.split("/").pop() : "";
      setStatus(
        `已保存到 ${path} · ${Math.round(result.bytes / 1024)} KiB${backupName ? ` · 备份 ${backupName}` : ""}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(
        message.includes("revision mismatch")
          ? "保存被拒：文件已被其它程序（可能是 Agent）修改。请「重新加载」或另存副本后再改。"
          : `保存失败：${message}`,
      );
    } finally {
      setBusy(false);
    }
  }, [busy, fileService, path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:border-accent"
          onClick={() => void save()}
          disabled={busy}
        >
          保存到文件
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:border-accent"
          onClick={() => {
            void (async () => {
              const [preview, fileStat] = await Promise.all([
                fileService.readBinaryPreview({ path }),
                fileService.stat({ path }),
              ]);
              revisionRef.current =
                typeof fileStat.mtimeMs === "number"
                  ? { size: preview.totalBytes, mtimeMs: fileStat.mtimeMs }
                  : null;
              setDirty(false);
              // 重新挂载编辑器（换 selector 会重建 DOM，最简单可靠）
              setStatus("重新加载文档…");
              dispose();
              const host = hostRef.current;
              if (!host) return;
              host.replaceChildren();
              const bytes = base64ToBytes(preview.dataBase64);
              const SuperDocCtor = await loadSuperDocShell();
              const editor = new SuperDocCtor({
                selector: "#office-editor-host",
                document: new File([bytes as unknown as BlobPart], path.split("/").pop() ?? "document.docx", {
                  type: DOCX_MIME,
                }),
                modules: { trackChanges: {} },
                onReady: () => setStatus("编辑器就绪 · 改动默认记为修订；点「保存到文件」写回原文件"),
              });
              editorRef.current = editor;
              (globalThis as Record<string, unknown>).__officeEditor = editor;
            })();
          }}
        >
          重新加载
        </button>
        {onExit ? (
          <button
            type="button"
            className="rounded border border-border px-2 py-1 hover:border-accent"
            onClick={() => {
              if (dirty && !window.confirm("有未保存的修改，确定退出编辑吗？")) return;
              onExit();
            }}
          >
            返回预览
          </button>
        ) : null}
        <span className="text-foreground-subtle">
          {dirty ? "● 未保存 · " : ""}
          {status}
        </span>
      </div>
      <div id="office-editor-host" ref={hostRef} className="min-h-0 flex-1 overflow-auto bg-surface" />
    </div>
  );
}
