/* eslint-disable max-lines -- 单文件自包含是本脚本的取舍：夹具、检查页与断言放一起才看得懂，拆成多个 lib 反而要来回跳。 */
/**
 * 3D 模型预览的冒烟检查：无头 Chromium + 真 WebGL + 现场生成的夹具，确认"真的画出来了"。
 *
 * 只做三件事，单文件自包含（不依赖 office 那套检查脚手架）：
 *   ① 一个带贴图的自包含 .glb 与一个二进制 .stl 都能解析并渲染出画面（像素 + 一行模型信息）；
 *   ② 视角可以被拖动，重置按钮把画面还原；
 *   ③ 损坏字节进入错误态并给出可读文案。
 *
 * 用法：node packages/ui/scripts/check-model-preview.mjs
 * 浏览器：优先 UI_CHECK_CHROMIUM / 缓存里的 Chromium，其次交给 playwright 自己找。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** 8×8 纯色 PNG（#40A0DC）：贴图通路只要它是合法 PNG 就够。 */
const TEXTURE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNwWHAHK2IYWhIAOE1vAXJOVPkAAAAASUVORK5CYII=";

const CUBE_FACES = [
  {
    normal: [0, 0, 1],
    corners: [
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ],
  },
  {
    normal: [0, 0, -1],
    corners: [
      [1, -1, -1],
      [-1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
    ],
  },
  {
    normal: [1, 0, 0],
    corners: [
      [1, -1, 1],
      [1, -1, -1],
      [1, 1, -1],
      [1, 1, 1],
    ],
  },
  {
    normal: [-1, 0, 0],
    corners: [
      [-1, -1, -1],
      [-1, -1, 1],
      [-1, 1, 1],
      [-1, 1, -1],
    ],
  },
  {
    normal: [0, 1, 0],
    corners: [
      [-1, 1, 1],
      [1, 1, 1],
      [1, 1, -1],
      [-1, 1, -1],
    ],
  },
  {
    normal: [0, -1, 0],
    corners: [
      [-1, -1, -1],
      [1, -1, -1],
      [1, -1, 1],
      [-1, -1, 1],
    ],
  },
];

/** 立方体：12 三角面 / 24 顶点（面之间不共享顶点，与真实导出器一致）。 */
function createCube() {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const face of CUBE_FACES) {
    const base = positions.length / 3;
    for (const [index, corner] of face.corners.entries()) {
      positions.push(...corner);
      normals.push(...face.normal);
      uvs.push(index === 0 || index === 3 ? 0 : 1, index < 2 ? 0 : 1);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices };
}

function padTo4(buffer, fill) {
  const padding = (4 - (buffer.byteLength % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding, fill)]);
}

/** 自包含 GLB：JSON 块 + BIN 块，贴图也放在 BIN 里。 */
function buildGlb() {
  const cube = createCube();
  const png = Buffer.from(TEXTURE_PNG_BASE64, "base64");
  const parts = [
    Buffer.from(new Float32Array(cube.positions).buffer),
    Buffer.from(new Float32Array(cube.normals).buffer),
    Buffer.from(new Float32Array(cube.uvs).buffer),
    Buffer.from(new Uint16Array(cube.indices).buffer),
    png,
  ];
  const bufferViews = [];
  let offset = 0;
  let binary = Buffer.alloc(0);
  for (const part of parts) {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: part.byteLength });
    binary = Buffer.concat([binary, padTo4(part, 0)]);
    offset += padTo4(part, 0).byteLength;
  }

  const json = {
    asset: { version: "2.0", generator: "uwork-model-preview-check" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
        ],
      },
    ],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 4, mimeType: "image/png" }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: "VEC3",
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 24, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };

  const jsonChunk = padTo4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.byteLength + 8 + binary.byteLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.byteLength, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.byteLength, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binary]);
}

/** 二进制 STL：84 字节头 + 每面 50 字节。 */
function buildBinaryStl() {
  const cube = createCube();
  const header = Buffer.alloc(84);
  header.write("uwork model preview check", 0, "ascii");
  header.writeUInt32LE(12, 80);
  const body = Buffer.alloc(600);
  let offset = 0;
  for (let triangle = 0; triangle < 12; triangle += 1) {
    for (const value of CUBE_FACES[Math.floor(triangle / 2)].normal) {
      body.writeFloatLE(value, offset);
      offset += 4;
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = cube.indices[triangle * 3 + corner];
      for (let axis = 0; axis < 3; axis += 1) {
        body.writeFloatLE(cube.positions[vertex * 3 + axis], offset);
        offset += 4;
      }
    }
    offset += 2;
  }
  return Buffer.concat([header, body]);
}

