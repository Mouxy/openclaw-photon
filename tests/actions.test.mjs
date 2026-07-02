import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.OPENCLAW_HOME = mkdtempSync(path.join(tmpdir(), "photon-actions-"));

const { createPhotonMessageActions } = await import(`../dist/src/actions.js?test=${Date.now()}`);
const state = await import("../dist/src/state.js");

function cfg(extra = {}) {
  return {
    channels: {
      photon: {
        enabled: true,
        provider: "imessage",
        nativeActions: true,
        ...extra,
      },
    },
  };
}

function mockRunning() {
  const calls = [];
  const sent = [];
  const recoveredMessages = new Map();
  const space = {
    id: "space-1",
    type: "group",
    __platform: "iMessage",
    send: async (content) => {
      const built = typeof content?.build === "function" ? await content.build() : content;
      if (built.type === "reaction") {
        calls.push(["react", built.emoji]);
      } else if (built.type === "unsend") {
        calls.push([built.target?.content?.type === "reaction" ? "unsend-reaction" : "unsend"]);
      } else if (built.type === "edit") {
        calls.push(["edit", built.content]);
      } else if (built.type === "reply") {
        calls.push(["reply", built.content]);
      }
      const message = {
        id: built.type === "reply" ? "reply-1" : built.type === "reaction" ? "reaction-1" : `sent-${sent.length + 1}`,
        platform: "iMessage",
        direction: "outbound",
        sender: { id: "agent" },
        content: built,
        timestamp: new Date(),
        space,
        edit: async () => {},
        unsend: async () => {},
        react: async () => undefined,
        reply: async () => undefined,
      };
      running?.messages?.set?.(message.id, message);
      recoveredMessages.set(message.id, message);
      sent.push(message);
      return message;
    },
    getMessage: async (id) => running.messages.get(id) ?? recoveredMessages.get(id),
    rename: async (name) => calls.push(["rename", name]),
    avatar: async (input) => calls.push(["avatar", Buffer.isBuffer(input) ? "buffer" : input]),
  };
  const inbound = {
    id: "msg-1",
    platform: "iMessage",
    direction: "inbound",
    sender: { id: "user" },
    content: { type: "text", text: "hello" },
    timestamp: new Date(),
    space,
    react: async (emoji) => {
      calls.push(["react", emoji]);
      const reaction = {
        id: "reaction-1",
        platform: "iMessage",
        direction: "outbound",
        sender: { id: "agent" },
        content: { type: "reaction", emoji },
        timestamp: new Date(),
        space,
        unsend: async () => calls.push(["unsend-reaction"]),
      };
      running.messages.set(reaction.id, reaction);
      recoveredMessages.set(reaction.id, reaction);
      return reaction;
    },
    read: async () => calls.push(["read"]),
    edit: async (content) => calls.push(["edit", typeof content?.build === "function" ? await content.build() : content]),
    unsend: async () => calls.push(["unsend"]),
    reply: async (content) => {
      calls.push(["reply", typeof content?.build === "function" ? await content.build() : content]);
      return {
        id: "reply-1",
        platform: "iMessage",
        direction: "outbound",
        sender: { id: "agent" },
        content: { type: "text", text: "reply" },
        timestamp: new Date(),
        space,
      };
    },
  };
  const outbound = {
    ...inbound,
    id: "out-1",
    direction: "outbound",
    sender: { id: "agent" },
  };
  const running = {
    accountId: "default",
    app: {},
    spaces: new Map([["space-1", space]]),
    messages: new Map([["msg-1", inbound], ["out-1", outbound]]),
    reactionMessages: new Map(),
    seenMessages: new Map(),
  };
  return { calls, recoveredMessages, running, sent };
}

