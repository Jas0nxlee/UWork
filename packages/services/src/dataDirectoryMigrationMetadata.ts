/** 仅 CLI 契约规定的技能/命令启停映射以路径作键，普通 JSON 键不能泛化迁移。 */
export function relocateCliPathOverrides(
  config: Record<string, unknown>,
  roots: {
    source: string;
    target: string;
    canonicalSource: string;
    canonicalTarget: string;
  },
): void {
  for (const field of ["skills", "command"]) {
    const map = config[field];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const relocated: Record<string, unknown> = {};
    for (const [key, state] of Object.entries(map)) {
      const mappings = [
        [roots.source, roots.target],
        [roots.canonicalSource, roots.canonicalTarget],
      ];
      let nextKey = key;
      for (const [oldRoot, newRoot] of mappings) {
        const normalized = key.replaceAll("\\", "/");
        const prefix = oldRoot!.replaceAll("\\", "/");
        const comparable = /^[A-Za-z]:\//u.test(prefix) ? normalized.toLowerCase() : normalized;
        const parent = /^[A-Za-z]:\//u.test(prefix) ? prefix.toLowerCase() : prefix;
        if (comparable !== parent && !comparable.startsWith(`${parent}/`)) continue;
        const target = field === "skills" ? roots.canonicalTarget : newRoot!;
        const separator = field === "skills" || key.includes("/") ? "/" : "\\";
        nextKey =
          target.replaceAll("\\", separator) +
          normalized.slice(prefix.length).replaceAll("/", separator);
        break;
      }
      if (Object.hasOwn(relocated, nextKey))
        throw new Error("UWork migration path override collision");
      relocated[nextKey] = state;
    }
    config[field] = relocated;
  }
}
