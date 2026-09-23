// SVG 是主图标源；Electron 原生窗口需要 PNG/ICNS/ICO，构建时从同一源生成。
const { app, BrowserWindow } = require("electron");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { Icns, IcnsImage } = require("@fiahfy/icns");
const root = resolve(__dirname, "../build");
app
  .whenReady()
  .then(async () => {
    const svg = await readFile(join(root, "uwork.svg"), "utf8");
    const window = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      transparent: true,
      webPreferences: { offscreen: true, sandbox: true },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<style>html,body{margin:0;background:transparent;width:1024px;height:1024px;overflow:hidden}</style>" +
            svg,
        ),
    );
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const capture = await window.webContents.capturePage();
    const image = capture.resize({ width: 1024, height: 1024 });
    for (const name of ["icon.png", "icon_windows.png", "icon_installer.png"])
      await writeFile(join(root, name), image.toPNG());
    const icns = new Icns();
    for (const [size, type] of [
      [128, "ic07"],
      [256, "ic08"],
      [512, "ic09"],
      [1024, "ic10"],
    ])
      icns.append(IcnsImage.fromPNG(image.resize({ width: size, height: size }).toPNG(), type));
    for (const name of ["icon.icns", "icon_installer.icns"])
      await writeFile(join(root, name), icns.data);
    const png = image.resize({ width: 256, height: 256 }).toPNG();
    const ico = Buffer.alloc(22);
    ico.writeUInt16LE(1, 2);
    ico.writeUInt16LE(1, 4);
    ico.writeUInt16LE(1, 10);
    ico.writeUInt16LE(32, 12);
    ico.writeUInt32LE(png.length, 14);
    ico.writeUInt32LE(22, 18);
    for (const name of ["icon.ico", "icon_installer.ico"])
      await writeFile(join(root, name), Buffer.concat([ico, png]));
    await mkdir(join(root, "icons"), { recursive: true });
    for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024])
      await writeFile(
        join(root, "icons", `${size}x${size}.png`),
        image.resize({ width: size, height: size }).toPNG(),
      );
    console.log("UWork SVG icons generated");
    window.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