test("handles native reaction add and remove", async () => {
  const { calls, running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  await actions.handleAction({
    action: "react",
    cfg: cfg(),
    params: { to: "space-1", messageId: "msg-1", emoji: "❤️" },
    senderIsOwner: true,
  });
  assert.deepEqual(calls[0], ["react", "❤️"]);

  await actions.handleAction({
    action: "react",
    cfg: cfg(),
    params: { to: "space-1", messageId: "msg-1", emoji: "❤️", remove: true },
    senderIsOwner: true,
  });
  assert.deepEqual(calls.at(-1), ["unsend-reaction"]);
});

test("removes a persisted reaction handle after in-memory restart state is gone", async () => {
  const { calls, running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  await actions.handleAction({
    action: "react",
    cfg: cfg(),
    params: { to: "space-1", messageId: "msg-1", emoji: "👍" },
    senderIsOwner: true,
  });

  running.reactionMessages.clear();
  running.messages.delete("reaction-1");

  await actions.handleAction({
    action: "react",
    cfg: cfg(),
    params: { to: "space-1", messageId: "msg-1", emoji: "👍", remove: true },
    senderIsOwner: true,
  });

  assert.deepEqual(calls.at(-1), ["unsend-reaction"]);
});

test("recovers a persisted synthetic DM message without using a blank chat id", async () => {
  const calls = [];
  const syntheticSpace = {
    id: "any;-;+15555550100",
    type: "direct",
    __platform: "iMessage",
    send: async (content) => calls.push(["space-send", typeof content?.build === "function" ? (await content.build()).type : content.type]),
    getMessage: async (id) => ({
      id,
      platform: "iMessage",
      direction: "inbound",
      sender: { id: "+15555550100" },
      content: { type: "text", text: "restart target" },
      timestamp: new Date(),
      space: syntheticSpace,
      read: async () => calls.push(["read"]),
    }),
  };
  const running = {
    accountId: "default",
    app: {},
    spaces: new Map([[syntheticSpace.id, syntheticSpace]]),
    messages: new Map(),
    reactionMessages: new Map(),
    seenMessages: new Map(),
  };
  state.rememberPersistedMessage(running.accountId, {
    id: "synthetic-msg-1",
    spaceId: syntheticSpace.id,
    platform: "iMessage",
    direction: "inbound",
    updatedAt: Date.now(),
  });

  const actions = createPhotonMessageActions(new Map([[running.accountId, running]]));
  const result = await actions.handleAction({
    action: "read",
    cfg: cfg(),
    params: { messageId: "synthetic-msg-1" },
    senderIsOwner: true,
  });

  assert.equal(result.details.messageId, "synthetic-msg-1");
  assert.deepEqual(calls, [["space-send", "read"]]);
});

test("removes a persisted synthetic-key reaction after canonical message recovery", async () => {
  const calls = [];
  const syntheticSpace = {
    id: "any;-;+15555550100",
    type: "direct",
    __platform: "iMessage",
    send: async (content) => {
      const built = typeof content?.build === "function" ? await content.build() : content;
      if (built.type === "unsend" && built.target?.content?.type === "reaction") calls.push(["unsend-reaction"]);
    },
  };
  const canonicalSpace = {
    id: "chat-real-1",
    type: "direct",
    __platform: "iMessage",
    send: async (content) => {
      const built = typeof content?.build === "function" ? await content.build() : content;
      if (built.type === "unsend" && built.target?.content?.type === "reaction") calls.push(["unsend-reaction"]);
    },
  };
  syntheticSpace.getMessage = async (id) => ({
    id,
    platform: "iMessage",
    direction: "inbound",
    sender: { id: "+15555550100" },
    content: { type: "text", text: "target" },
    timestamp: new Date(),
    space: canonicalSpace,
  });
  const reaction = {
    id: "reaction-synthetic-1",
    platform: "iMessage",
    direction: "outbound",
    content: { type: "reaction", emoji: "👍" },
    timestamp: new Date(),
    space: syntheticSpace,
    unsend: async () => calls.push(["unsend-reaction"]),
  };
  const running = {
    accountId: "default",
    app: {},
    spaces: new Map([[syntheticSpace.id, syntheticSpace]]),
    messages: new Map([[reaction.id, reaction]]),
    reactionMessages: new Map(),
    seenMessages: new Map(),
  };
  const targetMessageId = "synthetic-msg-2";
  const syntheticKey = `${syntheticSpace.id}\u0000${targetMessageId}\u0000👍`;
  state.rememberPersistedMessage(running.accountId, {
    id: targetMessageId,
    spaceId: syntheticSpace.id,
    platform: "iMessage",
    direction: "inbound",
    updatedAt: Date.now(),
  });
  state.rememberPersistedReaction(running.accountId, {
    key: syntheticKey,
    spaceId: syntheticSpace.id,
    targetMessageId,
    emoji: "👍",
    reactionMessageId: reaction.id,
    updatedAt: Date.now(),
  });

  const actions = createPhotonMessageActions(new Map([[running.accountId, running]]));
  await actions.handleAction({
    action: "react",
    cfg: cfg(),
    params: { messageId: targetMessageId, emoji: "👍", remove: true },
    senderIsOwner: true,
  });

  assert.deepEqual(calls, [["unsend-reaction"]]);
});

test("keeps plain send on the core outbound path", () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  assert.equal(actions.resolveExecutionMode({ action: "send" }), "local");
  assert.equal(actions.resolveExecutionMode({ action: "react" }), "gateway");
  assert.equal(actions.resolveExecutionMode({ action: "thread-reply" }), "gateway");
  assert.equal(actions.resolveExecutionMode({ action: "poll" }), "gateway");
  assert.equal(actions.resolveExecutionMode({ action: "photonDoctor" }), "gateway");
});

test("reports Photon doctor status through an OpenClaw-shaped tool result", async () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  const result = await actions.handleAction({
    action: "photonDoctor",
    cfg: cfg(),
    params: {},
    senderIsOwner: true,
  });

  assert.equal(result.details.ok, true);
  assert.equal(result.details.channel, "photon");
  assert.equal(result.details.action, "photonDoctor");
  assert.equal(result.details.effectsDefault, false);
  assert.equal(result.details.customMiniAppsExposed, true);
  assert.deepEqual(result.details.health, {
    unresolvedTransportError: false,
    unresolvedStreamReconnect: false,
    unresolvedDeliveries: 0,
  });
  assert.equal(result.details.state.cachedSpaces, 1);
});

