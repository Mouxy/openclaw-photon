import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

process.env.OPENCLAW_HOME = mkdtempSync(path.join(tmpdir(), "photon-formatting-"));

import { buildPhotonContents, formatPhotonMessageBody, normalizeOutboundTarget, sendPhotonRich, sendPhotonText } from "../dist/src/spectrum.js";

test("builds markdown content for iMessage rich text", async () => {
  const [content] = buildPhotonContents("**hello** [site](https://example.com)");
  const built = await content.build();
  assert.equal(built.type, "markdown");
  assert.equal(built.markdown, "**hello** [site](https://example.com)");
});

test("formats markdown headings as compact iMessage text", () => {
  assert.equal(
    formatPhotonMessageBody("## Result\n\nDone."),
    "**Result**\n\nDone.",
  );
});

test("formats markdown tables as iMessage-friendly bullet rows", async () => {
  const [content] = buildPhotonContents(`
| Check | Status | Detail |
| --- | --- | --- |
| Photon | OK | iMessage works |
| Telegram | OK | connected |
`);
  const built = await content.build();
  assert.equal(built.type, "markdown");
  assert.equal(
    built.markdown,
    "- **Check:** Photon; **Status:** OK; **Detail:** iMessage works\n- **Check:** Telegram; **Status:** OK; **Detail:** connected",
  );
});

test("leaves fenced code blocks untouched while formatting surrounding text", () => {
  assert.equal(
    formatPhotonMessageBody("### Command\n\n```bash\n| not | a | table |\n```\n\n- [x] verified"),
    "**Command**\n\n```bash\n| not | a | table |\n```\n\n- Done: verified",
  );
});

test("builds attachment content for http media", async () => {
  const contents = buildPhotonContents("photo", ["https://example.com/image.png"]);
  assert.equal(contents.length, 2);
  const text = await contents[0].build();
  assert.equal(text.type, "markdown");
  const attachment = await contents[1].build();
  assert.equal(attachment.type, "attachment");
  assert.equal(attachment.name, "image.png");
});

test("builds rich links for standalone urls", async () => {
  const [content] = buildPhotonContents("https://example.com/article");
  const built = await content.build();
  assert.equal(built.type, "richlink");
  assert.equal(built.url, "https://example.com/article");
});

test("builds voice content for audio media", async () => {
  const contents = buildPhotonContents("", ["https://example.com/note.m4a"]);
  assert.equal(contents.length, 1);
  const built = await contents[0].build();
  assert.equal(built.type, "voice");
  assert.equal(built.name, "note.m4a");
});

test("groups multiple outbound media items", async () => {
  const contents = buildPhotonContents("", [
    "https://example.com/one.png",
    "https://example.com/two.png",
  ]);
  assert.equal(contents.length, 1);
  const built = await contents[0].build();
  assert.equal(built.type, "group");
  assert.equal(built.items.length, 2);
});

test("falls back to readable media references for unsupported media urls", async () => {
  const [content] = buildPhotonContents("see attached", ["media://inbound/file"]);
  const built = await content.build();
  assert.equal(built.type, "markdown");
  assert.match(built.markdown, /see attached/);
  assert.match(built.markdown, /media:\/\/inbound\/file/);
});

test("builds attachment content for file urls", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "photon-file-url-"));
  const image = path.join(dir, "photo.png");
  writeFileSync(image, Buffer.from("fake-image"));

  const contents = buildPhotonContents("", [pathToFileURL(image).toString()]);
  assert.equal(contents.length, 1);
  const built = await contents[0].build();
  assert.equal(built.type, "attachment");
  assert.equal(built.name, "photo.png");
});

test("rejects missing and oversized local media before send", () => {
  assert.throws(
    () => buildPhotonContents("", ["/tmp/photon-definitely-missing.png"]),
    /not readable/,
  );

  const dir = mkdtempSync(path.join(tmpdir(), "photon-oversize-"));
  const image = path.join(dir, "large.bin");
  writeFileSync(image, Buffer.alloc(8));
  assert.throws(
    () => buildPhotonContents("", [image], { maxOutboundAttachmentBytes: 4 }),
    /too large/,
  );
});

function mockRunningForOutbound() {
  const sent = [];
  const space = {
    id: "any;-;+15555550100",
    send: async (content) => {
      const message = {
        id: `sent-${sent.length + 1}`,
        platform: "iMessage",
        direction: "outbound",
        sender: { id: "agent" },
        content: typeof content?.build === "function" ? await content.build() : content,
        timestamp: new Date(),
      };
      sent.push(message);
      return message;
    },
  };
  return {
    running: {
      accountId: "default",
      app: {},
      spaces: new Map([
        ["any;-;+15555550100", space],
        ["+15555550100", space],
      ]),
      messages: new Map(),
      reactionMessages: new Map(),
      seenMessages: new Map(),
    },
    sent,
  };
}

test("returns delivery-shaped outbound text and media results", async () => {
  const { running, sent } = mockRunningForOutbound();

  const textResult = await sendPhotonText(running, "+15555550100", "hello");
  assert.equal(textResult.channel, "photon");
  assert.equal(textResult.channelId, "any;-;+15555550100");
  assert.equal(textResult.messageId, "sent-1");

  const mediaResult = await sendPhotonRich(running, "+15555550100", "photo", ["https://example.com/image.png"]);
  assert.equal(mediaResult.channel, "photon");
  assert.equal(mediaResult.channelId, "any;-;+15555550100");
  assert.equal(mediaResult.messageId, "sent-3");
  assert.deepEqual(mediaResult.meta.messageIds, ["sent-2", "sent-3"]);
  assert.equal(sent.length, 3);
});

test("normalizes bare direct targets to Spectrum chat ids", () => {
  assert.equal(normalizeOutboundTarget("+15555550100"), "any;-;+15555550100");
  assert.equal(normalizeOutboundTarget("user@example.com"), "any;-;user@example.com");
  assert.equal(normalizeOutboundTarget("any;-;+15555550100"), "any;-;+15555550100");
});
