import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { TextEffect, type Message as AdvancedIMessageMessage } from "@photon-ai/advanced-imessage";
import {
  advancedChatId,
  advancedSpacePhone,
  advancedTargetMessage,
  pollMessageGuid,
  withAdvancedIMessageClient,
} from "./advancedClient.js";
import {
  attachment,
  contact as contactContent,
  edit as editContent,
  markdown,
  poll,
  reaction as reactionContent,
  reply as replyContent,
  text as textContent,
  unsend as unsendContent,
  UnsupportedError,
  voice,
  type ContentInput,
  type Message,
  type Space,
} from "spectrum-ts";
import { background, customizedMiniApp, effect, read } from "spectrum-ts/providers/imessage";
import { resolveAccount } from "./config.js";
import { CHANNEL_ID, type ResolvedPhotonAccount, type RunningPhotonAccount } from "./types.js";
import {
  forgetPersistedReaction,
  getPhotonStatus,
  getLatestPersistedMessageForSpace,
  getPersistedMessage,
  getPersistedReaction,
  listPhotonDeliveries,
  listUnresolvedPhotonDeliveries,
  listPersistedSpaces,
  notePhotonActionError,
  notePhotonOutbound,
  notePhotonTransportError,
  rememberPersistedReaction,
} from "./state.js";
import {
  assertOutboundMediaWithinLimits,
  buildPhotonContents,
  normalizeOutboundTarget,
  rememberPhotonMessage,
  resolvePhotonSpace,
} from "./spectrum.js";

type ActionContext = {
  action: string;
  cfg: any;
  params: Record<string, unknown>;
  accountId?: string | null;
  senderIsOwner?: boolean;
  toolContext?: {
    currentChannelId?: string;
    currentMessageId?: string | number;
    currentChannelProvider?: string;
  };
};

type AgentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
};

type PhotonActionsOptions = {
  recreateRunning?: (account: ResolvedPhotonAccount, current: RunningPhotonAccount) => Promise<RunningPhotonAccount>;
};

const SAFE_ACTIONS = [
  "react",
  "read",
  "reply",
  "edit",
  "unsend",
  "sendWithEffect",
  "upload-file",
  "poll",
  "photonDoctor",
  "sendMiniApp",
  "sendStatusCard",
  "sendContact",
] as const;

const DANGEROUS_ACTIONS = ["renameGroup", "setGroupIcon", "setBackground"] as const;
const OWNER_GATED_ADVANCED_ACTIONS = [
  "addPollOption",
  "pollVote",
  "pollUnvote",
  "placeSticker",
  "requestLocation",
  "notifyAnyway",
] as const;
const SUPPORTED_ACTIONS = new Set<string>([
  ...SAFE_ACTIONS,
  ...DANGEROUS_ACTIONS,
  ...OWNER_GATED_ADVANCED_ACTIONS,
  "sendAttachment",
  "sendCustomizedMiniApp",
  "sendStatusCard",
  "contact",
  "shareContact",
  "shareContactInfo",
  "status-card",
  "mini-app",
  "pollAddOption",
  "votePoll",
  "unvotePoll",
  "sticker",
  "locationRequest",
  "delete",
  "thread-reply",
  "topic-edit",
  "status",
]);

const EFFECTS: Record<string, string> = {
  slam: "com.apple.MobileSMS.expressivesend.impact",
  impact: "com.apple.MobileSMS.expressivesend.impact",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
  invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
  "invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
  balloons: "com.apple.messages.effect.CKBalloonEffect",
  balloon: "com.apple.messages.effect.CKBalloonEffect",
  heart: "com.apple.messages.effect.CKHeartEffect",
  lasers: "com.apple.messages.effect.CKLasersEffect",
  celebration: "com.apple.messages.effect.CKHappyBirthdayEffect",
  birthday: "com.apple.messages.effect.CKHappyBirthdayEffect",
  sparkles: "com.apple.messages.effect.CKSparklesEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
  echo: "com.apple.messages.effect.CKEchoEffect",
};

const TEXT_EFFECTS: Record<string, string> = {
  big: TextEffect.big,
  small: TextEffect.small,
  shake: TextEffect.shake,
  nod: TextEffect.nod,
  explode: TextEffect.explode,
  ripple: TextEffect.ripple,
  bloom: TextEffect.bloom,
  jitter: TextEffect.jitter,
};

function jsonActionResult(data: Record<string, unknown>): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    details: data,
  };
}

function actionResult(action: string, data: Record<string, unknown> = {}, space?: Space): AgentToolResult {
  const spaceId = space?.id;
  return jsonActionResult({
    ok: true,
    channel: CHANNEL_ID,
    action,
    ...(spaceId ? { channelId: spaceId, spaceId } : {}),
    ...data,
  });
}

function isPhotonTransportError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return (
    message.includes("ECONNRESET") ||
    message.includes("UNAVAILABLE") ||
    message.includes("stream interrupted") ||
    message.includes("ConnectionError") ||
    message.includes("DEADLINE_EXCEEDED") ||
    message.includes("temporarily unavailable") ||
    message.includes("Connection dropped")
  );
}

function readString(params: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function readBoolean(params: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

function targetFromContext(ctx: ActionContext): string | undefined {
  return (
    readString(ctx.params, "to", "target", "channelId", "chatId", "chatGuid", "chatIdentifier") ??
    ctx.toolContext?.currentChannelId
  );
}

function explicitMessageId(ctx: ActionContext): string | undefined {
  const explicit = readString(ctx.params, "messageId", "message_id", "replyTo");
  if (explicit) return explicit;
  const current = ctx.toolContext?.currentMessageId;
  return current == null ? undefined : String(current);
}

function textParam(params: Record<string, unknown>): string | undefined {
  return readString(params, "message", "text", "newText", "content");
}

function readStringArray(params: Record<string, unknown>, ...keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) values.push(trimmed);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        const trimmed = String(item ?? "").trim();
        if (trimmed) values.push(trimmed);
      }
    }
  }
  return Array.from(new Set(values));
}