test("marks Photon doctor unhealthy while transport errors are unresolved", async () => {
  const { running } = mockRunning();
  running.status = {
    running: true,
    lastTransportError: "Connection dropped",
    lastTransportErrorAt: 2000,
    lastTransportRecoveryAt: 1000,
    updatedAt: 2000,
  };
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  const result = await actions.handleAction({
    action: "photonDoctor",
    cfg: cfg(),
    params: {},
    senderIsOwner: true,
  });

  assert.equal(result.details.ok, false);
  assert.equal(result.details.health.unresolvedTransportError, true);
});

test("advertises direct mini-app cards while owner-gating group controls", () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  const ownerDescription = actions.describeMessageTool({
    cfg: cfg(),
    accountId: "default",
    senderIsOwner: true,
  });
  assert.ok(ownerDescription.actions.includes("sendMiniApp"));
  assert.ok(ownerDescription.mediaSourceParams.sendMiniApp.includes("image"));

  const nonOwnerDescription = actions.describeMessageTool({
    cfg: cfg(),
    accountId: "default",
    senderIsOwner: false,
  });
  assert.equal(nonOwnerDescription.actions.includes("sendMiniApp"), true);
  assert.equal(nonOwnerDescription.actions.includes("setBackground"), false);
  assert.equal(nonOwnerDescription.actions.includes("placeSticker"), false);
  assert.equal(nonOwnerDescription.actions.includes("requestLocation"), false);
});

