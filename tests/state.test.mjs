import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("persists spaces, latest messages, and reactions", async () => {
  process.env.OPENCLAW_HOME = mkdtempSync(path.join(tmpdir(), "photon-state-"));
  const state = await import(`../dist/src/state.js?test=${Date.now()}`);

  state.rememberPersistedSpace("default", {
    id: "space-1",
    type: "direct",
    label: "Example User",
    updatedAt: 1,
  });
  state.rememberPersistedMessage("default", {
    id: "msg-1",
    spaceId: "space-1",
    direction: "inbound",
    updatedAt: 2,
  });
  state.rememberPersistedMessage("default", {
    id: "msg-2",
    spaceId: "space-1",
    direction: "outbound",
    updatedAt: 4,
  });
  state.rememberPersistedReaction("default", {
    key: "reaction-key",
    spaceId: "space-1",
    targetMessageId: "msg-1",
    emoji: "👍",
    reactionMessageId: "reaction-1",
    updatedAt: 3,
  });
  state.rememberPhotonDelivery("default", {
    id: "msg-1",
    inboundMessageId: "msg-1",
    spaceId: "space-1",
    platform: "imessage",
    senderId: "user-1",
    chatType: "direct",
    bodyPreview: "hello",
    status: "received",
    receivedAt: 5,
  });
  state.updatePhotonDelivery("default", "msg-1", {
    status: "replied",
    outboundMessageIds: ["msg-2"],
    repliedAt: 6,
  });
  state.notePhotonStarted("default");
  state.notePhotonInbound("default", { id: "msg-1", spaceId: "space-1" });
  state.notePhotonOutbound("default", { id: "msg-2", spaceId: "space-1" });
  state.notePhotonStreamReconnect("default", new Error("ECONNRESET"));
  state.notePhotonStartFailed("default", new Error("fetch failed"), 12345);
  assert.equal(state.getPhotonStatus("default").running, false);
  assert.equal(state.getPhotonStatus("default").lastStartError, "Error: fetch failed");
  assert.equal(state.getPhotonStatus("default").nextStartRetryAt, 12345);
  assert.equal(state.getPhotonStatus("default").startAttemptCount, 1);
  state.notePhotonStarted("default");

  assert.equal(state.listPersistedSpaces("default")[0].id, "space-1");
  assert.equal(state.getLatestPersistedMessageForSpace("default", "space-1").id, "msg-2");
  assert.equal(state.getLatestPersistedMessageForSpace("default", "space-1", "inbound").id, "msg-1");
  assert.equal(state.getLatestPersistedMessageForSpace("default", "space-1", "outbound").id, "msg-2");
  assert.equal(state.hasProcessedPersistedMessage("default", "msg-1"), false);
  state.rememberProcessedPersistedMessage("default", "msg-1");
  assert.equal(state.hasProcessedPersistedMessage("default", "msg-1"), true);
  assert.equal(state.getPersistedReaction("default", "reaction-key").reactionMessageId, "reaction-1");
  assert.equal(state.getPhotonStatus("default").running, true);
  assert.equal(state.getPhotonStatus("default").lastStartError, undefined);
  assert.equal(state.getPhotonStatus("default").nextStartRetryAt, undefined);
  assert.equal(state.getPhotonStatus("default").startAttemptCount, 0);
  assert.equal(state.getPhotonStatus("default").lastInboundMessageId, "msg-1");
  assert.equal(state.getPhotonStatus("default").lastOutboundMessageId, "msg-2");
  assert.equal(state.getPhotonStatus("default").streamReconnectCount, 0);
  assert.equal(state.getPhotonDelivery("default", "msg-1").status, "replied");
  assert.deepEqual(state.getPhotonDelivery("default", "msg-1").outboundMessageIds, ["msg-2"]);
  assert.equal(state.listPhotonDeliveries("default")[0].id, "msg-1");

  state.forgetPersistedReaction("default", "reaction-key");
  assert.equal(state.getPersistedReaction("default", "reaction-key"), undefined);
});
