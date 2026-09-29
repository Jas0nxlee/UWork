const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const { createWriteStream } = require("node:fs");
const path = require("node:path");
const { tmpdir } = require("node:os");
const { pipeline } = require("node:stream/promises");
const yazl = require("yazl");
const extract = require("../index.cjs");

async function fixture(entries, operation) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "uwork-safe-zip-"));
  try {
    const zip = new yazl.ZipFile();
    for (const entry of entries)
      zip.addBuffer(Buffer.from(entry.content), entry.name, {
        mode: entry.mode ?? 0o100644,
        compress: entry.compress !== false,
      });
    zip.end();
    const archive = path.join(root, "input.zip");
    await pipeline(zip.outputStream, createWriteStream(archive));
    const directory = path.join(root, "output");
    await fs.mkdir(directory);
    await operation({ root, directory, archive });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("normal nested files retain executable mode and callback contract", async () => {
  await fixture(
    [{ name: "bin/tool", content: "fixture", mode: 0o100755 }],
    async ({ archive, directory }) => {
      const names = [];
      await extract(archive, { dir: directory, onEntry: (entry) => names.push(entry.fileName) });
      assert.equal(await fs.readFile(path.join(directory, "bin/tool"), "utf8"), "fixture");
      assert.deepEqual(names, ["bin/tool"]);
      if (process.platform !== "win32")
        assert.equal((await fs.stat(path.join(directory, "bin/tool"))).mode & 0o777, 0o755);
    },
  );
});

test(
  "contained Framework links including a forward target remain usable",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      [
        { name: "Framework/Versions/Current", content: "A", mode: 0o120777 },
        { name: "Framework/Versions/A/Binary", content: "framework" },
        { name: "Framework/Binary", content: "Versions/Current/Binary", mode: 0o120777 },
      ],
      async ({ archive, directory }) => {
        await extract(archive, { dir: directory });
        assert.equal(
          await fs.readFile(path.join(directory, "Framework/Binary"), "utf8"),
          "framework",
        );
      },
    );
  },
);

test("an outside symlink target is rejected before it is created", async () => {
  await fixture(
    [{ name: "escape", content: "../victim", mode: 0o120777 }],
    async ({ root, directory, archive }) => {
      await fs.writeFile(path.join(root, "victim"), "preserved");
      await assert.rejects(extract(archive, { dir: directory }), /leaves extraction root/);
      await assert.rejects(fs.lstat(path.join(directory, "escape")), { code: "ENOENT" });
      assert.equal(await fs.readFile(path.join(root, "victim"), "utf8"), "preserved");
    },
  );
});

test("absolute symlinks cannot reference external files", async () => {
  await fixture(
    [{ name: "escape", content: "/etc/passwd", mode: 0o120777 }],
    async ({ archive, directory }) => {
      await assert.rejects(extract(archive, { dir: directory }), /Unsafe ZIP symbolic link/);
    },
  );
});

test(
  "a pre-existing file symlink cannot be followed by a regular entry",
  { skip: process.platform === "win32" },
  async () => {
    await fixture([{ name: "file", content: "attacker" }], async ({ root, directory, archive }) => {
      const victim = path.join(root, "victim");
      await fs.writeFile(victim, "preserved");
      await fs.symlink(victim, path.join(directory, "file"));
      await assert.rejects(extract(archive, { dir: directory }), /link or special file/);
      assert.equal(await fs.readFile(victim, "utf8"), "preserved");
    });
  },
);

test(
  "entry writes do not traverse a pre-existing directory symlink",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      [{ name: "folder/file", content: "attacker" }],
      async ({ root, directory, archive }) => {
        const outside = path.join(root, "outside");
        await fs.mkdir(outside);
        await fs.symlink(outside, path.join(directory, "folder"));
        await assert.rejects(extract(archive, { dir: directory }), /plain directory/);
        await assert.rejects(fs.lstat(path.join(outside, "file")), { code: "ENOENT" });
      },
    );
  },
);

test(
  "a regular entry cannot overwrite a symlink created earlier in the archive",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      [
        { name: "target", content: "preserved" },
        { name: "link", content: "target", mode: 0o120777 },
        { name: "link", content: "attacker" },
      ],
      async ({ directory, archive }) => {
        await assert.rejects(extract(archive, { dir: directory }), /link or special file/);
        assert.equal(await fs.readFile(path.join(directory, "target"), "utf8"), "preserved");
      },
    );
  },
);

test("oversized link content is rejected and relative extraction dirs are forbidden", async () => {
  await fixture(
    [{ name: "link", content: "x".repeat(4097), mode: 0o120777 }],
    async ({ archive, directory }) => {
      await assert.rejects(extract(archive, { dir: directory }), /too large/);
      await assert.rejects(extract(archive, { dir: "relative" }), /absolute/);
    },
  );
});

test(
  "a stored symlink resolves without hanging at EOF",
  { skip: process.platform === "win32", timeout: 3000 },
  async () => {
    await fixture(
      [
        { name: "target", content: "fixture", compress: false },
        { name: "link", content: "target", mode: 0o120777, compress: false },
      ],
      async ({ archive, directory }) => {
        await extract(archive, { dir: directory });
        assert.equal(await fs.readFile(path.join(directory, "link"), "utf8"), "fixture");
      },
    );
  },
);

test(
  "a dangling external link cannot become an accepted target",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      [{ name: "alias", content: "dangling/missing", mode: 0o120777 }],
      async ({ archive, root, directory }) => {
        await fs.symlink(path.join(root, "outside"), path.join(directory, "dangling"));
        await assert.rejects(extract(archive, { dir: directory }), /Unsafe ZIP symbolic link/);
      },
    );
  },
);

test(
  "parent traversal is interpreted after resolving an existing link",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(
      [{ name: "alias", content: "folder/../file", mode: 0o120777 }],
      async ({ archive, root, directory }) => {
        await fs.symlink("../outside", path.join(directory, "folder"));
        await assert.rejects(extract(archive, { dir: directory }), /leaves extraction root/);
        await assert.rejects(fs.lstat(path.join(root, "file")), { code: "ENOENT" });
      },
    );
  },
);