test("advertises owner-gated advanced iMessage actions to the owner", () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  const ownerDescription = actions.describeMessageTool({
    cfg: cfg(),
    accountId: "default",
    senderIsOwner: true,
  });

  assert.ok(ownerDescription.actions.includes("sendContact"));
  assert.ok(ownerDescription.actions.includes("addPollOption"));
  assert.ok(ownerDescription.actions.includes("pollVote"));
  assert.ok(ownerDescription.actions.includes("pollUnvote"));
  assert.ok(ownerDescription.actions.includes("placeSticker"));
  assert.ok(ownerDescription.actions.includes("requestLocation"));
  assert.ok(ownerDescription.actions.includes("notifyAnyway"));
  assert.ok(ownerDescription.mediaSourceParams.placeSticker.includes("image"));
});

test("handles read, edit, unsend, effect, poll, aliases, and owner-gated rename", async () => {
  const { calls, running, sent } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  const base = { cfg: cfg(), params: { to: "space-1", messageId: "msg-1" }, senderIsOwner: true };
  const outboundBase = { ...base, params: { to: "space-1", messageId: "out-1" } };

  const readResult = await actions.handleAction({ ...base, action: "read" });
  await actions.handleAction({ ...outboundBase, action: "edit", params: { ...outboundBase.params, message: "**updated**" } });
  await actions.handleAction({ ...outboundBase, action: "unsend" });
  await actions.handleAction({
    ...base,
    action: "sendWithEffect",
    params: { to: "space-1", message: "https://example.com/boom", effect: "confetti" },
  });
  await actions.handleAction({
    ...base,
    action: "poll",
    params: { to: "space-1", pollQuestion: "Snack?", pollOption: ["Pizza", "Sushi"] },
  });
  await actions.handleAction({
    ...base,
    action: "sendMiniApp",
    params: {
      to: "space-1",
      appName: "OpenClaw",
      teamId: "ABCDE12345",
      extensionBundleId: "com.example.MessagesExtension",
      url: "https://example.com/card",
      caption: "Native card",
      subcaption: "Rendered by iMessage",
    },
  });
  await actions.handleAction({
    ...base,
    action: "sendContact",
    params: { to: "space-1", name: "Example Person", phone: "+15555550123", email: "person@example.com" },
  });
  await actions.handleAction({ ...base, action: "topic-edit", params: { to: "space-1", topic: "New Name" } });
  await actions.handleAction({ ...base, action: "delete", params: { to: "space-1", messageId: "out-1" } });

  assert.equal(readResult.details.scope, "chat");
  assert.equal(readResult.details.visibility, "best_effort_until_next_chat_activity");
  assert.equal(sent[0].content.type, "read");
  assert.equal(calls[0][0], "edit");
  assert.deepEqual(calls[1], ["unsend"]);
  const effectMessage = sent.find((message) => message.content.type === "effect");
  const pollMessage = sent.find((message) => message.content.type === "poll");
  const miniAppMessage = sent.find((message) => message.content.type === "customized-mini-app");
  const contactMessage = sent.find((message) => message.content.type === "contact");
  assert.equal(effectMessage.content.content.type, "markdown");
  assert.ok(pollMessage);
  assert.equal(miniAppMessage.content.layout.caption, "Native card");
  assert.equal(contactMessage.content.name.formatted, "Example Person");
  assert.deepEqual(calls.at(-2), ["rename", "New Name"]);
  assert.deepEqual(calls.at(-1), ["unsend"]);

  await assert.rejects(
    actions.handleAction({
      action: "renameGroup",
      cfg: cfg(),
      params: { to: "space-1", name: "Nope" },
      senderIsOwner: false,
    }),
    /restricted to the owner/,
  );
});

