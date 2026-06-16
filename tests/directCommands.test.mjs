import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.OPENCLAW_HOME = mkdtempSync(path.join(tmpdir(), "photon-direct-commands-"));

const {
  buildPhotonAppsSummary,
  buildPhotonDoctorSummary,
  buildPhotonEffectsSummary,
  handlePhotonDirectCommand,
} = await import(`../dist/src/directCommands.js?test=${Date.now()}`);

function account(extra = {}) {
  return {
    accountId: "default",
    provider: "imessage",
    local: false,
    dmPolicy: "pairing",
    nativeActions: true,
    miniAppDefaults: {},
    ...extra,
  };
}

function mockContext(body) {
  const sent = [];
  const space = {
    id: "space-1",
    type: "direct",
    send: async (content) => {
      const built = typeof content?.build === "function" ? await content.build() : content;
      const message = {
        id: `sent-${sent.length + 1}`,
        platform: "iMessage",
        direction: "outbound",
        sender: { id: "agent" },
        content: built,
        timestamp: new Date(),
        space,
      };
      sent.push(message);
      return message;
    },
  };
  const message = {
    id: "cmd-1",
    platform: "iMessage",
    direction: "inbound",
    sender: { id: "user" },
    content: { type: "text", text: body },
    timestamp: new Date(),
    space,
    reply: async (content) => space.send(content),
  };
  const running = {
    accountId: "default",
    app: {},
    spaces: new Map([["space-1", space]]),
    messages: new Map([[message.id, message]]),
    reactionMessages: new Map(),
    seenMessages: new Map(),
    status: { running: true, updatedAt: Date.now() },
  };
  return {
    account: account(),
    cfg: { channels: { photon: { provider: "imessage", nativeActions: true } } },
    message,
    normalized: {
      provider: "photon",
      accountId: "default",
      platform: "iMessage",
      spaceId: "space-1",
      spaceLabel: "Example User",
      senderId: "user",
      messageId: message.id,
      rawBody: body,
      chatType: "direct",
      wasMentioned: false,
      timestamp: Date.now(),
    },
    running,
    sent,
    space,
  };
}

test("summarizes direct Photon command affordances", () => {
  assert.match(buildPhotonEffectsSummary(), /\/effect <name> <message>/);
  assert.match(buildPhotonEffectsSummary(), /\/animate <name> <message>/);
  assert.match(buildPhotonEffectsSummary(), /big, small, shake, nod, explode, ripple, bloom, jitter/);
  assert.match(buildPhotonAppsSummary(account()), /\/animate <name> <message>/);
  assert.match(buildPhotonAppsSummary(account()), /mini-app defaults: missing appName, teamId, extensionBundleId, url/);
  assert.match(buildPhotonDoctorSummary(account(), mockContext("/doctor").running), /Photon doctor/);
});

test("handles direct read-only Photon commands before model dispatch", async () => {
  const ctx = mockContext("/effects");

  const handled = await handlePhotonDirectCommand(ctx);

  assert.equal(handled, true);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].content.type, "markdown");
  assert.match(ctx.sent[0].content.markdown, /confetti/);
});

test("lets non-Photon slash commands fall through to OpenClaw command runtime", async () => {
  const ctx = mockContext("/status");

  const handled = await handlePhotonDirectCommand(ctx);

  assert.equal(handled, false);
  assert.equal(ctx.sent.length, 0);
});

test("sends direct effect commands through native iMessage effect action", async () => {
  const ctx = mockContext("/effect confetti ship it");

  const handled = await handlePhotonDirectCommand(ctx);

  assert.equal(handled, true);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].content.type, "effect");
  assert.equal(ctx.sent[0].content.content.type, "markdown");
  assert.equal(ctx.sent[0].content.content.markdown, "ship it");
});

test("shows direct text animation usage when missing arguments", async () => {
  const ctx = mockContext("/animate");

  const handled = await handlePhotonDirectCommand(ctx);

  assert.equal(handled, true);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].content.type, "markdown");
  assert.match(ctx.sent[0].content.markdown, /\/animate <name> <message>/);
});
