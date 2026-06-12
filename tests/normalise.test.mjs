import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDirectTextCommandMetadata,
  cleanLeadingMention,
  isPhotonControlEventContent,
  normalizePhotonInbound,
} from "../dist/src/inbound.js";

test("normalizes a text message", () => {
  const account = {
    accountId: "default",
    mentionNames: ["Ambrósio"],
  };
  const space = {
    id: "chat-1",
    type: "dm",
    __platform: "iMessage",
  };
  const message = {
    id: "msg-1",
    platform: "iMessage",
    direction: "inbound",
    sender: { id: "user", name: "Example User" },
    content: { type: "text", text: "hello" },
    timestamp: new Date("2026-06-11T19:20:00Z"),
  };

  const result = normalizePhotonInbound({ account, space, message });
  assert.equal(result.spaceId, "chat-1");
  assert.equal(result.senderId, "user");
  assert.equal(result.rawBody, "hello");
  assert.equal(result.chatType, "direct");
});

test("detects configured mentions in groups", () => {
  const account = {
    accountId: "default",
    mentionNames: ["Ambrósio"],
  };
  const result = normalizePhotonInbound({
    account,
    space: { id: "chat-2", type: "group", __platform: "iMessage" },
    message: {
      id: "msg-2",
      platform: "iMessage",
      direction: "inbound",
      sender: { id: "user" },
      content: { type: "text", text: "@Ambrosio can you see this?" },
      timestamp: new Date("2026-06-11T19:20:00Z"),
    },
  });
  assert.equal(result.wasMentioned, true);
  assert.equal(result.chatType, "group");
});

test("keeps attachment-only inbound messages visible to the agent", () => {
  const account = {
    accountId: "default",
    mentionNames: ["Ambrósio"],
  };
  const result = normalizePhotonInbound({
    account,
    space: { id: "chat-3", type: "dm", __platform: "iMessage" },
    message: {
      id: "msg-3",
      platform: "iMessage",
      direction: "inbound",
      sender: { id: "user" },
      content: { type: "attachment", name: "photo.jpg", id: "att-1" },
      timestamp: new Date("2026-06-11T19:20:00Z"),
    },
  });
  assert.equal(result.rawBody, "[Attachment: photo.jpg]");
});

test("classifies lightweight iMessage control events separately from messages", () => {
  assert.equal(isPhotonControlEventContent({ type: "reaction", emoji: "👍" }), false);
  assert.equal(isPhotonControlEventContent({ type: "unsend" }), false);
  assert.equal(isPhotonControlEventContent({ type: "poll_option", selected: true }), true);
  assert.equal(isPhotonControlEventContent({ type: "text", text: "hello" }), false);
  assert.equal(
    isPhotonControlEventContent({
      type: "group",
      items: [{ content: { type: "reaction", emoji: "👍" } }],
    }),
    false,
  );
});

test("normalizes reactions as agent-visible inbound messages", () => {
  const result = normalizePhotonInbound({
    account: {
      accountId: "default",
      mentionNames: ["Ambrósio"],
    },
    space: { id: "chat-4", type: "dm", __platform: "iMessage" },
    message: {
      id: "msg-4:reaction:1:0",
      platform: "iMessage",
      direction: "inbound",
      sender: { id: "user" },
      content: { type: "reaction", emoji: "❤️" },
      timestamp: new Date("2026-06-12T13:41:48Z"),
    },
  });

  assert.equal(result.rawBody, "[Reaction: ❤️]");
});

test("normalizes richer native iMessage content", () => {
  const account = {
    accountId: "default",
    mentionNames: ["Ambrósio"],
  };
  const base = {
    platform: "iMessage",
    direction: "inbound",
    sender: { id: "user" },
    timestamp: new Date("2026-06-12T13:41:48Z"),
  };
  const space = { id: "chat-rich", type: "direct", __platform: "iMessage" };

  assert.match(
    normalizePhotonInbound({
      account,
      space,
      message: {
        ...base,
        id: "msg-effect",
        content: {
          type: "effect",
          effectId: "com.apple.messages.effect.CKConfettiEffect",
          content: { type: "text", text: "celebrate" },
        },
      },
    }).rawBody,
    /\[Effect: com\.apple\.messages\.effect\.CKConfettiEffect\]\ncelebrate/,
  );

  assert.equal(
    normalizePhotonInbound({
      account,
      space,
      message: {
        ...base,
        id: "msg-mini",
        content: {
          type: "customized-mini-app",
          appName: "OpenClaw",
          url: "https://example.com/app",
          layout: { caption: "Launch", subcaption: "Open in Messages" },
        },
      },
    }).rawBody,
    "[Mini-app: OpenClaw]\nLaunch\nOpen in Messages\nhttps://example.com/app",
  );

  assert.equal(
    normalizePhotonInbound({
      account,
      space,
      message: {
        ...base,
        id: "msg-poll",
        content: { type: "poll", title: "Pick one", options: [{ title: "A" }, { title: "B" }] },
      },
    }).rawBody,
    "[Poll: Pick one]\n1. A\n2. B",
  );
});

test("cleans a leading group wake word while preserving ordinary text", () => {
  assert.equal(
    cleanLeadingMention("@Ambrosio, can you see this?", ["Ambrósio"]),
    "can you see this?",
  );
  assert.equal(
    cleanLeadingMention("please ask Ambrosio later", ["Ambrósio"]),
    "please ask Ambrosio later",
  );
});

test("marks direct slash messages as authorized text commands", () => {
  const result = buildDirectTextCommandMetadata({
    body: "/goal start Complete Photon",
    cfg: {},
    core: {
      channel: {
        commands: {
          shouldHandleTextCommands: ({ surface, commandSource }) =>
            surface === "photon" && commandSource === "text",
        },
      },
    },
  });

  assert.equal(result.CommandAuthorized, true);
  assert.equal(result.CommandSource, "text");
  assert.equal(result.CommandTurn.kind, "text-slash");
  assert.equal(result.CommandTurn.commandName, "goal");
  assert.equal(result.CommandTurn.body, "/goal start Complete Photon");
});

test("respects disabled text commands for direct slash messages", () => {
  const result = buildDirectTextCommandMetadata({
    body: "/status",
    cfg: {},
    core: {
      channel: {
        commands: {
          shouldHandleTextCommands: () => false,
        },
      },
    },
  });

  assert.deepEqual(result, {});
});