test("can optimistically acknowledge effect sends before iMessage confirms delivery", async () => {
  let resolveSend;
  const sent = [];
  const space = {
    id: "space-1",
    type: "direct",
    __platform: "iMessage",
    send: async (content) => {
      const built = typeof content?.build === "function" ? await content.build() : content;
      return await new Promise((resolve) => {
        resolveSend = () => {
          const message = {
            id: "sent-later",
            platform: "iMessage",
            direction: "outbound",
            sender: { id: "agent" },
            content: built,
            timestamp: new Date(),
            space,
          };
          sent.push(message);
          resolve(message);
        };
      });
    },
  };
  const running = {
    accountId: "default",
    app: {},
    spaces: new Map([["space-1", space]]),
    messages: new Map(),
    reactionMessages: new Map(),
    seenMessages: new Map(),
    status: {},
  };
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  const result = await Promise.race([
    actions.handleAction({
      action: "sendWithEffect",
      cfg: cfg({ effectAck: "optimistic" }),
      params: { to: "space-1", message: "Fast fireworks", effect: "fireworks" },
      senderIsOwner: true,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("optimistic effect send did not return promptly")), 50)),
  ]);

  assert.equal(result.details.accepted, true);
  assert.equal(result.details.effectAck, "optimistic");
  assert.equal(result.details.messageId, undefined);
  assert.equal(sent.length, 0);

  resolveSend();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 1);
  assert.equal(running.messages.has("sent-later"), true);
});

test("owner-gates advanced iMessage mutation helpers", async () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  await assert.rejects(
    actions.handleAction({
      action: "requestLocation",
      cfg: cfg(),
      params: { to: "space-1", address: "+15555550123" },
      senderIsOwner: false,
    }),
    /restricted to the owner/,
  );

  await assert.rejects(
    actions.handleAction({
      action: "placeSticker",
      cfg: cfg(),
      params: { to: "space-1", messageId: "msg-1", buffer: Buffer.from("fake").toString("base64") },
      senderIsOwner: false,
    }),
    /restricted to the owner/,
  );
});

test("advanced iMessage helpers require Photon project credentials in cloud mode", async () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  const missingCreds = cfg({ projectIdEnv: "PHOTON_TEST_MISSING_PROJECT_ID", projectSecretEnv: "PHOTON_TEST_MISSING_PROJECT_SECRET" });

  await assert.rejects(
    actions.handleAction({
      action: "addPollOption",
      cfg: missingCreds,
      params: { to: "space-1", messageId: "msg-1", option: "Later" },
      senderIsOwner: true,
    }),
    /projectId\/projectSecret/,
  );

  await assert.rejects(
    actions.handleAction({
      action: "notifyAnyway",
      cfg: missingCreds,
      params: { to: "space-1", messageId: "msg-1" },
      senderIsOwner: true,
    }),
    /projectId\/projectSecret/,
  );
});

test("routes iOS text animations through the sendWithEffect textEffect option", async () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  await assert.rejects(
    actions.handleAction({
      action: "sendWithEffect",
      cfg: cfg({ projectIdEnv: "PHOTON_TEST_MISSING_PROJECT_ID", projectSecretEnv: "PHOTON_TEST_MISSING_PROJECT_SECRET" }),
      params: { to: "space-1", message: "This is amazing", textEffect: "bloom", phrase: "amazing" },
      senderIsOwner: true,
    }),
    /projectId\/projectSecret/,
  );

  await assert.rejects(
    actions.handleAction({
      action: "sendWithEffect",
      cfg: cfg({ projectId: "project", projectSecret: "secret" }),
      params: { to: "space-1", message: "This is amazing", textEffect: "wobble" },
      senderIsOwner: true,
    }),
    /big, small, shake, nod, explode, ripple, bloom, jitter/,
  );

  await assert.rejects(
    actions.handleAction({
      action: "sendWithEffect",
      cfg: cfg({ projectId: "project", projectSecret: "secret" }),
      params: { to: "space-1", message: "This is amazing", textEffect: "shake", phrase: "missing" },
      senderIsOwner: true,
    }),
    /phrase was not found/,
  );
});

