const globSymbols = new Set("\\*?[]{}()!+@|");

export function createForceRerunTriggers(root, defaults) {
  // 官方 matcher 的 glob 不穿过隐藏祖先；固定 root 必须按字面量匹配，不能当作 glob 拼入。
  const normalized = /^(?:[a-z]:\\|\\\\)/i.test(root) ? root.replaceAll("\\", "/") : root;
  const literalRoot = [...normalized.replace(/\/+$/, "")]
    .map((character) => (globSymbols.has(character) ? `\\${character}` : character))
    .join("");
  return [
    ...defaults,
    ...["**/package.json", "**/{vitest,vite}.config.*", "**/vitest.setup.ts"].map(
      (pattern) => `${literalRoot}/${pattern}`,
    ),
  ];
}
