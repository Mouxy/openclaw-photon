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
  state.notePhotonTransportError("default", new Error("[upstream] Connection dropped"));
  assert.equal(state.getPhotonStatus("default").lastTransportError, "Error: [upstream] Connection dropped");
  assert.equal(state.getPhotonStatus("default").transportErrorCount, 1);
  assert.ok(state.getPhotonStatus("default").lastTransportErrorAt >= state.getPhotonStatus("default").lastTransportRecoveryAt);
  state.notePhotonOutbound("default", { id: "msg-3", spaceId: "space-1" });
  assert.equal(state.getPhotonStatus("default").lastTransportError, undefined);
  assert.equal(state.getPhotonStatus("default").lastTransportErrorAt, undefined);
  assert.ok(state.getPhotonStatus("default").lastTransportRecoveryAt >= state.getPhotonStatus("default").lastOutboundAt);
  state.notePhotonStreamReconnect("default", new Error("ECONNRESET"));
  assert.equal(state.getPhotonStatus("default").lastStreamError, "Error: ECONNRESET");
  assert.equal(state.getPhotonStatus("default").streamReconnectCount, 1);
  assert.equal(state.getPhotonStatus("default").lastTransportError, "Error: ECONNRESET");
  state.notePhotonInbound("default", { id: "msg-recovered", spaceId: "space-1" });
  assert.equal(state.getPhotonStatus("default").lastStreamError, undefined);
  assert.equal(state.getPhotonStatus("default").lastTransportError, undefined);
  assert.equal(state.getPhotonStatus("default").lastTransportErrorAt, undefined);
  assert.equal(state.getPhotonStatus("default").streamReconnectCount, 1);
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
  assert.equal(state.getPhotonStatus("default").lastInboundMessageId, "msg-recovered");
  assert.equal(state.getPhotonStatus("default").lastOutboundMessageId, "msg-3");
  assert.equal(state.getPhotonStatus("default").streamReconnectCount, 0);
  assert.equal(state.getPhotonDelivery("default", "msg-1").status, "replied");
  assert.deepEqual(state.getPhotonDelivery("default", "msg-1").outboundMessageIds, ["msg-2"]);
  assert.equal(state.listPhotonDeliveries("default")[0].id, "msg-1");
  state.rememberPhotonDelivery("default", {
    id: "msg-stalled",
    inboundMessageId: "msg-stalled",
    spaceId: "space-1",
    status: "accepted",
    receivedAt: 10,
    acceptedAt: 10,
    updatedAt: Date.now() - 60_000,
  });
  assert.equal(state.listUnresolvedPhotonDeliveries("default", 30_000)[0].id, "msg-stalled");
  assert.equal(state.failPendingPhotonDeliveries("default", "test restart", 123456), 1);
  assert.equal(state.listUnresolvedPhotonDeliveries("default", 30_000).length, 0);
  assert.equal(state.getPhotonDelivery("default", "msg-stalled").status, "failed");
  assert.equal(state.getPhotonDelivery("default", "msg-stalled").reason, "test restart");
  assert.equal(state.getPhotonDelivery("default", "msg-stalled").failedAt, 123456);
  state.rememberPhotonDelivery("default", {
    id: "msg-handled",
    inboundMessageId: "msg-handled",
    spaceId: "space-1",
    status: "accepted",
    receivedAt: 10,
    acceptedAt: 10,
    updatedAt: Date.now() - 60_000,
  });
  state.updatePhotonDelivery("default", "msg-handled", {
    status: "handled",
    reason: "no channel reply recorded",
    handledAt: 20,
  });
  assert.equal(state.listUnresolvedPhotonDeliveries("default", 30_000).length, 0);
  assert.equal(state.getPhotonDelivery("default", "msg-handled").status, "handled");
  assert.equal(state.getPhotonDelivery("default", "msg-handled").handledAt, 20);

  state.forgetPersistedReaction("default", "reaction-key");
  assert.equal(state.getPersistedReaction("default", "reaction-key"), undefined);
});