test("uses direction-aware latest message defaults for direct actions", async () => {
  const { running } = mockRunning();
  const inbound = running.messages.get("msg-1");
  const outbound = running.messages.get("out-1");
  const space = running.spaces.get("space-1");
  space.type = "direct";

  state.rememberPersistedMessage(running.accountId, {
    id: inbound.id,
    spaceId: space.id,
    platform: "iMessage",
    direction: "inbound",
    updatedAt: 10,
  });
  state.rememberPersistedMessage(running.accountId, {
    id: outbound.id,
    spaceId: space.id,
    platform: "iMessage",
    direction: "outbound",
    updatedAt: 20,
  });

  const readCalls = [];
  const originalSend = space.send;
  space.send = async (content) => {
    const built = typeof content?.build === "function" ? await content.build() : content;
    readCalls.push(built.type);
    return originalSend(content);
  };

  const actions = createPhotonMessageActions(new Map([["default", running]]));

  const readResult = await actions.handleAction({
    action: "read",
    cfg: cfg(),
    params: { to: "space-1" },
    senderIsOwner: true,
  });
  assert.equal(readResult.details.messageId, inbound.id);
  assert.equal(readCalls[0], "read");

  const editResult = await actions.handleAction({
    action: "edit",
    cfg: cfg(),
    params: { to: "space-1", message: "edited outbound" },
    senderIsOwner: true,
  });
  assert.equal(editResult.details.messageId, outbound.id);
});

test("handles owner-gated chat background control", async () => {
  const { running, sent } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  await actions.handleAction({
    action: "setBackground",
    cfg: cfg(),
    params: { to: "space-1", clear: true },
    senderIsOwner: true,
  });
  assert.equal(sent[0].content.type, "background");
  assert.equal(sent[0].content.action.kind, "clear");

  await assert.rejects(
    actions.handleAction({
      action: "setBackground",
      cfg: cfg(),
      params: { to: "space-1", clear: true },
      senderIsOwner: false,
    }),
    /restricted to the owner/,
  );
});

test("handles direct mini-app cards with configured defaults", async () => {
  const { running, sent } = mockRunning();
  const space = running.spaces.get("space-1");
  space.type = "direct";
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  const config = cfg({
    miniAppDefaults: {
      appName: "OpenClaw",
      extensionBundleId: "ai.openclaw.MessagesExtension",
      teamId: "TEAM123456",
      url: "https://openclaw.ai/mini/demo",
      caption: "OpenClaw",
      subcaption: "Direct mini-app card",
      summary: "OpenClaw mini-app card",
    },
  });

  const described = actions.describeMessageTool({ cfg: config, senderIsOwner: false });
  assert.ok(described.actions.includes("sendMiniApp"));

  const result = await actions.handleAction({
    action: "mini-app",
    cfg: config,
    params: { to: "space-1", caption: "Direct card" },
    senderIsOwner: false,
  });

  assert.equal(sent[0].content.type, "customized-mini-app");
  assert.equal(sent[0].content.appName, "OpenClaw");
  assert.equal(sent[0].content.layout.caption, "Direct card");
  assert.equal(result.details.appName, "OpenClaw");
});

test("builds status cards from mini-app defaults and expands URL placeholders", async () => {
  const { running, sent } = mockRunning();
  const space = running.spaces.get("space-1");
  space.type = "direct";
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  const config = cfg({
    miniAppDefaults: {
      appName: "OpenClaw Status",
      extensionBundleId: "net.mouxy.openclawstatus.MessagesExtension",
      teamId: "TEAM123456",
      url: "openclawstatus://run?id={{runId}}&phase={{phase}}&step={{step}}&result={{result}}",
    },
  });

  const result = await actions.handleAction({
    action: "status-card",
    cfg: config,
    params: {
      to: "space-1",
      runId: "run 123",
      phase: "done",
      step: "Photon tests passed",
      result: "Gateway is healthy",
    },
    senderIsOwner: false,
  });

  const message = sent.find((sentMessage) => sentMessage.content.type === "customized-mini-app");
  assert.equal(message.content.appName, "OpenClaw Status");
  assert.equal(message.content.layout.caption, "OpenClaw done");
  assert.equal(message.content.layout.subcaption, "Gateway is healthy");
  assert.equal(message.content.url, "openclawstatus://run?id=run%20123&phase=complete&step=Photon%20tests%20passed&result=Gateway%20is%20healthy");
  assert.equal(result.details.extensionBundleId, "net.mouxy.openclawstatus.MessagesExtension");
});

