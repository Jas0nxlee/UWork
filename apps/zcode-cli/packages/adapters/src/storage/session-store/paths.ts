import { join } from "node:path";
import { resolveUserCliRoot } from "@zcode/shared";

export function getDefaultSessionDbPath(): string {
  return join(resolveUserCliRoot(), "db", "db.sqlite");
}
