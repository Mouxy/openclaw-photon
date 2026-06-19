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

test("batched Photon messages combine close follow-ups into one grouped content payload", () => {
  const first = {
    id: "msg-1",
    content: { type: "text", text: "Can we improve batching?" },
    sender: { id: "+447" },
    timestamp: new Date(1000),
    direction: "inbound",
    platform: "iMessage",
  };
  const second = {
    id: "msg-2",
    content: { type: "text", text: "Like now for example..." },
    sender: { id: "+447" },
    timestamp: new Date(2000),
    direction: "inbound",
    platform: "iMessage",
  };

  const batched = inbound.createBatchedPhotonMessage([first, second]);

  assert.equal(batched.id, "msg-2");
  assert.deepEqual(batched.photonBatchMessageIds, ["msg-1", "msg-2"]);
  assert.equal(batched.sender.id, "+447");
  assert.equal(batched.timestamp, second.timestamp);
  assert.equal(batched.content.type, "group");
  assert.deepEqual(
    batched.content.items.map((item) => item.content.text),
    ["Can we improve batching?", "Like now for example..."],
  );
});