test("keeps group mini-app cards owner-gated", async () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  await assert.rejects(
    actions.handleAction({
      action: "sendMiniApp",
      cfg: cfg(),
      params: {
        to: "space-1",
        appName: "OpenClaw",
        extensionBundleId: "ai.openclaw.MessagesExtension",
        teamId: "TEAM123456",
        url: "https://openclaw.ai/mini/demo",
        caption: "OpenClaw",
      },
      senderIsOwner: false,
    }),
    /restricted to the owner/,
  );
});

test("handles reply and upload-file with media result ids", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "photon-action-media-"));
  const image = path.join(dir, "photo.png");
  const document = path.join(dir, "report.pdf");
  writeFileSync(image, Buffer.from("fake-image"));
  writeFileSync(document, Buffer.from("fake-document"));

  const { calls, running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  const base = { cfg: cfg(), params: { to: "space-1", messageId: "msg-1" }, senderIsOwner: true };

  const replyResult = await actions.handleAction({
    ...base,
    action: "reply",
    params: { ...base.params, media: image },
  });
  assert.equal(replyResult.details.messageId, "reply-1");
  assert.deepEqual(calls[0][0], "reply");

  const uploadResult = await actions.handleAction({
    action: "upload-file",
    cfg: cfg(),
    params: { to: "space-1", message: "files", mediaUrls: [image, document] },
    senderIsOwner: true,
  });
  assert.equal(uploadResult.details.messageIds.length, 2);
  assert.ok(uploadResult.details.messageIds.every((id) => id.startsWith("sent-")));
});

test("edit sends plain text content because iMessage edits are text-only", async () => {
  const { calls, running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  await actions.handleAction({
    action: "edit",
    cfg: cfg(),
    params: { to: "space-1", messageId: "out-1", message: "**updated** text" },
    senderIsOwner: true,
  });

  const editCall = calls.find((call) => call[0] === "edit");
  assert.ok(editCall);
  assert.equal(editCall[1].type, "text");
  assert.equal(editCall[1].text, "**updated** text");
});

test("edit and unsend skip the inbound trigger message when no messageId is given", async () => {
  const { calls, running } = mockRunning();
  const inbound = running.messages.get("msg-1");
  const outbound = running.messages.get("out-1");
  const space = running.spaces.get("space-1");

  state.rememberPersistedMessage(running.accountId, {
    id: outbound.id,
    spaceId: space.id,
    platform: "iMessage",
    direction: "outbound",
    updatedAt: 10,
  });
  state.rememberPersistedMessage(running.accountId, {
    id: inbound.id,
    spaceId: space.id,
    platform: "iMessage",
    direction: "inbound",
    updatedAt: 20,
  });

  const actions = createPhotonMessageActions(new Map([["default", running]]));

  const unsendResult = await actions.handleAction({
    action: "unsend",
    cfg: cfg(),
    params: {},
    toolContext: { currentChannelId: "space-1", currentMessageId: "msg-1" },
    senderIsOwner: true,
  });
  assert.equal(unsendResult.details.messageId, "out-1");
  assert.deepEqual(calls.at(-1), ["unsend"]);

  const editResult = await actions.handleAction({
    action: "edit",
    cfg: cfg(),
    params: { message: "fixed" },
    toolContext: { currentChannelId: "space-1", currentMessageId: "msg-1" },
    senderIsOwner: true,
  });
  assert.equal(editResult.details.messageId, "out-1");
});

test("edit and unsend reject an explicitly inbound messageId with a clear error", async () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));

  await assert.rejects(
    actions.handleAction({
      action: "unsend",
      cfg: cfg(),
      params: { to: "space-1", messageId: "msg-1" },
      senderIsOwner: true,
    }),
    /agent sent/,
  );
});

