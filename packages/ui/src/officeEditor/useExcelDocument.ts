/**
 * Excel 编辑位的**生命周期**（对应 Word 那边的 useOfficeDocument）。
 *
 * 与 Word 同口径的三条安全线：
 *   ① 远端先探写能力（老远端没有 writeBinaryFile，不能等改完才发现存不回去）；
 *   ② 护栏：图表/透视表/宏/切片器/外部连接/条件格式/结构化表格/图片 —— 这些 exceljs 重写会丢，
 *      于是**只给只读**（能看、能复制，不能改），并把原因写在界面上；
 *   ③ 产物校验不过就不写盘（xlsxValidate：打不开/少表/内容掉两成）。
 * 写回是**在原字节上做差分**（见 xlsxWorkbook），所以批注、超链接、数据验证这类"我们没映射但
 * exceljs 认得"的东西会原样留在文件里。
 */
import type { Sheet } from "@fortune-sheet/core";
import type { OfficeEditorFilePort } from "./contract.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToArrayBuffer, bytesToBase64 } from "./binary.js";
import { probeWriteSupport } from "./fileWriteSupport.js";
import { analyzeXlsx, summarizeXlsxFindings, type XlsxFindings } from "./xlsxPreflight.js";
import { validateXlsxCandidate } from "./xlsxValidate.js";
import { writeSheetsToXlsx, type StructureOp } from "./xlsxWorkbook.js";
import { readXlsxToSheets } from "./xlsxRead.js";
import type { StructureEdit } from "./excelStructure.js";

/** 应用内编辑的体积上限：xlsx 是压缩包，24 MB 的文件解出来通常是它的十几倍。 */
export const MAX_EDITABLE_XLSX_BYTES = 24 * 1024 * 1024;
/** 单元格数上限（引擎按 canvas 画，几十万格的表在侧栏里没有意义）。 */
export const MAX_EDITABLE_CELLS = 200_000;

export interface ExcelGuardState {
  findings: XlsxFindings;
  notices: string[];
  /** 护栏命中：能看不能改。 */
  readOnly: boolean;
}

export interface UseExcelDocumentInput {
  fileService: OfficeEditorFilePort;
  path: string;
  /** 远端工作区：载入前先探一次写能力。 */
  remote?: boolean;
  /** 取引擎里的当前表（保存时用；getAllSheets 的返回是快照）。 */
  getSheets: () => Sheet[] | undefined;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}