function readNumber(params: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeStatusPhase(raw: string | undefined): string {
  const value = raw?.trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (value) {
    case "done":
    case "complete":
    case "completed":
    case "success":
    case "ok":
      return "complete";
    case "problem":
    case "problemfound":
    case "failed":
    case "failure":
    case "warning":
    case "alert":
      return "failed";
    case "input":
    case "needsinput":
    case "decision":
    case "approval":
    default:
      return "needsInput";
  }
}

function statusCardDefaults(params: Record<string, unknown>): Record<string, unknown> {
  const phase = normalizeStatusPhase(readString(params, "phase", "status", "cardType", "card_type", "type"));
  const runId = readString(params, "runId", "run_id", "id") ?? randomUUID();
  const step = readString(params, "step", "detail") ?? (
    phase === "complete"
      ? "Finished"
      : phase === "failed"
        ? "Needs attention"
        : "Waiting for your decision"
  );
  const result = readString(params, "result", "outcome", "summary") ?? (
    phase === "complete"
      ? "Finished successfully"
      : phase === "failed"
        ? "OpenClaw found a problem that needs a manual check"
        : "Approve, retry, skip, or open details"
  );
  const imageTitle = phase === "complete" ? "Done" : phase === "failed" ? "Problem found" : "Needs input";
  const detail = phase === "complete" ? "Result" : phase === "failed" ? "Attention" : "Decision";

  return {
    runId,
    id: runId,
    phase,
    step,
    result,
    caption: phase === "complete" ? "OpenClaw done" : phase === "failed" ? "OpenClaw found a problem" : "OpenClaw needs input",
    subcaption: result,
    trailingCaption: detail,
    summary: `OpenClaw: ${imageTitle} - ${result}`,
    imageTitle,
    imageSubtitle: detail,
  };
}

function templateVariables(source: Record<string, unknown>): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value == null || typeof value === "object") continue;
    variables[key] = String(value);
  }
  return variables;
}

function interpolateTemplate(value: string | undefined, variables: Record<string, string>, encodeValues = false): string | undefined {
  if (!value) return undefined;
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const replacement = variables[key] ?? "";
    return encodeValues ? encodeURIComponent(replacement) : replacement;
  });
}

function reactionKey(spaceId: string, targetMessageId: string, emoji: string): string {
  return `${spaceId}\u0000${targetMessageId}\u0000${emoji.trim()}`;
}

function reactionKeyCandidates(spaceId: string, targetMessageId: string, emoji: string, persistedSpaceId?: string): string[] {
  return Array.from(new Set([
    reactionKey(spaceId, targetMessageId, emoji),
    persistedSpaceId ? reactionKey(persistedSpaceId, targetMessageId, emoji) : undefined,
  ].filter(Boolean) as string[]));
}

function defaultMessageDirectionForAction(action: string): "inbound" | "outbound" | "any" {
  if (["read", "reply", "react"].includes(action)) return "inbound";
  if (["edit", "unsend", "delete"].includes(action)) return "outbound";
  return "any";
}

function effectId(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) throw new Error("Photon sendWithEffect requires effect or effectId.");
  if (value.startsWith("com.apple.")) return value;
  const resolved = EFFECTS[value.toLowerCase()];
  if (!resolved) {
    throw new Error(
      "Photon sendWithEffect supports: slam, loud, gentle, invisible, confetti, fireworks, balloons, heart, lasers, celebration, sparkles, spotlight, echo.",
    );
  }
  return resolved;
}

function textEffectId(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const resolved = TEXT_EFFECTS[value.toLowerCase()];
  if (!resolved) {
    throw new Error("Photon textEffect supports: big, small, shake, nod, explode, ripple, bloom, jitter.");
  }
  return resolved;
}

function effectAckMode(account: ResolvedPhotonAccount, params: Record<string, unknown>): "confirmed" | "optimistic" {
  const explicit = readString(params, "effectAck", "effect_ack", "ack", "acknowledgement", "acknowledgment");
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (["optimistic", "fast", "async", "fire-and-forget", "fire_and_forget"].includes(normalized)) return "optimistic";
    if (["confirmed", "confirm", "sync"].includes(normalized)) return "confirmed";
    throw new Error("Photon sendWithEffect effectAck supports: confirmed, optimistic.");
  }
  if (readBoolean(params, "fast", "optimistic", "fireAndForget", "fire_and_forget") === true) return "optimistic";
  return account.effectAck;
}

function rememberOptimisticEffectSend(
  account: ResolvedPhotonAccount,
  running: RunningPhotonAccount,
  space: Space,
  pending: Promise<Message | undefined>,
): void {
  void pending.then((message) => {
    if (!message) return;
    rememberPhotonMessage(running, space, message);
    notePhotonOutbound(account.accountId, { id: message.id, spaceId: space.id });
  }).catch((error) => {
    notePhotonActionError(account.accountId, error);
  });
}

function textEffectRange(text: string, params: Record<string, unknown>): { start: number; length: number; phrase?: string } {
  const phrase = readString(params, "phrase", "textEffectPhrase", "text_effect_phrase", "highlight");
  if (phrase) {
    const start = text.indexOf(phrase);
    if (start < 0) throw new Error(`Photon textEffect phrase was not found in message: ${phrase}`);
    return { start, length: phrase.length, phrase };
  }

  const rawStart = readNumber(params, "start", "rangeStart", "range_start", "textEffectStart", "text_effect_start");
  const rawLength = readNumber(params, "length", "rangeLength", "range_length", "textEffectLength", "text_effect_length");
  const start = rawStart == null ? 0 : Math.trunc(rawStart);
  const length = rawLength == null ? text.length - start : Math.trunc(rawLength);
  if (start < 0 || length <= 0 || start + length > text.length) {
    throw new Error(`Photon textEffect range is outside the message bounds: start=${start}, length=${length}.`);
  }
  return { start, length };
}

function canUseAdvancedFallback(account: ResolvedPhotonAccount): boolean {
  return !account.local && Boolean(account.projectId && account.projectSecret);
}

// Spectrum's provider edit/unsend already call the advanced SDK's
// EditMessage/UnsendMessage RPCs. When the failure names that RPC, the
// upstream service itself failed and the advanced fallback would re-dial the
// identical endpoint — doubling the latency for the same error.
function isUpstreamMessageRpcError(error: unknown): boolean {
  return /MessageService\/(Edit|Unsend)Message/.test(String((error as any)?.message ?? error ?? ""));
}

// Spectrum's UnsupportedError is a deliberate capability refusal (e.g.
// "iMessage polls cannot be unsent"), not a delivery failure. The advanced
// fallback must never bypass it — live smoke showed it unsending an active
// poll that Spectrum had correctly refused to.
function isSpectrumCapabilityError(error: unknown): boolean {
  return error instanceof UnsupportedError || (error as any)?.name === "UnsupportedError";
}

function advancedMessageToSpectrumMessage(space: Space, message: AdvancedIMessageMessage, text: string): Message {
  return {
    id: message.guid,
    platform: "iMessage",
    direction: "outbound",
    sender: { id: "agent" },
    content: { type: "text", text },
    timestamp: message.dateCreated ?? new Date(),
    space,
  } as Message;
}