const PAGE = `<!doctype html>
<meta charset="utf-8"><link rel="icon" href="data:,">
<style>
  html, body { margin: 0; height: 100%; }
  /* 检查页是裸 HTML（不引 Tailwind），所以画布的铺满要靠这里的 CSS 补上，
     否则画布停在默认 300×150，鼠标事件也落不到它身上。 */
  #host { height: 100%; }
  #host canvas { display: block; width: 100%; height: 100%; }
</style>
<div id="host"></div>
<script type="module" src="/model.js"></script>`;

const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ModelPreviewViewer } from ${JSON.stringify(join(repoRoot, "packages/ui/src/modelPreview/ModelPreviewViewer.js"))};

const labels = {
  loading: "loading",
  resetView: "reset-view",
  unavailable: "unavailable",
  invalidData: "invalid-data",
  emptyModel: "empty-model",
  unsupportedExtension: (extensions) => "unsupported:" + extensions,
  missingResource: (uri) => "missing:" + uri,
  webglUnavailable: "webgl-unavailable",
  summary: ({ triangles, size }) => triangles + " triangles / " + size,
};

const root = createRoot(document.getElementById("host"));
window.mountModel = async ({ url, format, modelPath }) => {
  const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
  root.render(createElement(ModelPreviewViewer, {
    data,
    format,
    labels,
    modelPath,
    readBytes: async (path) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error("missing resource: " + path);
      return new Uint8Array(await response.arrayBuffer());
    },
    resolvedTheme: "light",
  }));
};
`;

/** 优先用配置/缓存里的 Chromium：playwright 只认它自己那个 revision，机器上常常只有别的。 */
function resolveChromium() {
  for (const key of ["UI_CHECK_CHROMIUM", "OFFICE_CHECK_CHROMIUM"]) {
    if (process.env[key]?.trim()) {
      return process.env[key].trim();
    }
  }
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ].filter(Boolean);
  const relativePaths = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-win/chrome.exe",
  ];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    const revisions = entries
      .filter((name) => name.startsWith("chromium-"))
      .sort((a, b) => Number(b.split("-")[1] ?? 0) - Number(a.split("-")[1] ?? 0));
    for (const revision of revisions) {
      for (const relative of relativePaths) {
        const candidate = join(root, revision, relative);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures.push(label);
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "model-preview-"));
  writeFileSync(join(dir, "cube.glb"), buildGlb());
  writeFileSync(join(dir, "cube.stl"), buildBinaryStl());
  writeFileSync(join(dir, "broken.glb"), Buffer.from("this is not a model at all"));
  writeFileSync(join(dir, "index.html"), PAGE, "utf8");
  writeFileSync(join(dir, "modelEntry.tsx"), ENTRY, "utf8");

  const esbuild = await import("esbuild");
  const built = await esbuild.build({
    entryPoints: { model: join(dir, "modelEntry.tsx") },
    outdir: dir,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    absWorkingDir: repoRoot,
    nodePaths: [join(repoRoot, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
  });
  for (const file of built.outputFiles) {
    writeFileSync(join(dir, basename(file.path)), file.text, "utf8");
  }

  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
    try {
      const body = readFileSync(join(dir, path === "/" ? "index.html" : path));
      // 模块脚本必须带 JS MIME，否则 Chromium 会拒绝执行（动态 import 的 chunk 也走这里）。
      const contentType = path.endsWith(".html")
        ? "text/html"
        : path.endsWith(".js")
          ? "text/javascript"
          : "application/octet-stream";
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));

  const { chromium } = await import("playwright-core");
  const executablePath = resolveChromium();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);

  const waitForState = (state) =>
    page.waitForFunction(
      (expected) =>
        document.querySelector("[data-model-preview-viewer]")?.dataset.modelPreviewState ===
        expected,
      state,
      { timeout: 20000 },
    );
  const mount = (options) => page.evaluate((next) => window.mountModel(next), options);
  /** 截图→丢回页面里用 2D canvas 取像素：不需要在 Node 侧写 PNG 解码器。 */
  const analyze = async () => {
    const shot = (await page.locator("[data-model-preview-canvas]").screenshot()).toString(
      "base64",
    );
    return page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const insetX = Math.floor(image.width * 0.25);
      const insetY = Math.floor(image.height * 0.25);
      const data = context.getImageData(
        insetX,
        insetY,
        image.width - insetX * 2,
        image.height - insetY * 2,
      ).data;
      const background = [data[0], data[1], data[2]];
      let foreground = 0;
      let total = 0;
      let blueish = 0;
      for (let index = 0; index < data.length; index += 4) {
        total += 1;
        const distance =
          Math.abs(data[index] - background[0]) +
          Math.abs(data[index + 1] - background[1]) +
          Math.abs(data[index + 2] - background[2]);
        if (distance > 24) {
          foreground += 1;
          if (data[index + 2] > data[index] + 10) {
            blueish += 1;
          }
        }
      }
      // 16×16 采样格：用来判断"画面有没有变"，比单一比例稳健（转一个立方体，覆盖面积几乎不变）。
      const samples = [];
      for (let row = 0; row < 16; row += 1) {
        for (let column = 0; column < 16; column += 1) {
          const x = Math.floor(((column + 0.5) / 16) * image.width);
          const y = Math.floor(((row + 0.5) / 16) * image.height);
          const index = (y * image.width + x) * 4;
          samples.push(data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0);
        }
      }
      return { ratio: foreground / total, blueish: blueish / total, samples };
    }, shot);
  };

  /** 两张画面里"明显不同"的采样格占比。 */
  const sampleDiff = (a, b) => {
    let differing = 0;
    for (let index = 0; index < a.samples.length; index += 3) {
      const distance =
        Math.abs(a.samples[index] - b.samples[index]) +
        Math.abs(a.samples[index + 1] - b.samples[index + 1]) +
        Math.abs(a.samples[index + 2] - b.samples[index + 2]);
      if (distance > 30) {
        differing += 1;
      }
    }
    return differing / (a.samples.length / 3);
  };

  await mount({ url: "/cube.glb", format: "gltf", modelPath: "/cube.glb" });
  await waitForState("ready");
  const glbSummary = await page.textContent("[data-model-preview-summary]");
  const glbPixels = await analyze();
  check(
    "glb：解析并显示模型信息",
    glbSummary?.includes("12") === true && glbSummary?.includes("2.00") === true,
    glbSummary ?? "",
  );
  check(
    "glb：画面里出现了模型（非背景像素占比）",
    glbPixels.ratio > 0.2,
    glbPixels.ratio.toFixed(3),
  );
  check("glb：贴图生效（画面偏蓝）", glbPixels.blueish > 0.1, glbPixels.blueish.toFixed(3));

  await page.mouse.move(450, 350);
  await page.mouse.down();
  await page.mouse.move(620, 410, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const rotated = await analyze();
  const rotatedDiff = sampleDiff(glbPixels, rotated);
  check("交互：拖拽后视角变化", rotatedDiff > 0.15, `画面差异 ${rotatedDiff.toFixed(3)}`);
  await page.click('[data-model-preview-action="reset"]');
  await page.waitForTimeout(300);
  const reset = await analyze();
  const resetDiff = sampleDiff(glbPixels, reset);
  check("交互：重置视角回到自动取景", resetDiff < 0.02, `画面差异 ${resetDiff.toFixed(3)}`);

  await mount({ url: "/cube.stl", format: "stl", modelPath: "/cube.stl" });
  await waitForState("ready");
  const stlSummary = await page.textContent("[data-model-preview-summary]");
  const stlPixels = await analyze();
  check("stl（二进制）：解析并渲染", stlSummary?.includes("12") === true, stlSummary ?? "");
  check("stl：画面里出现了模型", stlPixels.ratio > 0.2, stlPixels.ratio.toFixed(3));

  await mount({ url: "/broken.glb", format: "gltf", modelPath: "/broken.glb" });
  await waitForState("error");
  const errorText = await page.textContent("[data-model-preview-error]");
  check(
    "损坏字节：进入错误态并给出可读文案",
    errorText?.includes("invalid-data") === true,
    errorText ?? "",
  );
  check("整轮没有页面报错", pageErrors.length === 0, pageErrors.join(" | "));

  await browser.close();
  server.close();
  console.log(failures.length > 0 ? `\n✗ 失败 ${failures.length} 条` : "\n✓ 3D 预览冒烟通过");
  process.exit(failures.length > 0 ? 1 : 0);
}

await main();
