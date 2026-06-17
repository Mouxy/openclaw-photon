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
  assert.equal(account.typingIndicators, true);
  assert.equal(account.progressUpdates, true);
  assert.equal(account.longTurnNotice, true);
  assert.equal(account.longTurnNoticeDelayMs, 45_000);
  assert.equal(account.maxInboundAttachmentBytes, 20 * 1024 * 1024);
  assert.equal(account.maxOutboundAttachmentBytes, 50 * 1024 * 1024);
  assert.equal(account.dispatchControlEvents, false);
  assert.equal(account.dispatchPollVotes, true);
});

test("can disable long-turn typing indicators with the clearer config name", () => {
  const account = resolveAccount({
    channels: {
      photon: {
        typingIndicators: false,
        progressUpdates: true,
      },
    },
  });
  assert.equal(account.typingIndicators, false);
  assert.equal(account.progressUpdates, false);
});

test("keeps progressUpdates as a backwards-compatible typing indicator alias", () => {
  const account = resolveAccount({
    channels: {
      photon: {
        progressUpdates: false,
      },
    },
  });
  assert.equal(account.typingIndicators, false);
  assert.equal(account.progressUpdates, false);
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
