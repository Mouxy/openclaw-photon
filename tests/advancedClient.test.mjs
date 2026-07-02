import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.OPENCLAW_HOME = process.env.OPENCLAW_HOME || mkdtempSync(path.join(tmpdir(), "photon-advanced-"));

const { advancedTargetMessage, closeAdvancedClients, withAdvancedIMessageClient } = await import(
  `../dist/src/advancedClient.js?test=${Date.now()}`
);

test("advancedTargetMessage splits child part ids and passes plain guids through", () => {
  assert.deepEqual(advancedTargetMessage("p:2/ABC-123"), { messageGuid: "ABC-123", partIndex: 2 });
  assert.deepEqual(advancedTargetMessage("ABC-123"), { messageGuid: "ABC-123" });
  assert.deepEqual(advancedTargetMessage("  ABC-123  "), { messageGuid: "ABC-123" });
});

test("withAdvancedIMessageClient refuses local mode and missing credentials", async () => {
  const space = { id: "space-1" };
  await assert.rejects(
    withAdvancedIMessageClient({ accountId: "a", local: true, projectId: "p", projectSecret: "s" }, space, async () => {}),
    /remote\/cloud/,
  );
  await assert.rejects(
    withAdvancedIMessageClient({ accountId: "a", local: false }, space, async () => {}),
    /projectId\/projectSecret/,
  );
});

test("closeAdvancedClients is a no-op for unknown accounts", async () => {
  await closeAdvancedClients("never-started");
});