export function useExcelDocument(input: UseExcelDocumentInput) {
  const { fileService, path, remote, getSheets, onDirtyChange } = input;
  const [status, setStatus] = useState("正在打开表格…");
  const [dirty, setDirtyState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  /** 每成功载入一次 +1：挂载用的 key 靠它变，重新加载才会真的重建网格。 */
  const [loadCount, setLoadCount] = useState(0);
  const [writeBlocked, setWriteBlocked] = useState<string | null>(null);
  const [guard, setGuard] = useState<ExcelGuardState | null>(null);
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | undefined>(undefined);

  /** 打开时的文件字节：差分写回的源。 */
  const sourceRef = useRef<ArrayBuffer | null>(null);
  /** 导入快照：分不出"用户改的"和"适配器没映射的"时不能写回，所以这份必须留着。 */
  const baselineRef = useRef<Sheet[] | null>(null);
  const revisionRef = useRef<{ size: number; mtimeMs: number } | null>(null);
  /** 用户做过的行列结构操作（插入/删除）：保存时要落到文件上（连批注与行高一起搬）。 */
  const structureEditsRef = useRef<StructureOp[]>([]);

  /**
   * 脏标记回调**必须放进 ref**：`onDirtyChange` 通常是父组件里的内联箭头函数（每次渲染都是新的），
   * 一旦进依赖，`setDirty` → `loadDocument` → 挂载 effect 会**每次渲染都重新载入一次**，
   * 表现就是"一直停在正在打开…"（这条由 check-office-excel-flow.mjs 抓出来）。
   */
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const setDirty = useCallback((value: boolean) => {
    setDirtyState(value);
    onDirtyChangeRef.current?.(value);
  }, []);

  /** 结构操作既要写进文件（见 StructureOp），也要标脏。 */
  const recordStructureEdit = useCallback(
    (edit: StructureEdit, sheetName: string) => {
      structureEditsRef.current.push({ sheetName, edit });
      setDirty(true);
    },
    [setDirty],
  );

  const loadDocument = useCallback(async () => {
    setReady(false);
    setStatus("正在打开表格…");
    setSheets(null);
    setGuard(null);
    structureEditsRef.current = [];
    setDirty(false);
    try {
      const [preview, fileStat] = await Promise.all([
        fileService.readBinaryPreview({ path }),
        fileService.stat({ path }),
      ]);
      revisionRef.current =
        typeof fileStat.mtimeMs === "number"
          ? { size: preview.totalBytes, mtimeMs: fileStat.mtimeMs }
          : null;
      if (remote) {
        const probe = await probeWriteSupport(fileService, path);
        if (!probe.supported) {
          setWriteBlocked(probe.reason ?? "服务端不支持写回");
          setStatus(`远端工作区不支持应用内编辑：${probe.reason ?? "服务端不支持写回"}`);
          return;
        }
        setWriteBlocked(null);
      }
      if (preview.totalBytes > MAX_EDITABLE_XLSX_BYTES) {
        setStatus(
          `表格过大（${Math.round(preview.totalBytes / 1048576)} MB），不在应用内编辑：请用只读预览。`,
        );
        return;
      }
      const raw = base64ToArrayBuffer(preview.dataBase64);
      sourceRef.current = raw;
      setStatus("检查表格里有哪些特性…");
      const findings = await analyzeXlsx(raw);
      const notices = summarizeXlsxFindings(findings);
      const startedAt = performance.now();
      const read = await readXlsxToSheets(raw);
      const cells = read.sheets.reduce((total, sheet) => total + (sheet.celldata?.length ?? 0), 0);
      if (cells > MAX_EDITABLE_CELLS) {
        setStatus(
          `表格内容过多（${cells.toLocaleString()} 个非空格子，上限 ${MAX_EDITABLE_CELLS.toLocaleString()}）：请用只读预览。`,
        );
        return;
      }
      baselineRef.current = read.sheets;
      setSheets(read.sheets);
      setActiveSheet(read.activeSheet);
      setGuard({ findings, notices, readOnly: notices.length > 0 });
      setReady(true);
      setLoadCount((count) => count + 1);
      const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      setStatus(
        notices.length > 0
          ? `已载入 ${read.sheets.length} 张表（${seconds}s）· 这份工作簿只读：${notices[0] ?? ""}`
          : `已载入 ${read.sheets.length} 张表 / ${cells.toLocaleString()} 个非空格子（解析 ${seconds}s）· 点「保存到文件」写回`,
      );
    } catch (error) {
      setStatus(`打开失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [fileService, path, remote, setDirty]);

  useEffect(() => {
    void loadDocument();
  }, [loadDocument]);

  const save = useCallback(async () => {
    if (busy) return;
    if (guard?.readOnly) {
      setStatus("这份工作簿在护栏里是只读的（保存会丢掉图表/透视表等），因此没有写盘");
      return;
    }
    const source = sourceRef.current;
    const baseline = baselineRef.current;
    const current = getSheets();
    if (!source || !baseline || !current) {
      setStatus("表格还没加载好，稍等一下再保存");
      return;
    }
    setBusy(true);
    try {
      setStatus("写回中（只在原文件上改动了的部分）…");
      const written = await writeSheetsToXlsx({
        source,
        baseline,
        current,
        structureEdits: structureEditsRef.current,
      });
      if (written.changedCells === 0) {
        setStatus("没有检测到改动，未写盘");
        setDirty(false);
        return;
      }
      const validation = await validateXlsxCandidate(written.bytes, source);
      if (!validation.ok) {
        // 校验不过就不写盘：宁可让用户看到明确的失败原因，也不能写坏文件
        setStatus(
          `已拒绝写入：产物没通过校验 —— ${validation.issues
            .map((issue) => issue.message)
            .join("；")}（表格仍在编辑器里，未保存）`,
        );
        return;
      }
      const bytes = new Uint8Array(written.bytes);
      const result = await fileService.writeBinaryFile({
        path,
        dataBase64: bytesToBase64(bytes),
        ...(revisionRef.current ? { expectedRevision: revisionRef.current } : {}),
        backup: "sibling",
      });
      revisionRef.current = result.revision;
      // 保存后前移基线与源字节：否则第二次保存会把上一次的改动再写一遍
      sourceRef.current = written.bytes.slice(0);
      baselineRef.current = current;
      structureEditsRef.current = [];
      setDirty(false);
      const backupName = result.backup ? result.backup.split("/").pop() : "";
      setStatus(
        `已保存到 ${path} · ${Math.round(result.bytes / 1024)} KiB${backupName ? ` · 备份 ${backupName}` : ""}${
          written.notes.length > 0 ? ` · ${written.notes.join(" · ")}` : ""
        }`,
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
  }, [busy, fileService, getSheets, guard?.readOnly, path, setDirty]);

  return {
    status,
    setStatus,
    dirty,
    setDirty,
    busy,
    ready,
    loadCount,
    writeBlocked,
    guard,
    sheets,
    activeSheet,
    loadDocument,
    save,
    recordStructureEdit,
    /** 还没写回文件的行列结构操作数（检查与调试用；保存后归零）。
     *  用函数而不是值：ref 变了不会触发重渲染，取快照会一直读到旧数。 */
    structureEditCount: () => structureEditsRef.current.length,
  };
}
