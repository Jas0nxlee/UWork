import assert from "node:assert/strict";
import test from "node:test";
import { createEnterpriseLoginSurfaceGate } from "../src/hooks/enterpriseLoginSurfaceGate.js";
const surface = {
  bounds: { x: 50, y: 40, width: 280, height: 330 },
  appearance: {
    backgroundColor: "rgb(43,43,43)",
    foregroundColor: "rgb(230,230,230)",
    fontFamily: "Inter, sans-serif",
    fontSize: 14,
  },
};
test("native opening waits for the mounted surface without a timer", async () => {
  const gate = createEnterpriseLoginSurfaceGate();
  let completed = false;
  const waiting = gate.wait(new AbortController().signal).then((value) => {
    completed = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  gate.publish(surface);
  assert.deepEqual(await waiting, surface);
});
test("cancelled waiter cannot open a later surface; next attempt can reuse it", async () => {
  const gate = createEnterpriseLoginSurfaceGate();
  const controller = new AbortController();
  const waiting = gate.wait(controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  gate.publish(surface);
  assert.deepEqual(await gate.wait(new AbortController().signal), surface);
  gate.publish(null);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(gate.wait(aborted.signal));
});
