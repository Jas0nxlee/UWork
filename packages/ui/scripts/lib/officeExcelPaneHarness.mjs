/**
 * **编辑位形状**的页面脚手架：把产品里的 `ExcelEditorPane` 整块挂起来（配一个假的 IFileService）。
 *
 * 拆成独立文件的原因：仓库规矩单文件 ≤400 行，而 officeExcelPage 里已经装了裸引擎、xlsx 适配层、
 * 生命周期钩子三套脚手架。这里是第四套，而且它是"点单元格选不中"那个 bug 的专用回归位——
 * 裸引擎挂载测不出那个问题（见 specs/office-editors-triad.md §2.2b）。
 */
export const EXCEL_PANE_HARNESS = `/** 一份 xlsx 里还有哪些公式（诊断用：结构编辑会把公式整行搬走）。 */
window.__formulaReport = async (bytes) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const out = [];
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value;
        if (value && typeof value === "object" && "formula" in value) {
          out.push(worksheet.name + "!" + cell.address + "=" + value.formula);
        }
      });
    });
  }
  return out;
};


window.__excelPane = {
  async mount(bytes) {
    window.__paneCalls = [];
    window.__paneService = {
      readBinaryPreview: async () => ({
        path: "/tmp/表.xlsx",
        dataBase64: window.__flow.base64(bytes),
        totalBytes: bytes.byteLength,
      }),
      stat: async () => ({ mtimeMs: 1700000000000 }),
      writeBinaryFile: async (args) => {
        window.__paneCalls.push(args);
        return { revision: { size: 1, mtimeMs: 2 }, backup: "/tmp/表.xlsx.bak", bytes: args.dataBase64.length };
      },
    };
    const host = document.getElementById("host");
    // 顺序要紧：先卸载上一个 root（它会自己摘掉 DOM），再清容器；
    // 反过来会让 React 在卸载时找不到自己的节点（removeChild 报错）。
    window.__paneRoot?.unmount();
    host.replaceChildren();
    const container = document.createElement("div");
    container.style.height = "100%";
    host.append(container);
    window.__paneRoot = createRoot(container);
    window.__paneRoot.render(
      createElement(ExcelEditorPane, {
        fileService: window.__paneService,
        path: "/tmp/表.xlsx",
      }),
    );
    // 等编辑位把文件读进来、引擎实例就绪
    for (let tick = 0; tick < 100; tick += 1) {
      if (window.__officeExcelApi?.current) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return Boolean(window.__officeExcelApi?.current);
  },
  api: () => window.__officeExcelApi?.current ?? null,
  status: () => document.querySelector("[data-office-toolbar]")?.textContent?.slice(0, 90) ?? "",
  calls: () => window.__paneCalls ?? [],
};
`;
