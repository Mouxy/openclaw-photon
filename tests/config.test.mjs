import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAccount } from "../dist/src/config.js";

test("resolves safe defaults", () => {
  const account = resolveAccount({ channels: { photon: {} } });
  assert.equal(account.provider, "imessage");
  assert.equal(account.dmPolicy, "pairing");
  assert.equal(account.groupPolicy, "allowlist");
  assert.equal(account.requireMention, true);
  assert.equal(account.sendReadReceipts, true);
  assert.equal(account.maxInboundAttachmentBytes, 20 * 1024 * 1024);
  assert.equal(account.maxOutboundAttachmentBytes, 50 * 1024 * 1024);
  assert.equal(account.dispatchControlEvents, false);
});

test("normalizes allowlists", () => {
  const account = resolveAccount({
    channels: {
      photon: {
        allowFrom: [" Alice ", "alice", 123],
        groupAllowFrom: [" room ", "ROOM"],
      },
    },
  });
  assert.deepEqual(account.allowFrom, ["alice", "123"]);
  assert.deepEqual(account.groupAllowFrom, ["room"]);
});
