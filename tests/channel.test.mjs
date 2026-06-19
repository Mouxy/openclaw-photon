import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.OPENCLAW_HOME = mkdtempSync(path.join(tmpdir(), "photon-channel-"));

const { __testing, photonPlugin } = await import(`../dist/src/channel.js?test=${Date.now()}`);
const state = await import("../dist/src/state.js");

function account(accountId = "default") {
  return {
    accountId,
    provider: "imessage",
    local: false,
    dispatchControlEvents: false,
    dispatchPollVotes: true,
    mentionNames: ["OpenClaw"],
  };
}

function running(id) {
  return {
    accountId: "default",
    app: { id },
    spaces: new Map(),
    messages: new Map([[`message-${id}`, { id: `message-${id}` }]]),
    reactionMessages: new Map([[`reaction-${id}`, `message-${id}`]]),
    seenMessages: new Map([[`seen-${id}`, Date.now()]]),
    status: { running: true, updatedAt: Date.now() },
  };
}

function space(id = "space-1") {
  return { id, type: "direct" };
}

function message(id, overrides = {}) {
  return {
    id,
    content: { type: "text", text: "hello" },
    direction: "inbound",
    platform: "iMessage",
    sender: { id: "+447" },
    timestamp: new Date(1000),
    ...overrides,
  };
}

test("releases inflight dedupe after handler failure so same-process redelivery can retry", () => {
  __testing.runningAccounts.clear();

  const current = running("current");
  assert.equal(__testing.tryAcquireMessage(current, "default", "msg-1"), false);
  assert.equal(current.inflightMessages.has("msg-1"), true);
  assert.equal(__testing.tryAcquireMessage(current, "default", "msg-1"), true);

  __testing.releaseMessage(current, "msg-1");

  assert.equal(current.inflightMessages.has("msg-1"), false);
  assert.equal(__testing.tryAcquireMessage(current, "default", "msg-1"), false);
});

test("acknowledges processed messages only after terminal handling", () => {
  const current = running("current");
  assert.equal(__testing.tryAcquireMessage(current, "default", "msg-2"), false);

  __testing.acknowledgeMessage(current, "default", "msg-2");

  assert.equal(current.inflightMessages.has("msg-2"), false);
  assert.equal(current.seenMessages.has("msg-2"), true);
  assert.equal(__testing.tryAcquireMessage(current, "default", "msg-2"), true);
});

test("only batches dispatchable inbound user messages", () => {
  const cfg = account();
  assert.deepEqual(
    __testing.isBatchableInbound({ account: cfg, space: space(), message: message("msg-3") }),
    { batchable: true, senderId: "+447" },
  );

  assert.equal(
    __testing.isBatchableInbound({
      account: cfg,
      space: space(),
      message: message("msg-4", { direction: "outbound" }),
    }).batchable,
    false,
  );
  assert.equal(
    __testing.isBatchableInbound({
      account: cfg,
      space: space(),
      message: message("msg-5", { content: { type: "typing" } }),
    }).batchable,
    false,
  );
  assert.equal(
    __testing.isBatchableInbound({
      account: cfg,
      space: space(),
      message: message("msg-6", { content: { type: "text", text: "" } }),
    }).batchable,
    false,
  );
  assert.equal(
    __testing.isBatchableInbound({
      account: cfg,
      space: space(),
      message: message("msg-7", { content: { type: "text", text: "/doctor" } }),
    }).batchable,
    false,
  );
});

test("releases expired inflight leases so wedged dispatches can retry", () => {
  const current = running("current");
  assert.equal(__testing.tryAcquireMessage(current, "default", "msg-lease"), false);

  current.inflightMessages.set("msg-lease", Date.now() - 11 * 60 * 1000);

  assert.equal(__testing.tryAcquireMessage(current, "default", "msg-lease"), false);
  assert.ok(current.inflightMessages.get("msg-lease") > Date.now() - 1000);
});

test("shares one Spectrum app recreation for concurrent calls on the same account", async () => {
  __testing.runningAccounts.clear();
  __testing.recreationLocks.clear();

  const current = running("current");
  const next = running("next");
  const stopped = [];
  let createCalls = 0;
  const restore = __testing.setPhotonAppLifecycleForTests({
    create: async () => {
      createCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return next;
    },
    stop: async (app) => stopped.push(app.app.id),
  });

  try {
    __testing.runningAccounts.set("default", current);

    const [first, second] = await Promise.all([
      __testing.replaceRunningPhotonApp(account(), current),
      __testing.replaceRunningPhotonApp(account(), current),
    ]);

    assert.equal(createCalls, 1);
    assert.equal(first, next);
    assert.equal(second, next);
    assert.equal(__testing.runningAccounts.get("default"), next);
    assert.deepEqual(stopped, ["current"]);
    assert.equal(next.messages, current.messages);
    assert.equal(next.reactionMessages, current.reactionMessages);
    assert.equal(next.seenMessages, current.seenMessages);
    assert.equal(next.inflightMessages, current.inflightMessages);
    assert.equal(__testing.recreationLocks.size, 0);
  } finally {
    restore();
  }
});

test("does not replace a newer Spectrum app with an older recreation result", async () => {
  __testing.runningAccounts.clear();
  __testing.recreationLocks.clear();

  const current = running("current");
  const newer = running("newer");
  const stale = running("stale");
  const stopped = [];
  let resolveCreate;
  const restore = __testing.setPhotonAppLifecycleForTests({
    create: async () => new Promise((resolve) => {
      resolveCreate = () => resolve(stale);
    }),
    stop: async (app) => stopped.push(app.app.id),
  });

  try {
    __testing.runningAccounts.set("default", current);
    const replacement = __testing.replaceRunningPhotonApp(account(), current);

    await new Promise((resolve) => setTimeout(resolve, 0));
    __testing.runningAccounts.set("default", newer);
    resolveCreate();

    assert.equal(await replacement, newer);
    assert.equal(__testing.runningAccounts.get("default"), newer);
    assert.deepEqual(stopped, ["stale"]);
    assert.equal(__testing.recreationLocks.size, 0);
  } finally {
    restore();
  }
});

test("probe reports stale accepted deliveries as degraded", async () => {
  __testing.runningAccounts.clear();

  const current = running("current");
  __testing.runningAccounts.set("default", current);
  state.rememberPhotonDelivery("default", {
    id: "msg-stalled",
    inboundMessageId: "msg-stalled",
    spaceId: "space-1",
    status: "accepted",
    receivedAt: Date.now() - 60_000,
    acceptedAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
  });

  const result = await photonPlugin.status.probeAccount({ accountId: "default" });

  assert.equal(result.ok, false);
  assert.equal(result.details.unresolvedDeliveries, 1);
  assert.deepEqual(result.details.unresolvedDeliveryIds, ["msg-stalled"]);
});