async function sendTextEffectMessage(params: {
  account: ResolvedPhotonAccount;
  running: RunningPhotonAccount;
  space: Space;
  text: string;
  textEffect: string;
  range: { start: number; length: number; phrase?: string };
}): Promise<Message> {
  const { account, running, space, text, textEffect, range } = params;
  const sent = await withAdvancedIMessageClient(account, space, (client) =>
    client.messages.sendText(advancedChatId(space), text, {
      formatting: [{
        type: "effect",
        start: range.start,
        length: range.length,
        effect: textEffect as any,
      }],
    }),
  );
  const message = advancedMessageToSpectrumMessage(space, sent, text);
  rememberPhotonMessage(running, space, message);
  return message;
}

function assertNativeActions(account: ResolvedPhotonAccount): void {
  if (!account.nativeActions) throw new Error("Photon native iMessage actions are disabled for this account.");
  if (account.provider !== "imessage") throw new Error("Photon native actions require the iMessage provider.");
}

function assertDangerousAllowed(ctx: ActionContext, account: ResolvedPhotonAccount): void {
  if (!DANGEROUS_ACTIONS.includes(ctx.action as any) && !OWNER_GATED_ADVANCED_ACTIONS.includes(ctx.action as any)) return;
  if (account.dangerousNativeActions || ctx.senderIsOwner === true) return;
  throw new Error(`Photon ${ctx.action} is restricted to the owner unless dangerousNativeActions=true.`);
}

function assertRemoteForRichNative(account: ResolvedPhotonAccount, action: string): void {
  // Spectrum's local iMessage mode rejects every message-targeted action,
  // including edit and unsend (UnsupportedError.action(..., "iMessage (local mode)")).
  if (!account.local) return;
  throw new Error(`Photon ${action} requires remote/cloud iMessage mode.`);
}

function assertMiniAppAllowed(ctx: ActionContext, account: ResolvedPhotonAccount, space: Space): void {
  if ((space as any).type !== "group") return;
  if (account.dangerousNativeActions || ctx.senderIsOwner === true) return;
  throw new Error("Photon sendMiniApp to a group is restricted to the owner unless dangerousNativeActions=true.");
}

async function requireRunning(
  runningAccounts: Map<string, RunningPhotonAccount>,
  account: ResolvedPhotonAccount,
): Promise<RunningPhotonAccount> {
  const running = runningAccounts.get(account.accountId);
  if (!running) throw new Error(`Photon account ${account.accountId} is not running`);
  return running;
}

async function resolveActionSpace(params: {
  ctx: ActionContext;
  account: ResolvedPhotonAccount;
  running: RunningPhotonAccount;
  messageId?: string;
}): Promise<Space> {
  const { ctx, account, running, messageId } = params;
  const rawTarget = targetFromContext(ctx);
  const persisted = messageId ? getPersistedMessage(account.accountId, messageId) : undefined;
  const target = normalizeOutboundTarget(rawTarget ?? persisted?.spaceId ?? "");
  if (!target) throw new Error(`Photon ${ctx.action} requires a target or a known messageId.`);
  const space = await resolvePhotonSpace(running, target);
  if (!space?.send) throw new Error(`Photon could not resolve space ${target}.`);
  return space;
}

async function resolveActionMessage(params: {
  ctx: ActionContext;
  account: ResolvedPhotonAccount;
  running: RunningPhotonAccount;
  requireMessage?: boolean;
}): Promise<{ space: Space; message: Message; messageId: string; persistedSpaceId?: string }> {
  const { ctx, account, running } = params;
  const direction = defaultMessageDirectionForAction(ctx.action);
  let messageId = readString(ctx.params, "messageId", "message_id", "replyTo");
  if (!messageId && direction !== "outbound") {
    // The tool context's current message is the inbound message that triggered
    // this turn — a valid default for read/reply/react, never for edit/unsend.
    messageId = explicitMessageId(ctx);
  }
  let space: Space | undefined;

  if (!messageId) {
    const target = normalizeOutboundTarget(targetFromContext(ctx) ?? "");
    if (target) {
      space = await resolvePhotonSpace(running, target);
      const latest = getLatestPersistedMessageForSpace(
        account.accountId,
        space?.id ?? target,
        direction,
      );
      messageId = latest?.id;
    }
  }

  if (!messageId) {
    throw new Error(
      direction === "outbound"
        ? `Photon ${ctx.action} requires the messageId of a message the agent sent.`
        : `Photon ${ctx.action} requires messageId or a current inbound message.`,
    );
  }
  const persisted = getPersistedMessage(account.accountId, messageId);

  let message = running.messages.get(messageId);
  if (message?.space) {
    space = message.space;
  }

  if (!space) {
    space = await resolveActionSpace({ ctx, account, running, messageId });
  }

  if (!message && typeof (space as any).getMessage === "function") {
    message = await (space as any).getMessage(messageId);
    if (message && space) rememberPhotonMessage(running, space, message);
  }

  if (!message) throw new Error(`Photon could not resolve message ${messageId}.`);
  if (direction === "outbound" && message.direction && message.direction !== "outbound") {
    throw new Error(
      `Photon ${ctx.action} can only target a message the agent sent; ${messageId} is an inbound message.`,
    );
  }
  if ((message as any).space?.id) {
    space = (message as any).space;
  }
  if (!space) throw new Error(`Photon could not resolve space for message ${messageId}.`);
  return { space, message, messageId, persistedSpaceId: persisted?.spaceId };
}

function firstContent(contents: ContentInput[]): ContentInput {
  const first = contents[0];
  if (!first) throw new Error("Photon action requires message text or media.");
  return first;
}

function mediaParam(params: Record<string, unknown>): string | undefined {
  return readString(params, "media", "mediaUrl", "filePath", "path", "fileUrl", "image", "background");
}

function mediaParams(params: Record<string, unknown>): string[] {
  return readStringArray(params, "media", "mediaUrl", "mediaUrls", "filePath", "path", "fileUrl", "image");
}

function bufferFromBase64(params: Record<string, unknown>): Buffer | undefined {
  const raw = readString(params, "buffer");
  return raw ? Buffer.from(raw, "base64") : undefined;
}

function clientMessageId(ctx: ActionContext, suffix: string): string {
  const explicit = readString(ctx.params, "clientMessageId", "client_message_id", "idempotencyKey", "idempotency_key");
  return explicit ?? `${ctx.action}:${suffix}:${randomUUID()}`;
}

