import assert from "node:assert/strict";
import { test } from "node:test";

const inbound = await import(`../dist/src/inbound.js?test=${Date.now()}`);

test("local Messages attachment lookup does not trust is_from_me for inbound Photon events", () => {
  const sql = inbound.buildLocalMessagesAttachmentCandidateSql({
    label: "IMG_5790.png",
    timestampMs: 1781737054000,
  });

  assert.ok(sql);
  assert.match(sql, /a\.transfer_name = 'IMG_5790\.png'/);
  assert.doesNotMatch(sql, /is_from_me/);
});

test("local Messages attachment lookup ignores generic attachment labels", () => {
  assert.equal(
    inbound.buildLocalMessagesAttachmentCandidateSql({
      label: "attachment",
      timestampMs: Date.now(),
    }),
    undefined,
  );
});
