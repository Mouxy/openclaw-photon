import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { buildChannelInboundMediaPayload, toInboundMediaFacts, type ChannelInboundMediaInput } from "openclaw/plugin-sdk/channel-inbound";
import { issuePairingChallenge, readChannelAllowFromStore, upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { readStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/security-runtime";
import type { Message, Space } from "spectrum-ts";
import { read as imessageRead } from "spectrum-ts/providers/imessage";
import { CHANNEL_ID, type PhotonNormalizedInbound, type ResolvedPhotonAccount, type RunningPhotonAccount } from "./types.js";
import { handlePhotonDirectCommand } from "./directCommands.js";
import { replyPhotonRich, replyPhotonText } from "./spectrum.js";
import { notePhotonMediaError, notePhotonUnsupportedContent } from "./state.js";

function normalizeId(value: unknown): string {
  return String(value ?? "").trim();
}

function isAllowed(allowFrom: string[], senderId: string): boolean {
  return allowFrom.includes(senderId.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function foldAccents(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function wasMentioned(text: string, names: string[]): boolean {
  const foldedText = foldAccents(text);
  return names.some((name) => {
    const foldedName = foldAccents(name);
    return new RegExp(`(^|\\s)@?${escapeRegExp(foldedName)}(?=\\s|$|[,:;.!?])`, "i").test(foldedText);
  });
}

function parseSlashCommandName(body: string): string | undefined {
  const match = body.trimStart().match(/^\/([^\s@:/]+)(?:@[^\s:/]+)?(?=\s|:|$)/);
  return match?.[1]?.trim() || undefined;
}

export function buildDirectTextCommandMetadata(params: {
  body: string;
  cfg?: any;
  core?: any;
}): Record<string, unknown> {
  const body = params.body.trimStart();
  const commandName = parseSlashCommandName(body);
  if (!commandName) return {};

  const shouldHandleTextCommands = params.core?.channel?.commands?.shouldHandleTextCommands;
  if (
    typeof shouldHandleTextCommands === "function" &&
    shouldHandleTextCommands({
      cfg: params.cfg,
      surface: CHANNEL_ID,
      commandSource: "text",
    }) === false
  ) {
    return {};
  }

  return {
    CommandAuthorized: true,
    CommandSource: "text",
    CommandTurn: {
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName,
      body,
    },
  };
}

export function cleanLeadingMention(text: string, names: string[]): string {
  const trimmed = text.trimStart();
  if (!trimmed) return text;

  for (const name of names) {
    const foldedName = foldAccents(name);
    const pattern = new RegExp(`^@?${escapeRegExp(foldedName)}(?=\\s|$|[,:;.!?\\-])\\s*[,;:!\\-]?\\s*`, "i");
    const foldedText = foldAccents(trimmed);
    const match = foldedText.match(pattern);
    if (!match) continue;
    return trimmed.slice(match[0].length).trimStart() || text;
  }

  return text;
}

function contentToText(content: any, accountId?: string): string {
  if (!content || typeof content !== "object") return "";
  switch (content.type) {
    case "text":
      return String(content.text ?? "").trim();
    case "markdown":
      return String(content.markdown ?? "").trim();
    case "attachment":
      return `[Attachment: ${content.name ?? content.id ?? "file"}]`;
    case "voice": {
      const duration = typeof content.duration === "number" ? `, ${Math.round(content.duration)}s` : "";
      return `[Voice note: ${content.name ?? content.id ?? "audio"}${duration}]`;
    }
    case "contact":
      return [
        `[Contact: ${content.name?.formatted ?? content.name?.first ?? content.user?.id ?? "card"}]`,
        content.phone ? `Phone: ${content.phone}` : "",
        content.email ? `Email: ${content.email}` : "",
      ].filter(Boolean).join("\n");
    case "richlink":
      return [
        content.title ? `[Rich link: ${content.title}]` : "",
        content.summary ? String(content.summary).trim() : "",
        String(content.url ?? "").trim(),
      ].filter(Boolean).join("\n");
    case "poll":
      return [
        `[Poll: ${content.title ?? content.question ?? "untitled"}]`,
        ...(Array.isArray(content.options)
          ? content.options.map((option: any, index: number) => `${index + 1}. ${option?.title ?? option?.text ?? option}`)
          : []),
      ].filter(Boolean).join("\n");
    case "poll_option":
      return `[Poll vote: ${content.title ?? content.option?.title ?? "option"} ${content.selected ? "selected" : "cleared"}]`;
    case "reaction":
      return `[Reaction: ${content.emoji ?? "reaction"}]`;
    case "effect": {
      const inner = contentToText(content.content, accountId);
      const effectName = content.effectId ?? content.effect ?? content.id ?? "iMessage effect";
      return inner ? `[Effect: ${effectName}]\n${inner}` : `[Effect: ${effectName}]`;
    }
    case "customized-mini-app":
    case "customizedMiniApp":
    case "mini-app": {
      const layout = content.layout ?? {};
      return [
        `[Mini-app: ${content.appName ?? "iMessage app"}]`,
        layout.caption,
        layout.subcaption,
        layout.summary,
        content.url,
      ].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");
    }
    case "reply": {
      const inner = contentToText(content.content, accountId);
      return inner ? `[Reply]\n${inner}` : "";
    }
    case "edit": {
      const inner = contentToText(content.content, accountId);
      return inner ? `[Edit]\n${inner}` : "[Edit]";
    }
    case "unsend":
      return "[Message unsent]";
    case "typing":
      return "";
    case "group":
      return Array.isArray(content.items)
        ? content.items.map((item: any) => contentToText(item?.content ?? item, accountId)).filter(Boolean).join("\n")
        : "";
    default:
      if (accountId) notePhotonUnsupportedContent(accountId, String(content.type ?? "unknown"));
      return `[${content.type}]`;
  }
}

function contentType(content: any): string | undefined {
  return content && typeof content === "object" && typeof content.type === "string" ? content.type : undefined;
}

export function isPhotonControlEventContent(content: any): boolean {
  const type = contentType(content);
  switch (type) {
    case "typing":
    case "poll_option":
      return true;
    case "group":
      return Array.isArray(content.items) && content.items.every((item: any) => isPhotonControlEventContent(item?.content ?? item));
    default:
      return false;
  }
}

function mediaKindFromMime(mimeType: string | undefined, contentType: string): ChannelInboundMediaInput["kind"] {
  const lower = String(mimeType ?? "").toLowerCase();
  if (contentType === "voice" || lower.startsWith("audio/")) return "audio";
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower) return "document";
  return "unknown";
}

function attachmentLabel(content: any): string {
  return String(content?.name || content?.id || (content?.type === "voice" ? "voice" : "attachment"));
}

async function collectInboundMedia(params: {
  account: ResolvedPhotonAccount;
  content: any;
  messageId: string;
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
  out: ChannelInboundMediaInput[];
}): Promise<void> {
  const { account, content, messageId, runtime, out } = params;
  if (!content || typeof content !== "object") return;

  if (content.type === "reply" || content.type === "edit") {
    await collectInboundMedia({ account, content: content.content, messageId, runtime, out });
    return;
  }

  if (content.type === "group" && Array.isArray(content.items)) {
    for (const item of content.items) {
      await collectInboundMedia({ account, content: item?.content ?? item, messageId, runtime, out });
    }
    return;
  }

  if (content.type !== "attachment" && content.type !== "voice") return;
  if (typeof content.read !== "function") return;

  const label = attachmentLabel(content);
  const declaredSize = typeof content.size === "number" ? content.size : undefined;
  if (declaredSize && declaredSize > account.maxInboundAttachmentBytes) {
    runtime.log?.(
      `photon: skipping oversized inbound ${content.type} ${JSON.stringify(label)} (${declaredSize} bytes)`,
    );
    return;
  }

  try {
    const buffer = Buffer.from(await content.read());
    if (buffer.length > account.maxInboundAttachmentBytes) {
      runtime.log?.(
        `photon: skipping oversized inbound ${content.type} ${JSON.stringify(label)} (${buffer.length} bytes)`,
      );
      return;
    }
    const saved = await saveMediaBuffer(
      buffer,
      content.mimeType,
      "photon-inbound",
      account.maxInboundAttachmentBytes,
      label,
      label,
    );
    out.push({
      path: saved.path,
      contentType: saved.contentType || content.mimeType,
      kind: mediaKindFromMime(saved.contentType || content.mimeType, content.type),
      messageId: content.id || messageId,
    });
  } catch (err) {
    notePhotonMediaError(account.accountId, err);
    runtime.error?.(`photon: failed to cache inbound ${content.type} ${JSON.stringify(label)}: ${String(err)}`);
  }
}

function spaceType(space: Space): "direct" | "group" {
  return (space as any).type === "group" ? "group" : "direct";
}

function senderId(message: Message): string {
  return normalizeId(message.sender?.id) || "unknown";
}

function senderName(message: Message): string | undefined {
  const sender = message.sender as any;
  return normalizeId(sender?.name || sender?.displayName || sender?.username) || undefined;
}

export function normalizePhotonInbound(params: {
  account: ResolvedPhotonAccount;
  space: Space;
  message: Message;
}): PhotonNormalizedInbound {
  const { account, space, message } = params;
  const rawBody = contentToText(message.content, account.accountId);
  const chatType = spaceType(space);
  const name = senderName(message);
  const spaceLabel = normalizeId((space as any).name || (space as any).displayName || space.id);

  return {
    provider: CHANNEL_ID,
    accountId: account.accountId,
    platform: normalizeId(message.platform || (space as any).__platform || account.provider),
    spaceId: normalizeId(space.id),
    spaceLabel,
    senderId: senderId(message),
    senderName: name,
    messageId: normalizeId(message.id),
    rawBody,
    chatType,
    wasMentioned: wasMentioned(rawBody, account.mentionNames),
    timestamp: message.timestamp instanceof Date ? message.timestamp.getTime() : Date.now(),
  };
}

function summarizeBody(text: string, maxLength = 120): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}...`;
}

function createScopedPairingAccess(params: { channel: string; accountId: string }) {
  const { channel, accountId } = params;
  return {
    readStoreForDmPolicy: () => readChannelAllowFromStore(channel, undefined, accountId),
    upsertPairingRequest: (input: { id: string; meta?: Record<string, string | null | undefined> }) =>
      upsertChannelPairingRequest({ channel, accountId, id: input.id, meta: input.meta }),
  };
}

async function runWithTypingIndicator<T>(
  space: Space,
  runtime: { log?: (message: string) => void; error?: (message: string) => void },
  fn: () => Promise<T>,
): Promise<T> {
  const responding = (space as any).responding;
  if (typeof responding === "function") {
    return await responding.call(space, fn);
  }

  const startTyping = (space as any).startTyping;
  const stopTyping = (space as any).stopTyping;
  if (typeof startTyping !== "function" || typeof stopTyping !== "function") {
    return await fn();
  }

  try {
    await startTyping.call(space).catch((err: unknown) => {
      runtime.log?.(`photon: startTyping failed: ${String(err)}`);
    });
    return await fn();
  } finally {
    await stopTyping.call(space).catch((err: unknown) => {
      runtime.log?.(`photon: stopTyping failed: ${String(err)}`);
    });
  }
}

async function markReadBestEffort(params: {
  account: ResolvedPhotonAccount;
  message: Message;
  space: Space;
  runtime: { log?: (message: string) => void };
}): Promise<void> {
  const { account, message, space, runtime } = params;
  if (!account.sendReadReceipts || account.provider !== "imessage" || account.local) return;

  try {
    if (typeof (message as any).read === "function") {
      await (message as any).read();
    } else if (typeof space.send === "function") {
      await space.send(imessageRead(message));
    }
  } catch (err) {
    runtime.log?.(`photon: read receipt failed: ${String(err)}`);
  }
}

export async function handlePhotonInbound(params: {
  account: ResolvedPhotonAccount;
  cfg: any;
  core: any;
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
  running: RunningPhotonAccount;
  space: Space;
  message: Message;
}): Promise<{ accepted: boolean; reason?: string; normalized: PhotonNormalizedInbound }> {
  const { account, cfg, core, runtime, space, message } = params;
  const normalized = normalizePhotonInbound({ account, space, message });
  const inboundMedia: ChannelInboundMediaInput[] = [];
  await collectInboundMedia({
    account,
    content: message.content,
    messageId: normalized.messageId,
    runtime,
    out: inboundMedia,
  });
  const mediaPayload = buildChannelInboundMediaPayload(
    toInboundMediaFacts(inboundMedia, { messageId: normalized.messageId }),
  );

  runtime.log?.(
    `photon inbound account=${account.accountId} platform=${normalized.platform} space=${normalized.spaceId || "missing"} sender=${normalized.senderId || "missing"} message=${normalized.messageId || "missing"} chatType=${normalized.chatType} mentioned=${normalized.wasMentioned} bodyLength=${normalized.rawBody.length} media=${inboundMedia.length} bodyPreview=${JSON.stringify(summarizeBody(normalized.rawBody))}`,
  );

  if (!normalized.spaceId || !normalized.messageId) {
    return { accepted: false, reason: "missing identifiers", normalized };
  }
  if (message.direction === "outbound") {
    return { accepted: false, reason: "outbound echo", normalized };
  }
  if (!account.dispatchControlEvents && isPhotonControlEventContent(message.content)) {
    return { accepted: false, reason: `control event ${contentType(message.content) ?? "unknown"}`, normalized };
  }
  if (!normalized.rawBody) {
    return { accepted: false, reason: "empty body", normalized };
  }

  const isGroup = normalized.chatType === "group";
  let bodyForAgent = normalized.rawBody;
  if (isGroup) {
    if (account.groupPolicy === "disabled") {
      return { accepted: false, reason: "group policy disabled", normalized };
    }
    if (account.groupPolicy === "allowlist" && !isAllowed(account.groupAllowFrom, normalized.spaceId)) {
      return { accepted: false, reason: "group not allowlisted", normalized };
    }
    if (account.requireMention && !normalized.wasMentioned) {
      return { accepted: false, reason: "mention required", normalized };
    }
    if (account.requireMention) {
      bodyForAgent = cleanLeadingMention(bodyForAgent, account.mentionNames);
    }
  } else {
    if (account.dmPolicy === "disabled") {
      return { accepted: false, reason: "dm policy disabled", normalized };
    }
    if (account.dmPolicy !== "open") {
      const pairing = createScopedPairingAccess({
        channel: CHANNEL_ID,
        accountId: account.accountId,
      });
      const storedAllowFrom = await readStoreAllowFromForDmPolicy({
        provider: CHANNEL_ID,
        accountId: account.accountId,
        dmPolicy: account.dmPolicy,
        readStore: pairing.readStoreForDmPolicy,
      });
      const allowFrom = Array.from(
        new Set([...account.allowFrom, ...storedAllowFrom.map((value: string) => value.toLowerCase())]),
      );
      if (!isAllowed(allowFrom, normalized.senderId)) {
        if (account.dmPolicy === "pairing") {
          await issuePairingChallenge({
            channel: CHANNEL_ID,
            senderId: normalized.senderId,
            senderIdLine: `Your Photon sender id: ${normalized.senderId}`,
            meta: { name: normalized.senderName || undefined, platform: normalized.platform },
            upsertPairingRequest: pairing.upsertPairingRequest,
            sendPairingReply: async (body: string) => {
              await replyPhotonText(message, space, body);
            },
            onReplyError: (err: unknown) => {
              runtime.error?.(`photon: pairing reply failed for ${normalized.senderId}: ${String(err)}`);
            },
          });
        }
        return { accepted: false, reason: `dm policy ${account.dmPolicy}`, normalized };
      }
    }
  }

  await markReadBestEffort({ account, message, space, runtime });

  if (await handlePhotonDirectCommand({ account, cfg, message, normalized, running: params.running, space })) {
    return { accepted: true, normalized };
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: normalized.spaceId,
    },
  });

  const storePath = core.channel.session.resolveStorePath(
    (cfg.session as Record<string, unknown> | undefined)?.store as string | undefined,
    { agentId: route.agentId },
  );
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Photon",
    from: normalized.spaceLabel,
    timestamp: normalized.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: bodyForAgent,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: normalized.rawBody,
    CommandBody: bodyForAgent,
    BodyForCommands: bodyForAgent,
    ...(!isGroup ? buildDirectTextCommandMetadata({ body: bodyForAgent, cfg, core }) : {}),
    From: `photon:${normalized.senderId}`,
    To: `photon:${normalized.spaceId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: normalized.chatType,
    ConversationLabel: normalized.spaceLabel,
    SenderName: normalized.senderName || undefined,
    SenderId: normalized.senderId,
    GroupSubject: isGroup ? normalized.spaceLabel : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? normalized.wasMentioned : undefined,
    MessageSid: normalized.messageId,
    CurrentMessageId: normalized.messageId,
    NativeChannelId: normalized.spaceId,
    Timestamp: normalized.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `photon:${normalized.spaceId}`,
    ...mediaPayload,
  });

  await runWithTypingIndicator(space, runtime, async () => {
    await dispatchInboundReplyWithBase({
      cfg,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      route,
      storePath,
      ctxPayload,
      core,
      deliver: async (replyPayload: any) => {
        const replyText = String(replyPayload?.text ?? "").trim();
        const mediaUrls = resolveOutboundMediaUrls(replyPayload);
        if (!replyText && mediaUrls.length === 0) return;
        await replyPhotonRich(message, space, replyText, mediaUrls, params.running);
      },
      onRecordError: (err: unknown) => {
        runtime.error?.(`photon: failed updating session meta: ${String(err)}`);
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        runtime.error?.(`photon ${info.kind} reply failed: ${String(err)}`);
      },
      replyOptions: {
        disableBlockStreaming: true,
      },
    });
  });

  return { accepted: true, normalized };
}
