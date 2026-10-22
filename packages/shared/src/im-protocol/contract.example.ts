import type { ImCardDocument } from "./contract.js";

export const exampleImCard: ImCardDocument = {
  card: { version: 1, type: "example" },
  fallback: "Example report",
  title: "Report",
  sections: [{ kind: "text", text: "Example content" }],
};