function contactInput(params: Record<string, unknown>): Record<string, unknown> | string {
  const raw = readString(params, "vcard", "vCard", "raw");
  if (raw) return raw;
  const formatted = readString(params, "name", "formattedName", "formatted_name", "fullName", "full_name");
  const first = readString(params, "firstName", "first_name", "givenName", "given_name");
  const last = readString(params, "lastName", "last_name", "familyName", "family_name");
  const phoneValues = readStringArray(params, "phone", "phones", "phoneNumber", "phone_number");
  const emailValues = readStringArray(params, "email", "emails", "emailAddress", "email_address");
  const urlValues = readStringArray(params, "url", "urls", "website", "websites");
  const organisation = readString(params, "org", "organization", "organisation", "company");
  const title = readString(params, "title", "role", "jobTitle", "job_title");
  const note = readString(params, "note", "notes");

  if (!formatted && !first && !last && phoneValues.length === 0 && emailValues.length === 0) {
    throw new Error("Photon sendContact requires a vCard, name, phone, or email.");
  }

  return {
    ...(formatted || first || last ? { name: { formatted, first, last } } : {}),
    ...(phoneValues.length ? { phones: phoneValues.map((value) => ({ value })) } : {}),
    ...(emailValues.length ? { emails: emailValues.map((value) => ({ value })) } : {}),
    ...(urlValues.length ? { urls: urlValues.map((value) => ({ value })) } : {}),
    ...(organisation || title ? { org: { name: organisation, title } } : {}),
    ...(note ? { note } : {}),
  };
}