test("edit and unsend propagate spectrum errors when no advanced fallback is possible", async () => {
  const { running } = mockRunning();
  const space = running.spaces.get("space-1");
  space.send = async () => {
    throw new Error("upstream 500");
  };
  // cfg() has no projectId/projectSecret, so the advanced fallback is gated off
  // and the original Spectrum error must surface unchanged.
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  await assert.rejects(
    actions.handleAction({
      action: "edit",
      cfg: cfg(),
      params: { to: "space-1", messageId: "out-1", message: "new text" },
      senderIsOwner: true,
    }),
    /upstream 500/,
  );
  await assert.rejects(
    actions.handleAction({
      action: "unsend",
      cfg: cfg(),
      params: { to: "space-1", messageId: "out-1" },
      senderIsOwner: true,
    }),
    /upstream 500/,
  );
});

test("edit skips the advanced fallback when the upstream EditMessage RPC itself failed", async () => {
  const { running } = mockRunning();
  const space = running.spaces.get("space-1");
  space.send = async () => {
    throw new Error(
      "IMessageError: An internal error occurred.: code=internalError <- ClientError: /photon.imessage.v1.MessageService/EditMessage INTERNAL: An internal error occurred.: code=13",
    );
  };
  // Credentials are configured, so only the RPC check can stop the fallback —
  // if it ran, withAdvancedIMessageClient would fail on token issuance with a
  // different error than the original one asserted here.
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  await assert.rejects(
    actions.handleAction({
      action: "edit",
      cfg: cfg({ projectId: "proj-1", projectSecret: "sec-1" }),
      params: { to: "space-1", messageId: "out-1", message: "new text" },
      senderIsOwner: true,
    }),
    /MessageService\/EditMessage INTERNAL/,
  );
});

test("unsend never bypasses Spectrum's capability refusal via the advanced fallback", async () => {
  const { running } = mockRunning();
  const space = running.spaces.get("space-1");
  space.send = async () => {
    const error = new Error('unsend is not supported for iMessage: iMessage polls cannot be unsent');
    error.name = "UnsupportedError";
    throw error;
  };
  // Credentials are configured, so only the capability check can stop the
  // fallback — if it ran, the poll would be unsent through the raw RPC.
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  await assert.rejects(
    actions.handleAction({
      action: "unsend",
      cfg: cfg({ projectId: "proj-1", projectSecret: "sec-1" }),
      params: { to: "space-1", messageId: "out-1" },
      senderIsOwner: true,
    }),
    /polls cannot be unsent/,
  );
});

test("local mode does not advertise or allow edit and unsend", async () => {
  const { running } = mockRunning();
  const actions = createPhotonMessageActions(new Map([["default", running]]));
  const localCfg = cfg({ local: true });

  const description = actions.describeMessageTool({
    cfg: localCfg,
    accountId: "default",
    senderIsOwner: true,
  });
  assert.equal(description?.actions?.includes("edit") ?? false, false);
  assert.equal(description?.actions?.includes("unsend") ?? false, false);

  await assert.rejects(
    actions.handleAction({
      action: "edit",
      cfg: localCfg,
      params: { to: "space-1", messageId: "out-1", message: "nope" },
      senderIsOwner: true,
    }),
    /remote\/cloud/,
  );

  await assert.rejects(
    actions.handleAction({
      action: "unsend",
      cfg: localCfg,
      params: { to: "space-1", messageId: "out-1" },
      senderIsOwner: true,
    }),
    /remote\/cloud/,
  );
});
