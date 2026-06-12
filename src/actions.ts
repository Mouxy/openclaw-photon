import { readFile } from "node:fs/promises";
import {
  attachment,
  edit as editContent,
  markdown,
  poll,
  reaction as reactionContent,
  reply as replyContent,
  unsend as unsendContent,
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
  listPersistedSpaces,
  notePhotonActionError,
  rememberPersistedReaction,
} from "./state.js";
import {
  assertOutboundMediaWithinLimits,
  buildPhotonContents,
  createPhotonApp,
  normalizeOutboundTarget,
  rememberPhotonMessage,
  resolvePhotonSpace,
  stopPhotonApp,
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
] as const;

const DANGEROUS_ACTIONS = ["renameGroup", "setGroupIcon", "setBackground"] as const;
const SUPPORTED_ACTIONS = new Set<string>([
  ...SAFE_ACTIONS,
  ...DANGEROUS_ACTIONS,
  "sendAttachment",
  "sendCustomizedMiniApp",
  "mini-app",
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
    message.includes("ConnectionError")
  );
}

async function recreateRunningPhotonApp(
  runningAccounts: Map<string, RunningPhotonAccount>,
  account: ResolvedPhotonAccount,
  current: RunningPhotonAccount,
): Promise<RunningPhotonAccount> {
  const next = await createPhotonApp(account);
  next.spaces = current.spaces;
  next.messages = current.messages;
  next.reactionMessages = current.reactionMessages;
  next.seenMessages = current.seenMessages;
  next.status = current.status;
  runningAccounts.set(account.accountId, next);
  await stopPhotonApp(current).catch(() => undefined);
  return next;
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

function assertNativeActions(account: ResolvedPhotonAccount): void {
  if (!account.nativeActions) throw new Error("Photon native iMessage actions are disabled for this account.");
  if (account.provider !== "imessage") throw new Error("Photon native actions require the iMessage provider.");
}

function assertDangerousAllowed(ctx: ActionContext, account: ResolvedPhotonAccount): void {
  if (!DANGEROUS_ACTIONS.includes(ctx.action as any)) return;
  if (account.dangerousNativeActions || ctx.senderIsOwner === true) return;
  throw new Error(`Photon ${ctx.action} is restricted to the owner unless dangerousNativeActions=true.`);
}

function assertRemoteForRichNative(account: ResolvedPhotonAccount, action: string): void {
  if (!account.local) return;
  if (["edit", "unsend"].includes(action)) return;
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
  let messageId = explicitMessageId(ctx);
  let space: Space | undefined;

  if (!messageId) {
    const target = normalizeOutboundTarget(targetFromContext(ctx) ?? "");
    if (target) {
      space = await resolvePhotonSpace(running, target);
      const latest = getLatestPersistedMessageForSpace(
        account.accountId,
        space?.id ?? target,
        defaultMessageDirectionForAction(ctx.action),
      );
      messageId = latest?.id;
    }
  }

  if (!messageId) throw new Error(`Photon ${ctx.action} requires messageId or a current inbound message.`);
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

async function miniAppInput(params: Record<string, unknown>, account: ResolvedPhotonAccount) {
  const defaults = account.miniAppDefaults ?? {};
  const layoutParam = params.layout && typeof params.layout === "object" && !Array.isArray(params.layout)
    ? (params.layout as Record<string, unknown>)
    : {};
  const layoutSource = { ...defaults, ...params, ...layoutParam };
  const image = await miniAppImageBytes(layoutSource, account);
  const imageTitle = readString(layoutSource, "imageTitle", "image_title");
  const imageSubtitle = readString(layoutSource, "imageSubtitle", "image_subtitle");
  const layout = {
    ...(readString(layoutSource, "caption", "title") ? { caption: readString(layoutSource, "caption", "title") } : {}),
    ...(readString(layoutSource, "subcaption", "subtitle") ? { subcaption: readString(layoutSource, "subcaption", "subtitle") } : {}),
    ...(readString(layoutSource, "trailingCaption", "trailing_caption") ? { trailingCaption: readString(layoutSource, "trailingCaption", "trailing_caption") } : {}),
    ...(readString(layoutSource, "trailingSubcaption", "trailing_subcaption") ? { trailingSubcaption: readString(layoutSource, "trailingSubcaption", "trailing_subcaption") } : {}),
    ...(readString(layoutSource, "summary", "fallback") ? { summary: readString(layoutSource, "summary", "fallback") } : {}),
    ...(image ? { image } : {}),
    ...(imageTitle ? { imageTitle } : {}),
    ...(imageSubtitle ? { imageSubtitle } : {}),
  };

  return {
    appName: readString({ ...defaults, ...params }, "appName", "app_name"),
    appStoreId: readNumber({ ...defaults, ...params }, "appStoreId", "app_store_id"),
    extensionBundleId: readString({ ...defaults, ...params }, "extensionBundleId", "extension_bundle_id", "bundleId", "bundle_id"),
    teamId: readString({ ...defaults, ...params }, "teamId", "team_id"),
    url: readString({ ...defaults, ...params }, "url", "appUrl", "app_url"),
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

function doctorResult(account: ResolvedPhotonAccount, running: RunningPhotonAccount | undefined): AgentToolResult {
  const persisted = getPhotonStatus(account.accountId);
  const spaces = listPersistedSpaces(account.accountId);
  return jsonActionResult({
    ok: Boolean(running),
    channel: CHANNEL_ID,
    action: "photonDoctor",
    accountId: account.accountId,
    provider: account.provider,
    local: account.local,
    dmPolicy: account.dmPolicy,
    groupPolicy: account.groupPolicy,
    requireMention: account.requireMention,
    nativeActions: account.nativeActions,
    dangerousNativeActions: account.dangerousNativeActions,
    effectsDefault: false,
    customMiniAppsExposed: true,
    state: {
      ...persisted,
      ...(running?.status ?? {}),
      running: Boolean(running),
      cachedSpaces: running?.spaces.size ?? spaces.length,
      cachedMessages: running?.messages.size ?? undefined,
      cachedReactionHandles: running?.reactionMessages.size ?? undefined,
      persistedSpaces: spaces.length,
    },
  });
}

export function createPhotonMessageActions(runningAccounts: Map<string, RunningPhotonAccount>) {
  return {
    describeMessageTool: ({ cfg, accountId, senderIsOwner }: any) => {
      const account = resolveAccount(cfg, accountId);
      if (!account.enabled || !account.nativeActions || account.provider !== "imessage") return null;
      const actions = account.local ? ["edit", "unsend"] : [...SAFE_ACTIONS];
      if (!account.local && (account.dangerousNativeActions || senderIsOwner === true)) {
        actions.push(...DANGEROUS_ACTIONS);
      }
      return {
        actions,
        mediaSourceParams: {
          "upload-file": ["media", "mediaUrl", "filePath", "path", "fileUrl"],
          sendWithEffect: ["media", "mediaUrl", "filePath", "path", "fileUrl"],
          sendMiniApp: ["image", "imagePath", "filePath", "path"],
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
      sendMiniApp: { aliases: ["target"] },
      sendCustomizedMiniApp: { aliases: ["target"] },
      "mini-app": { aliases: ["target"] },
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
        await space.send(editContent(firstContent(buildAccountContents(account, text)), message));
        return actionResult(action, { edited: messageId, messageId }, space);
      }

      if (action === "unsend") {
        const { space, messageId, message } = await resolveActionMessage({ ctx, account, running });
        await space.send(unsendContent(message));
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
        const sent = await sendContent(
          space,
          running,
          effect(markdown(text.slice(0, account.textChunkLimit)), effectId(readString(ctx.params, "effectId", "effect")) as any),
        );
        const extraMedia = mediaParams(ctx.params);
        const mediaMessages = extraMedia.length
          ? await sendContents(space, running, buildAccountContents(account, "", extraMedia))
          : [];
        const messageIds = [sent, ...mediaMessages].filter(Boolean).map((message) => message!.id);
        return actionResult(action, {
          messageId: messageIds.at(-1),
          messageIds,
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

      if (action === "sendMiniApp") {
        const space = await resolveActionSpace({ ctx, account, running });
        assertMiniAppAllowed(ctx, account, space);
        const input = await miniAppInput(ctx.params, account);
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
        if (
          readBoolean(ctx.params, "__photonRetried") !== true &&
          account.provider === "imessage" &&
          !account.local &&
          isPhotonTransportError(error)
        ) {
          running = await recreateRunningPhotonApp(runningAccounts, account, running);
          return createPhotonMessageActions(runningAccounts).handleAction({
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