async function stickerBytes(params: Record<string, unknown>, account: ResolvedPhotonAccount): Promise<{ data: Uint8Array; fileName: string }> {
  const buffer = bufferFromBase64(params);
  if (buffer) {
    assertOutboundMediaWithinLimits(buffer, account.maxOutboundAttachmentBytes);
    return {
      data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      fileName: readString(params, "filename", "fileName", "name") ?? "sticker.png",
    };
  }

  const media = mediaParam(params);
  if (!media) throw new Error("Photon placeSticker requires buffer or image/media/filePath/path.");
  if (/^https?:\/\//i.test(media)) throw new Error("Photon placeSticker requires a local sticker image or base64 buffer.");
  const guarded = assertOutboundMediaWithinLimits(media, account.maxOutboundAttachmentBytes) as string;
  const bytes = await readFile(guarded);
  return {
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    fileName: readString(params, "filename", "fileName", "name") ?? basename(guarded),
  };
}

async function miniAppImageBytes(params: Record<string, unknown>, account: ResolvedPhotonAccount): Promise<Uint8Array | undefined> {
  const buffer = readString(params, "imageBuffer", "image_buffer")
    ? Buffer.from(readString(params, "imageBuffer", "image_buffer")!, "base64")
    : undefined;
  if (buffer) {
    assertOutboundMediaWithinLimits(buffer, account.maxOutboundAttachmentBytes);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  const imagePath = readString(params, "image", "imagePath", "filePath", "path");
  if (!imagePath) return undefined;
  if (/^https?:\/\//i.test(imagePath)) {
    throw new Error("Photon sendMiniApp image must be a local path or base64 imageBuffer; remote image URLs are not supported by Spectrum mini-app cards.");
  }
  const guarded = assertOutboundMediaWithinLimits(imagePath, account.maxOutboundAttachmentBytes);
  const bytes = await readFile(guarded as string);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function miniAppInput(params: Record<string, unknown>, account: ResolvedPhotonAccount, options: { statusCard?: boolean } = {}) {
  const defaults = account.miniAppDefaults ?? {};
  const cardDefaults = options.statusCard ? statusCardDefaults(params) : {};
  const layoutParam = params.layout && typeof params.layout === "object" && !Array.isArray(params.layout)
    ? (params.layout as Record<string, unknown>)
    : {};
  const baseSource = { ...defaults, ...params, ...cardDefaults };
  const layoutSource = { ...baseSource, ...layoutParam };
  const variables = templateVariables(layoutSource);
  const image = await miniAppImageBytes(layoutSource, account);
  const imageTitle = interpolateTemplate(readString(layoutSource, "imageTitle", "image_title"), variables);
  const imageSubtitle = interpolateTemplate(readString(layoutSource, "imageSubtitle", "image_subtitle"), variables);
  const layout = {
    ...(readString(layoutSource, "caption", "title") ? { caption: interpolateTemplate(readString(layoutSource, "caption", "title"), variables) } : {}),
    ...(readString(layoutSource, "subcaption", "subtitle") ? { subcaption: interpolateTemplate(readString(layoutSource, "subcaption", "subtitle"), variables) } : {}),
    ...(readString(layoutSource, "trailingCaption", "trailing_caption") ? { trailingCaption: interpolateTemplate(readString(layoutSource, "trailingCaption", "trailing_caption"), variables) } : {}),
    ...(readString(layoutSource, "trailingSubcaption", "trailing_subcaption") ? { trailingSubcaption: interpolateTemplate(readString(layoutSource, "trailingSubcaption", "trailing_subcaption"), variables) } : {}),
    ...(readString(layoutSource, "summary", "fallback") ? { summary: interpolateTemplate(readString(layoutSource, "summary", "fallback"), variables) } : {}),
    ...(image ? { image } : {}),
    ...(image && imageTitle ? { imageTitle } : {}),
    ...(image && imageSubtitle ? { imageSubtitle } : {}),
  };

  return {
    appName: interpolateTemplate(readString(baseSource, "appName", "app_name"), variables),
    appStoreId: readNumber(baseSource, "appStoreId", "app_store_id"),
    extensionBundleId: interpolateTemplate(readString(baseSource, "extensionBundleId", "extension_bundle_id", "bundleId", "bundle_id"), variables),
    teamId: interpolateTemplate(readString(baseSource, "teamId", "team_id"), variables),
    url: interpolateTemplate(readString(baseSource, "url", "appUrl", "app_url"), variables, true),
    layout,
  };
}

async function sendContent(space: Space, running: RunningPhotonAccount, content: ContentInput): Promise<Message | undefined> {
  const result = await space.send(content);
  const first = Array.isArray(result) ? result[0] : result;
  if (first) rememberPhotonMessage(running, space, first);
  return first;
}

async function sendContents(
  space: Space,
  running: RunningPhotonAccount,
  contents: ContentInput[],
): Promise<Message[]> {
  const sent: Message[] = [];
  for (const content of contents) {
    const message = await sendContent(space, running, content);
    if (message) sent.push(message);
  }
  return sent;
}

function buildAccountContents(
  account: ResolvedPhotonAccount,
  text = "",
  mediaUrls: string[] = [],
): ContentInput[] {
  return buildPhotonContents(text.slice(0, account.textChunkLimit), mediaUrls, {
    maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes,
  });
}

function hasUnresolvedDoctorTransportError(status: ReturnType<typeof getPhotonStatus>): boolean {
  const errorAt = status.lastTransportErrorAt ?? 0;
  if (!errorAt || !status.lastTransportError) return false;
  const recoveredAt = Math.max(status.lastTransportRecoveryAt ?? 0, status.lastOutboundAt ?? 0);
  return errorAt > recoveredAt;
}

function hasUnresolvedDoctorStreamReconnect(status: ReturnType<typeof getPhotonStatus>): boolean {
  const reconnectAt = status.lastStreamReconnectAt ?? 0;
  if (!reconnectAt) return false;
  const recoveredAt = Math.max(status.lastTransportRecoveryAt ?? 0, status.lastInboundAt ?? 0, status.lastOutboundAt ?? 0);
  return reconnectAt > recoveredAt;
}

function doctorResult(account: ResolvedPhotonAccount, running: RunningPhotonAccount | undefined): AgentToolResult {
  const persisted = getPhotonStatus(account.accountId);
  const runtimeStatus = running?.status ?? {};
  const status = { ...runtimeStatus, ...persisted };
  const spaces = listPersistedSpaces(account.accountId);
  const recentDeliveries = listPhotonDeliveries(account.accountId, 10);
  const unresolvedDeliveries = listUnresolvedPhotonDeliveries(account.accountId, 30_000, 10);
  const unresolvedTransportError = hasUnresolvedDoctorTransportError(status);
  const unresolvedStreamReconnect = hasUnresolvedDoctorStreamReconnect(status);
  const ok = Boolean(running) && !unresolvedTransportError && !unresolvedStreamReconnect && unresolvedDeliveries.length === 0;
  return jsonActionResult({
    ok,
    channel: CHANNEL_ID,
    action: "photonDoctor",
    accountId: account.accountId,
    provider: account.provider,
    local: account.local,
    dmPolicy: account.dmPolicy,
    groupPolicy: account.groupPolicy,
    requireMention: account.requireMention,
    typingIndicators: account.typingIndicators,
    progressUpdates: account.progressUpdates,
    nativeActions: account.nativeActions,
    dangerousNativeActions: account.dangerousNativeActions,
    effectsDefault: false,
    customMiniAppsExposed: true,
    health: {
      unresolvedTransportError,
      unresolvedStreamReconnect,
      unresolvedDeliveries: unresolvedDeliveries.length,
    },
    state: {
      ...status,
      running: Boolean(running),
      cachedSpaces: running?.spaces.size ?? spaces.length,
      cachedMessages: running?.messages.size ?? undefined,
      cachedReactionHandles: running?.reactionMessages.size ?? undefined,
      persistedSpaces: spaces.length,
    },
    recentDeliveries,
    unresolvedDeliveries,
  });
}

export function createPhotonMessageActions(
  runningAccounts: Map<string, RunningPhotonAccount>,
  options: PhotonActionsOptions = {},
) {
  return {
    describeMessageTool: ({ cfg, accountId, senderIsOwner }: any) => {
      const account = resolveAccount(cfg, accountId);
      if (!account.enabled || !account.nativeActions || account.provider !== "imessage") return null;
      const actions = account.local ? ["photonDoctor"] : [...SAFE_ACTIONS];
      if (!account.local && (account.dangerousNativeActions || senderIsOwner === true)) {
        actions.push(...DANGEROUS_ACTIONS);
        actions.push(...OWNER_GATED_ADVANCED_ACTIONS);
      }
      return {
        actions,
        mediaSourceParams: {
          "upload-file": ["media", "mediaUrl", "filePath", "path", "fileUrl"],
          sendWithEffect: ["media", "mediaUrl", "filePath", "path", "fileUrl"],
          sendMiniApp: ["image", "imagePath", "filePath", "path"],
          sendStatusCard: ["image", "imagePath", "filePath", "path"],
          placeSticker: ["image", "imagePath", "filePath", "path", "buffer"],
          setGroupIcon: ["image", "media", "mediaUrl", "filePath", "path", "fileUrl"],
          setBackground: ["background", "image", "media", "mediaUrl", "filePath", "path", "fileUrl"],
          "topic-edit": ["image", "media", "mediaUrl", "filePath", "path", "fileUrl"],
        },
      };
    },
    supportsAction: ({ action }: { action: string }) => SUPPORTED_ACTIONS.has(action),
    resolveExecutionMode: ({ action }: { action: string }) =>
      SUPPORTED_ACTIONS.has(action) ? "gateway" : "local",
    messageActionTargetAliases: {
      react: { aliases: ["target", "messageId"] },
      photonDoctor: { aliases: ["target"] },
      status: { aliases: ["target"] },
      read: { aliases: ["target", "messageId"] },
      edit: { aliases: ["target", "messageId"] },
      unsend: { aliases: ["target", "messageId"] },
      delete: { aliases: ["target", "messageId"] },
      reply: { aliases: ["target", "messageId"] },
      "thread-reply": { aliases: ["target", "messageId", "replyTo"] },
      sendWithEffect: { aliases: ["target"] },
      sendContact: { aliases: ["target"] },
      contact: { aliases: ["target"] },
      shareContact: { aliases: ["target"] },
      shareContactInfo: { aliases: ["target"] },
      sendMiniApp: { aliases: ["target"] },
      sendStatusCard: { aliases: ["target"] },
      sendCustomizedMiniApp: { aliases: ["target"] },
      "status-card": { aliases: ["target"] },
      "mini-app": { aliases: ["target"] },
      addPollOption: { aliases: ["target", "messageId"] },
      pollAddOption: { aliases: ["target", "messageId"] },
      pollVote: { aliases: ["target", "messageId"] },
      votePoll: { aliases: ["target", "messageId"] },
      pollUnvote: { aliases: ["target", "messageId"] },
      unvotePoll: { aliases: ["target", "messageId"] },
      placeSticker: { aliases: ["target", "messageId"] },
      sticker: { aliases: ["target", "messageId"] },
      requestLocation: { aliases: ["target"] },
      locationRequest: { aliases: ["target"] },
      notifyAnyway: { aliases: ["target", "messageId"] },
      renameGroup: { aliases: ["target"] },
      setGroupIcon: { aliases: ["target"] },
      setBackground: { aliases: ["target"] },
      "topic-edit": { aliases: ["target"] },
      "upload-file": { aliases: ["target"] },
      poll: { aliases: ["target"] },
    },
    handleAction: async (ctx: ActionContext): Promise<AgentToolResult> => {
      const action =
        ctx.action === "sendAttachment"
          ? "upload-file"
          : ctx.action === "sendCustomizedMiniApp" || ctx.action === "mini-app"
            ? "sendMiniApp"
          : ctx.action === "status-card"
            ? "sendStatusCard"
          : ctx.action === "contact" || ctx.action === "shareContact" || ctx.action === "shareContactInfo"
            ? "sendContact"
          : ctx.action === "pollAddOption"
            ? "addPollOption"
          : ctx.action === "votePoll"
            ? "pollVote"
          : ctx.action === "unvotePoll"
            ? "pollUnvote"
          : ctx.action === "sticker"
            ? "placeSticker"
          : ctx.action === "locationRequest"
            ? "requestLocation"
          : ctx.action === "delete"
            ? "unsend"
            : ctx.action === "thread-reply"
              ? "reply"
            : ctx.action === "topic-edit"
              ? readString(ctx.params, "kind")?.toLowerCase() === "background" || readString(ctx.params, "background")
                ? "setBackground"
                : mediaParam(ctx.params) || bufferFromBase64(ctx.params)
                  ? "setGroupIcon"
                  : "renameGroup"
              : ctx.action;
      const account = resolveAccount(ctx.cfg, ctx.accountId);
      if (action === "photonDoctor" || action === "status") {
        return doctorResult(account, runningAccounts.get(account.accountId));
      }
      assertNativeActions(account);
      assertDangerousAllowed({ ...ctx, action }, account);
      assertRemoteForRichNative(account, action);
      let running = await requireRunning(runningAccounts, account);

      try {
      if (action === "react") {
        const emoji = readString(ctx.params, "emoji") ?? "👍";
        const remove = readBoolean(ctx.params, "remove") === true;
        const { space, message, messageId, persistedSpaceId } = await resolveActionMessage({ ctx, account, running });
        const keys = reactionKeyCandidates(space.id, messageId, emoji, persistedSpaceId);
        const key = keys[0]!;
        if (remove) {
          const reaction = keys
            .map((candidate) => ({
              key: candidate,
              reactionMessageId: running.reactionMessages.get(candidate) ?? getPersistedReaction(account.accountId, candidate)?.reactionMessageId,
            }))
            .find((candidate) => candidate.reactionMessageId);
          if (!reaction?.reactionMessageId) throw new Error("Photon has no stored reaction handle to remove.");
          const reactionMessageId = reaction.reactionMessageId;
          const reactionMessage = running.messages.get(reactionMessageId) ?? (await (space as any).getMessage?.(reactionMessageId));
          if (!reactionMessage) throw new Error(`Photon could not resolve reaction message ${reactionMessageId}.`);
          await space.send(unsendContent(reactionMessage));
          for (const candidate of keys) {
            running.reactionMessages.delete(candidate);
            forgetPersistedReaction(account.accountId, candidate);
          }
          return actionResult(action, { removed: true, messageId }, space);
        }
        const reactionMessage = await space.send(reactionContent(emoji, message));
        if (reactionMessage) {
          rememberPhotonMessage(running, space, reactionMessage);
          running.reactionMessages.set(key, reactionMessage.id);
          rememberPersistedReaction(account.accountId, {
            key,
            spaceId: space.id,
            targetMessageId: messageId,
            emoji,
            reactionMessageId: reactionMessage.id,
            updatedAt: Date.now(),
          });
        }
        return actionResult(action, { emoji, messageId }, space);
      }

      if (action === "read") {
        const { space, message, messageId } = await resolveActionMessage({ ctx, account, running });
        await space.send(read(message));
        return actionResult(action, {
          messageId,
          scope: "chat",
          visibility: "best_effort_until_next_chat_activity",
        }, space);
      }

      if (action === "edit") {
        const { space, message, messageId } = await resolveActionMessage({ ctx, account, running });
        const text = textParam(ctx.params);
        if (!text) throw new Error("Photon edit requires message/text/newText/content.");
        const editText = text.slice(0, account.textChunkLimit);
        try {
          // Spectrum's iMessage provider only accepts plain text inside edit();
          // markdown or richlink content throws UnsupportedError at send time.
          await space.send(editContent(textContent(editText), message));
        } catch (error) {
          // The Spectrum edit path has returned upstream errors in live
          // canaries where the direct advanced edit succeeds (see the Hermes
          // sidecar's identical fallback), so retry through the advanced SDK.
          if (
            !canUseAdvancedFallback(account) ||
            isUpstreamMessageRpcError(error) ||
            isSpectrumCapabilityError(error)
          ) {
            throw error;
          }
          const target = advancedTargetMessage(messageId);
          await withAdvancedIMessageClient(account, space, (client) =>
            client.messages.edit(advancedChatId(space), target.messageGuid, editText, {
              ...(target.partIndex != null ? { partIndex: target.partIndex } : {}),
              backwardCompatText: editText,
              clientMessageId: clientMessageId(ctx, messageId),
            }),
          );
          return actionResult(action, { edited: messageId, messageId, method: "advanced" }, space);
        }
        return actionResult(action, { edited: messageId, messageId }, space);
      }

      if (action === "unsend") {
        const { space, messageId, message } = await resolveActionMessage({ ctx, account, running });
        try {
          await space.send(unsendContent(message));
        } catch (error) {
          if (
            !canUseAdvancedFallback(account) ||
            (message as any)?.content?.type === "reaction" ||
            isUpstreamMessageRpcError(error) ||
            isSpectrumCapabilityError(error)
          ) {
            throw error;
          }
          const target = advancedTargetMessage(messageId);
          await withAdvancedIMessageClient(account, space, (client) =>
            client.messages.unsend(advancedChatId(space), target.messageGuid, {
              ...(target.partIndex != null ? { partIndex: target.partIndex } : {}),
              clientMessageId: clientMessageId(ctx, messageId),
            }),
          );
          return actionResult(action, { unsent: messageId, messageId, method: "advanced" }, space);
        }
        return actionResult(action, { unsent: messageId, messageId }, space);
      }

      if (action === "reply") {
        const { space, message, messageId } = await resolveActionMessage({ ctx, account, running });
        const text = textParam(ctx.params);
        const contents = buildAccountContents(account, text ?? "", mediaParams(ctx.params));
        const [first, ...rest] = contents;
        const result = await space.send(replyContent(firstContent([first!]), message));
        const replyMessages = Array.isArray(result) ? result : result ? [result] : [];
        for (const sent of replyMessages) {
          rememberPhotonMessage(running, space, sent);
        }
        const restMessages = await sendContents(space, running, rest);
        const messageIds = [...replyMessages, ...restMessages].map((sent) => sent.id);
        return actionResult(action, {
          messageId: messageIds.at(-1),
          messageIds,
          repliedTo: messageId,
        }, space);
      }

      if (action === "sendWithEffect") {
        const text = textParam(ctx.params);
        if (!text) throw new Error("Photon sendWithEffect requires message/text/content.");
        const space = await resolveActionSpace({ ctx, account, running });
        const ack = effectAckMode(account, ctx.params);
        const textEffect = textEffectId(readString(ctx.params, "textEffect", "text_effect", "animation", "textAnimation", "text_animation"));
        if (textEffect) {
          const effectText = text.slice(0, account.textChunkLimit);
          const range = textEffectRange(effectText, ctx.params);
          if (ack === "optimistic") {
            rememberOptimisticEffectSend(account, running, space, sendTextEffectMessage({ account, running, space, text: effectText, textEffect, range }));
            return actionResult(action, {
              accepted: true,
              effectAck: ack,
              textEffect,
              range,
            }, space);
          }
          const sent = await sendTextEffectMessage({ account, running, space, text: effectText, textEffect, range });
          return actionResult(action, {
            messageId: sent.id,
            messageIds: [sent.id],
            effectAck: ack,
            textEffect,
            range,
            textEffectMessageId: sent.id,
          }, space);
        }
        const effectContent = effect(markdown(text.slice(0, account.textChunkLimit)), effectId(readString(ctx.params, "effectId", "effect")) as any);
        if (ack === "optimistic") {
          rememberOptimisticEffectSend(account, running, space, sendContent(space, running, effectContent));
          return actionResult(action, {
            accepted: true,
            effectAck: ack,
          }, space);
        }
        const sent = await sendContent(space, running, effectContent);
        const extraMedia = mediaParams(ctx.params);
        const mediaMessages = extraMedia.length
          ? await sendContents(space, running, buildAccountContents(account, "", extraMedia))
          : [];
        const messageIds = [sent, ...mediaMessages].filter(Boolean).map((message) => message!.id);
        return actionResult(action, {
          messageId: messageIds.at(-1),
          messageIds,
          effectAck: ack,
          effectMessageId: sent?.id,
        }, space);
      }

      if (action === "poll") {
        const question = readString(ctx.params, "pollQuestion", "question", "message", "text", "title");
        const options = readStringArray(ctx.params, "pollOption", "pollOptions", "options");
        if (!question) throw new Error("Photon poll requires pollQuestion/question/message/title.");
        if (options.length < 2) throw new Error("Photon poll requires at least two pollOption values.");
        const space = await resolveActionSpace({ ctx, account, running });
        const sent = await sendContent(space, running, poll(question, ...options));
        return actionResult(action, {
          messageId: sent?.id,
          question,
          optionCount: options.length,
        }, space);
      }

      if (action === "sendContact") {
        const space = await resolveActionSpace({ ctx, account, running });
        const sent = await sendContent(space, running, contactContent(contactInput(ctx.params) as any));
        return actionResult(action, { messageId: sent?.id }, space);
      }

      if (action === "addPollOption" || action === "pollVote" || action === "pollUnvote") {
        const pollMessageId = readString(ctx.params, "pollMessageId", "poll_message_id", "pollId", "poll_id") ?? explicitMessageId(ctx);
        if (!pollMessageId) throw new Error(`Photon ${action} requires pollMessageId/messageId.`);
        const space = await resolveActionSpace({ ctx, account, running, messageId: pollMessageId });
        // Inbound poll vote/change events carry synthetic "<guid>:…" ids;
        // the advanced poll mutation APIs want the bare poll message guid.
        const pollGuid = pollMessageGuid(pollMessageId);
        let pollState;
        try {
          pollState = await withAdvancedIMessageClient(account, space, (client) => {
            if (action === "addPollOption") {
              const text = readString(ctx.params, "option", "text", "title");
              if (!text) throw new Error("Photon addPollOption requires option/text/title.");
              return client.polls.addOption(pollGuid, text, { clientMessageId: clientMessageId(ctx, pollGuid) });
            }
            if (action === "pollVote") {
              const optionId = readString(ctx.params, "optionId", "option_id", "choiceId", "choice_id");
              if (!optionId) throw new Error("Photon pollVote requires optionId/choiceId.");
              return client.polls.vote(pollGuid, optionId, { clientMessageId: clientMessageId(ctx, pollGuid) });
            }
            return client.polls.unvote(pollGuid, { clientMessageId: clientMessageId(ctx, pollGuid) });
          });
        } catch (error) {
          // Photon's shared-line gateway routes PollService mutations by
          // pollMessageGuid lookup and currently fails to route even the guid
          // its own CreatePoll returned. Give the agent the upstream category
          // instead of the opaque routing error.
          if (/No instance routed/i.test(String((error as any)?.message ?? error))) {
            throw new Error(
              `Photon could not route ${action} to an iMessage instance (PollService lookup by pollMessageGuid ` +
                `failed upstream). Poll creation and inbound votes are unaffected; report pollMessageId ${pollGuid} to Photon.`,
            );
          }
          throw error;
        }
        return actionResult(action, {
          pollMessageId: pollState.pollMessageGuid,
          optionCount: pollState.options.length,
          voteCount: pollState.votes.length,
        }, space);
      }

      if (action === "placeSticker") {
        const { space, messageId } = await resolveActionMessage({ ctx, account, running });
        const sticker = await stickerBytes(ctx.params, account);
        const placement = {
          x: readNumber(ctx.params, "x") ?? 120,
          y: readNumber(ctx.params, "y") ?? 90,
          ...(readNumber(ctx.params, "width") != null ? { width: readNumber(ctx.params, "width") } : {}),
          ...(readNumber(ctx.params, "scale") != null ? { scale: readNumber(ctx.params, "scale") } : {}),
          ...(readNumber(ctx.params, "rotation") != null ? { rotation: readNumber(ctx.params, "rotation") } : {}),
        };
        const sent = await withAdvancedIMessageClient(account, space, async (client) => {
          const uploaded = await client.attachments.upload(sticker);
          return client.messages.placeSticker(
            advancedChatId(space),
            messageId,
            uploaded.attachment.guid,
            placement,
            { clientMessageId: clientMessageId(ctx, messageId) },
          );
        });
        const message = advancedMessageToSpectrumMessage(space, sent, "[Sticker placed]");
        rememberPhotonMessage(running, space, message);
        return actionResult(action, { messageId: message.id, sticker: sticker.fileName, targetMessageId: messageId }, space);
      }

      if (action === "requestLocation") {
        const space = await resolveActionSpace({ ctx, account, running });
        const address = readString(ctx.params, "address", "phone", "email", "contact");
        if (!address) throw new Error("Photon requestLocation requires address/phone/email/contact.");
        const receipt = await withAdvancedIMessageClient(account, space, (client) =>
          client.locations.request(advancedChatId(space), address, { clientMessageId: clientMessageId(ctx, address) }),
        );
        return actionResult(action, { address: receipt.address, status: receipt.status, messageId: receipt.messageGuid }, space);
      }

      if (action === "notifyAnyway") {
        const { space, messageId } = await resolveActionMessage({ ctx, account, running });
        await withAdvancedIMessageClient(account, space, (client) =>
          client.messages.notifySilenced(advancedChatId(space), messageId, { clientMessageId: clientMessageId(ctx, messageId) }),
        );
        return actionResult(action, { messageId }, space);
      }

      if (action === "sendMiniApp" || action === "sendStatusCard") {
        const space = await resolveActionSpace({ ctx, account, running });
        assertMiniAppAllowed(ctx, account, space);
        const input = await miniAppInput(ctx.params, account, { statusCard: action === "sendStatusCard" });
        if (!input.appName) throw new Error("Photon sendMiniApp requires appName.");
        if (!input.extensionBundleId) throw new Error("Photon sendMiniApp requires extensionBundleId/bundleId.");
        if (!input.teamId) throw new Error("Photon sendMiniApp requires teamId.");
        if (!input.url) throw new Error("Photon sendMiniApp requires url/appUrl.");
        const sent = await sendContent(space, running, customizedMiniApp(input as Parameters<typeof customizedMiniApp>[0]));
        return actionResult(action, {
          messageId: sent?.id,
          appName: input.appName,
          extensionBundleId: input.extensionBundleId,
        }, space);
      }

      if (action === "renameGroup") {
        const name = readString(ctx.params, "name", "displayName", "threadName", "topic");
        if (!name) throw new Error("Photon renameGroup requires name/displayName/topic.");
        const space = await resolveActionSpace({ ctx, account, running });
        await space.rename(name);
        return actionResult(action, { renamed: space.id, name }, space);
      }

      if (action === "setBackground") {
        const space = await resolveActionSpace({ ctx, account, running });
        const clear = readBoolean(ctx.params, "clear", "remove") === true;
        const buffer = bufferFromBase64(ctx.params);
        const mimeType = readString(ctx.params, "mimeType", "contentType");
        const media = mediaParam(ctx.params);
        if (clear) {
          await sendContent(space, running, background("clear"));
          return actionResult(action, { cleared: true }, space);
        }
        const input = buffer ?? media;
        if (!input) throw new Error("Photon setBackground requires clear=true, buffer, or background/image/media/filePath/path.");
        const guardedInput = assertOutboundMediaWithinLimits(input, account.maxOutboundAttachmentBytes);
        if (buffer && !mimeType) throw new Error("Photon setBackground with buffer requires mimeType.");
        const content = Buffer.isBuffer(guardedInput)
          ? background(guardedInput, { mimeType })
          : /^https?:\/\//i.test(guardedInput)
            ? background(new URL(guardedInput))
            : background(guardedInput);
        await sendContent(space, running, content);
        return actionResult(action, { backgroundSet: true }, space);
      }

      if (action === "setGroupIcon") {
        const space = await resolveActionSpace({ ctx, account, running });
        const buffer = bufferFromBase64(ctx.params);
        const mimeType = readString(ctx.params, "mimeType", "contentType");
        const media = mediaParam(ctx.params);
        const input = buffer ?? media;
        if (!input) throw new Error("Photon setGroupIcon requires buffer or image/media/filePath/path.");
        const guardedInput = assertOutboundMediaWithinLimits(input, account.maxOutboundAttachmentBytes);
        if (buffer) {
          if (!mimeType) throw new Error("Photon setGroupIcon with buffer requires mimeType.");
          await space.avatar(buffer, { mimeType });
        } else {
          await space.avatar(guardedInput as string);
        }
        return actionResult(action, { iconSet: true }, space);
      }

      if (action === "upload-file") {
        const space = await resolveActionSpace({ ctx, account, running });
        const text = textParam(ctx.params) ?? "";
        const media = mediaParam(ctx.params);
        const asVoice = readBoolean(ctx.params, "asVoice", "as_voice") === true;
        const buffer = bufferFromBase64(ctx.params);
        let content: ContentInput;
        if (buffer) {
          assertOutboundMediaWithinLimits(buffer, account.maxOutboundAttachmentBytes);
          const filename = readString(ctx.params, "filename", "name") ?? "attachment";
          content = asVoice ? voice(buffer, { name: filename }) : attachment(buffer, { name: filename });
          const sent = await sendContent(space, running, content);
          return actionResult(action, { messageId: sent?.id }, space);
        } else {
          const media = mediaParams(ctx.params);
          if (media.length === 0) throw new Error("Photon upload-file requires media/filePath/path/fileUrl or buffer.");
          const sent = await sendContents(space, running, buildAccountContents(account, text, media));
          return actionResult(action, {
            messageId: sent[0]?.id,
            messageIds: sent.map((message) => message.id),
          }, space);
        }
      }

      throw new Error(`Photon action ${action} is not supported.`);
      } catch (error) {
        running.status = notePhotonActionError(account.accountId, error);
        if (isPhotonTransportError(error)) {
          running.status = notePhotonTransportError(account.accountId, error);
        }
        if (
          readBoolean(ctx.params, "__photonRetried") !== true &&
          options.recreateRunning &&
          account.provider === "imessage" &&
          !account.local &&
          isPhotonTransportError(error)
        ) {
          running = await options.recreateRunning(account, running);
          return createPhotonMessageActions(runningAccounts, options).handleAction({
            ...ctx,
            params: { ...ctx.params, __photonRetried: true },
          });
        }
        throw error;
      }
    },
  };
}

export function buildBackgroundContent(input: string | Buffer, mimeType?: string): ContentInput {
  return Buffer.isBuffer(input)
    ? background(input, { mimeType })
    : /^https?:\/\//i.test(input)
      ? background(new URL(input))
      : background(input);
}

export function buildCustomizedMiniAppContent(input: Parameters<typeof customizedMiniApp>[0]): ContentInput {
  return customizedMiniApp(input);
}
