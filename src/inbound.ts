import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { buildChannelInboundMediaPayload, toInboundMediaFacts, type ChannelInboundMediaInput } from "openclaw/plugin-sdk/channel-inbound";
import { issuePairingChallenge, readChannelAllowFromStore, upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { readStoreAllowFromForDmPolicy } from "openclaw/plugin-sdk/security-runtime";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { typing, type Message, type Space } from "spectrum-ts";
import { imessage, read as imessageRead } from "spectrum-ts/providers/imessage";
import { CHANNEL_ID, type PhotonNormalizedInbound, type ResolvedPhotonAccount, type RunningPhotonAccount } from "./types.js";
import { handlePhotonDirectCommand } from "./directCommands.js";
import { replyPhotonRich, replyPhotonText, type PhotonOutboundResult } from "./spectrum.js";
import { notePhotonMediaError, notePhotonUnsupportedContent, rememberPhotonDelivery, updatePhotonDelivery } from "./state.js";

const execFileAsync = promisify(execFile);
const LOCAL_MESSAGES_ATTACHMENT_WINDOW_MS = 5 * 60 * 1000;

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
      return `[Poll vote: ${content.title ?? content.option?.title ?? "option"} ${pollOptionStateLabel(content)}]`;
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

function isSelectedPollOption(content: any): boolean {
  const value = content?.selected;
  if (value === true) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return ["true", "selected", "select", "add", "added"].includes(normalized);
  }
  return false;
}

function pollOptionStateLabel(content: any): string {
  return isSelectedPollOption(content) ? "selected" : "cleared";
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

export function shouldIgnorePhotonControlEvent(account: Pick<ResolvedPhotonAccount, "dispatchControlEvents" | "dispatchPollVotes">, content: any): boolean {
  if (account.dispatchControlEvents) return false;
  const type = contentType(content);
  switch (type) {
    case "typing":
      return true;
    case "poll_option":
      return !account.dispatchPollVotes || !isSelectedPollOption(content);
    case "group":
      return Array.isArray(content.items) && content.items.every((item: any) => shouldIgnorePhotonControlEvent(account, item?.content ?? item));
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

function attachmentGuidCandidates(content: any): string[] {
  const candidates = [
    content?.guid,
    content?.attachmentGuid,
    content?.attachment_guid,
    content?.id,
    content?.attachment?.guid,
    content?.attachment?.attachmentGuid,
  ];
  return [...new Set(candidates.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function basenameOrSelf(value: string): string {
  const normalized = value.trim();
  return path.basename(normalized) || normalized;
}

type LocalMessagesAttachmentCandidate = {
  guid?: string;
  transferName?: string;
  filename?: string;
  mimeType?: string;
  totalBytes?: number;
};

export function buildLocalMessagesAttachmentCandidateSql(params: {
  label: string;
  timestampMs: number;
  windowMs?: number;
}): string | undefined {
  const label = basenameOrSelf(params.label);
  if (!label || label === "attachment" || label === "voice") return undefined;

  const timestampMs = Number.isFinite(params.timestampMs) ? params.timestampMs : Date.now();
  const windowMs = params.windowMs ?? LOCAL_MESSAGES_ATTACHMENT_WINDOW_MS;
  const escapedLabel = sqlString(label);
  return `
    select
      a.guid as guid,
      a.transfer_name as transferName,
      a.filename as filename,
      a.mime_type as mimeType,
      a.total_bytes as totalBytes
    from attachment a
      join message_attachment_join maj on maj.attachment_id = a.ROWID
      join message m on m.ROWID = maj.message_id
    where
      abs(((m.date / 1000000) + 978307200000) - ${Math.trunc(timestampMs)}) <= ${windowMs}
      and (
        a.transfer_name = ${escapedLabel}
        or a.filename like ${sqlString(`%/${label}`)}
      )
    order by
      abs(((m.date / 1000000) + 978307200000) - ${Math.trunc(timestampMs)}) asc,
      m.date desc
    limit 1
  `;
}

async function findLocalMessagesAttachmentCandidate(params: {
  label: string;
  timestampMs: number;
}): Promise<LocalMessagesAttachmentCandidate | undefined> {
  const dbPath = path.join(homedir(), "Library/Messages/chat.db");
  const sql = buildLocalMessagesAttachmentCandidateSql(params);
  if (!sql) return undefined;

  try {
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-json", dbPath, sql], { timeout: 3000, maxBuffer: 1024 * 1024 });
    const rows = JSON.parse(stdout || "[]");
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row !== "object") return undefined;
    return row as LocalMessagesAttachmentCandidate;
  } catch {
    return undefined;
  }
}

async function cacheLocalMessagesAttachment(params: {
  account: ResolvedPhotonAccount;
  content: any;
  messageId: string;
  timestampMs: number;
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
  out: ChannelInboundMediaInput[];
}): Promise<boolean> {
  const { account, content, messageId, timestampMs, runtime, out } = params;
  const label = attachmentLabel(content);
  const candidate = await findLocalMessagesAttachmentCandidate({ label, timestampMs });
  if (!candidate?.filename) return false;

  const localPath = expandHome(candidate.filename);
  try {
      const buffer = await readFile(localPath);
    if (buffer.length > account.maxInboundAttachmentBytes) {
      runtime.log?.(
        `photon: skipping oversized local Messages attachment ${JSON.stringify(label)} (${buffer.length} bytes)`,
      );
      return true;
    }
    const saved = await saveMediaBuffer(
      buffer,
      candidate.mimeType || undefined,
      "photon-inbound",
      account.maxInboundAttachmentBytes,
      candidate.transferName || label,
      candidate.transferName || label,
    );
    out.push({
      path: saved.path,
      contentType: saved.contentType || candidate.mimeType || undefined,
      kind: mediaKindFromMime(saved.contentType || candidate.mimeType || undefined, content.type),
      messageId: content.id || candidate.guid || messageId,
    });
    runtime.log?.(`photon: hydrated inbound attachment ${JSON.stringify(label)} from local Messages database`);
    return true;
  } catch (err) {
    notePhotonMediaError(account.accountId, err);
    runtime.error?.(`photon: failed to cache local Messages attachment ${JSON.stringify(label)}: ${String(err)}`);
    return true;
  }
}

async function cacheReadableInboundMedia(params: {
  account: ResolvedPhotonAccount;
  content: any;
  messageId: string;
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
  out: ChannelInboundMediaInput[];
}): Promise<boolean> {
  const { account, content, messageId, runtime, out } = params;
  if (typeof content?.read !== "function") return false;

  const label = attachmentLabel(content);
  const declaredSize = typeof content.size === "number" ? content.size : undefined;
  if (declaredSize && declaredSize > account.maxInboundAttachmentBytes) {
    runtime.log?.(
      `photon: skipping oversized inbound ${content.type} ${JSON.stringify(label)} (${declaredSize} bytes)`,
    );
    return true;
  }

  try {
    const buffer = Buffer.from(await content.read());
    if (buffer.length > account.maxInboundAttachmentBytes) {
      runtime.log?.(
        `photon: skipping oversized inbound ${content.type} ${JSON.stringify(label)} (${buffer.length} bytes)`,
      );
      return true;
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
    return true;
  } catch (err) {
    notePhotonMediaError(account.accountId, err);
    runtime.error?.(`photon: failed to cache inbound ${content.type} ${JSON.stringify(label)}: ${String(err)}`);
    return false;
  }
}

async function collectInboundMedia(params: {
  account: ResolvedPhotonAccount;
  content: any;
  messageId: string;
  timestampMs: number;
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
  out: ChannelInboundMediaInput[];
  fetchAttachment?: (guid: string) => Promise<any>;
}): Promise<void> {
  const { account, content, messageId, timestampMs, runtime, out, fetchAttachment } = params;
  if (!content || typeof content !== "object") return;

  if (content.type === "reply" || content.type === "edit") {
    await collectInboundMedia({ account, content: content.content, messageId, timestampMs, runtime, out, fetchAttachment });
    return;
  }

  if (content.type === "group" && Array.isArray(content.items)) {
    for (const item of content.items) {
      await collectInboundMedia({ account, content: item?.content ?? item, messageId, timestampMs, runtime, out, fetchAttachment });
    }
    return;
  }

  if (content.type !== "attachment" && content.type !== "voice") return;

  if (await cacheReadableInboundMedia({ account, content, messageId, runtime, out })) {
    return;
  }

  if (fetchAttachment) {
    for (const guid of attachmentGuidCandidates(content)) {
      try {
        const fetched = await fetchAttachment(guid);
        if (fetched && await cacheReadableInboundMedia({ account, content: fetched, messageId, runtime, out })) {
          runtime.log?.(`photon: hydrated inbound attachment ${JSON.stringify(attachmentLabel(content))} from GUID ${JSON.stringify(guid)}`);
          return;
        }
      } catch (err) {
        notePhotonMediaError(account.accountId, err);
        runtime.error?.(`photon: failed to hydrate inbound attachment ${JSON.stringify(attachmentLabel(content))} from GUID ${JSON.stringify(guid)}: ${String(err)}`);
      }
    }
  }

  if (account.provider === "imessage") {
    if (await cacheLocalMessagesAttachment({ account, content, messageId, timestampMs, runtime, out })) {
      return;
    }
  }

  runtime.log?.(
    `photon: inbound ${content.type} ${JSON.stringify(attachmentLabel(content))} had no readable bytes; keys=${Object.keys(content).sort().join(",") || "none"}`,
  );
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

export function createBatchedPhotonMessage(messages: Message[]): Message {
  const nonEmpty = messages.filter(Boolean);
  if (nonEmpty.length <= 1) return nonEmpty[0]!;

  const latest = nonEmpty[nonEmpty.length - 1]!;
  const first = nonEmpty[0]!;
  return {
    ...latest,
    id: latest.id,
    content: { type: "group", items: nonEmpty },
    sender: latest.sender ?? first.sender,
    timestamp: latest.timestamp ?? first.timestamp,
    direction: latest.direction ?? first.direction,
    platform: latest.platform ?? first.platform,
    photonBatchMessageIds: nonEmpty.map((message) => normalizeId(message.id)).filter(Boolean),
  } as Message;
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

async function sendTypingState(
  space: Space,
  state: "start" | "stop",
  runtime: { log?: (message: string) => void },
): Promise<void> {
  const startTyping = (space as any).startTyping;
  const stopTyping = (space as any).stopTyping;
  const method = state === "start" ? startTyping : stopTyping;
  if (typeof method === "function") {
    await method.call(space).catch((err: unknown) => {
      runtime.log?.(`photon: ${state}Typing failed: ${String(err)}`);
    });
    return;
  }

  if (typeof space.send === "function") {
    await space.send(typing(state)).catch((err: unknown) => {
      runtime.log?.(`photon: typing(${state}) failed: ${String(err)}`);
    });
  }
}

export function createPhotonTypingRefresher(params: {
  space: Space;
  runtime?: { log?: (message: string) => void };
  enabled?: boolean;
  intervalMs?: number;
}): { stop: () => Promise<void> } {
  if (params.enabled === false) {
    return { stop: async () => {} };
  }

  const intervalMs = params.intervalMs ?? 4_000;
  let stopped = false;
  let refreshing = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = async () => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      await sendTypingState(params.space, "start", params.runtime ?? {});
    } finally {
      refreshing = false;
    }
  };

  void refresh();
  timer = setInterval(() => {
    void refresh();
  }, intervalMs);
  timer.unref?.();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      await sendTypingState(params.space, "stop", params.runtime ?? {});
    },
  };
}

async function runWithTypingIndicator<T>(
  space: Space,
  runtime: { log?: (message: string) => void; error?: (message: string) => void },
  fn: () => Promise<T>,
  options: { enabled?: boolean; refreshIntervalMs?: number } = {},
): Promise<T> {
  const responding = (space as any).responding;
  const run = async () => {
    const refresher = createPhotonTypingRefresher({
      space,
      runtime,
      enabled: options.enabled,
      intervalMs: options.refreshIntervalMs,
    });
    try {
      return await fn();
    } finally {
      await refresher.stop();
    }
  };

  if (typeof responding === "function") {
    return await responding.call(space, run);
  }

  if (options.enabled === false) {
    return await fn();
  }

  return await run();
}

async function runWithLongTurnNotice<T>(
  params: {
    enabled?: boolean;
    delayMs?: number;
    message: Message;
    runtime: { log?: (message: string) => void; error?: (message: string) => void };
    running: RunningPhotonAccount;
    space: Space;
  },
  fn: () => Promise<T>,
): Promise<T> {
  if (params.enabled === false) return await fn();

  let completed = false;
  let noticeSent = false;
  const delayMs = params.delayMs ?? 45_000;
  const timer = setTimeout(() => {
    if (completed || noticeSent) return;
    noticeSent = true;
    void replyPhotonRich(params.message, params.space, "Still working on this.", [], params.running).catch((err) => {
      params.runtime.log?.(`photon: long-turn notice failed: ${String(err)}`);
    });
  }, delayMs);
  timer.unref?.();

  try {
    return await fn();
  } finally {
    completed = true;
    clearTimeout(timer);
  }
}

function createPhotonReplyOptions(params: { enabled?: boolean }): Record<string, unknown> {
  if (params.enabled === false) {
    return {
      suppressDefaultToolProgressMessages: true,
      allowProgressCallbacksWhenSourceDeliverySuppressed: false,
    };
  }

  return {
    suppressDefaultToolProgressMessages: true,
    allowProgressCallbacksWhenSourceDeliverySuppressed: false,
  };
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
  createActions?: () => {
    handleAction: (ctx: any) => Promise<any>;
  };
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
  running: RunningPhotonAccount;
  space: Space;
  message: Message;
  sendReply?: (input: {
    message: Message;
    space: Space;
    text: string;
    mediaUrls: string[];
  }) => Promise<PhotonOutboundResult | undefined>;
}): Promise<{ accepted: boolean; reason?: string; normalized: PhotonNormalizedInbound; shouldAcknowledge: boolean }> {
  const { account, cfg, core, runtime, space, message } = params;
  const normalized = normalizePhotonInbound({ account, space, message });
  const inboundMedia: ChannelInboundMediaInput[] = [];
  const fetchAttachment =
    account.provider === "imessage" && !account.local
      ? async (guid: string) => {
          const platform = imessage(params.running.app as any) as any;
          return await platform.getAttachment(guid, (space as any).phone);
        }
      : undefined;
  await collectInboundMedia({
    account,
    content: message.content,
    messageId: normalized.messageId,
    timestampMs: normalized.timestamp,
    runtime,
    out: inboundMedia,
    fetchAttachment,
  });
  const mediaPayload = buildChannelInboundMediaPayload(
    toInboundMediaFacts(inboundMedia, { messageId: normalized.messageId }),
  );
  const deliveryId = normalized.messageId;
  const now = Date.now();
  if (deliveryId) {
    rememberPhotonDelivery(account.accountId, {
      id: deliveryId,
      inboundMessageId: normalized.messageId,
      spaceId: normalized.spaceId,
      platform: normalized.platform,
      senderId: normalized.senderId,
      chatType: normalized.chatType,
      bodyPreview: summarizeBody(normalized.rawBody),
      status: "received",
      receivedAt: now,
    });
  }

  runtime.log?.(
    `photon inbound account=${account.accountId} platform=${normalized.platform} space=${normalized.spaceId || "missing"} sender=${normalized.senderId || "missing"} message=${normalized.messageId || "missing"} chatType=${normalized.chatType} mentioned=${normalized.wasMentioned} bodyLength=${normalized.rawBody.length} media=${inboundMedia.length} bodyPreview=${JSON.stringify(summarizeBody(normalized.rawBody))}`,
  );

  if (!normalized.spaceId || !normalized.messageId) {
    if (deliveryId) {
      updatePhotonDelivery(account.accountId, deliveryId, {
        status: "ignored",
        reason: "missing identifiers",
        ignoredAt: Date.now(),
      });
    }
    return { accepted: false, reason: "missing identifiers", normalized, shouldAcknowledge: true };
  }
  if (message.direction === "outbound") {
    updatePhotonDelivery(account.accountId, deliveryId, {
      status: "ignored",
      reason: "outbound echo",
      ignoredAt: Date.now(),
    });
    return { accepted: false, reason: "outbound echo", normalized, shouldAcknowledge: true };
  }
  if (isPhotonControlEventContent(message.content) && shouldIgnorePhotonControlEvent(account, message.content)) {
    const reason = `control event ${contentType(message.content) ?? "unknown"}`;
    updatePhotonDelivery(account.accountId, deliveryId, {
      status: "ignored",
      reason,
      ignoredAt: Date.now(),
    });
    return { accepted: false, reason, normalized, shouldAcknowledge: true };
  }
  if (!normalized.rawBody) {
    updatePhotonDelivery(account.accountId, deliveryId, {
      status: "ignored",
      reason: "empty body",
      ignoredAt: Date.now(),
    });
    return { accepted: false, reason: "empty body", normalized, shouldAcknowledge: true };
  }

  const isGroup = normalized.chatType === "group";
  let bodyForAgent = normalized.rawBody;
  if (isGroup) {
    if (account.groupPolicy === "disabled") {
      updatePhotonDelivery(account.accountId, deliveryId, {
        status: "ignored",
        reason: "group policy disabled",
        ignoredAt: Date.now(),
      });
      return { accepted: false, reason: "group policy disabled", normalized, shouldAcknowledge: true };
    }
    if (account.groupPolicy === "allowlist" && !isAllowed(account.groupAllowFrom, normalized.spaceId)) {
      updatePhotonDelivery(account.accountId, deliveryId, {
        status: "ignored",
        reason: "group not allowlisted",
        ignoredAt: Date.now(),
      });
      return { accepted: false, reason: "group not allowlisted", normalized, shouldAcknowledge: true };
    }
    if (account.requireMention && !normalized.wasMentioned) {
      updatePhotonDelivery(account.accountId, deliveryId, {
        status: "ignored",
        reason: "mention required",
        ignoredAt: Date.now(),
      });
      return { accepted: false, reason: "mention required", normalized, shouldAcknowledge: true };
    }
    if (account.requireMention) {
      bodyForAgent = cleanLeadingMention(bodyForAgent, account.mentionNames);
    }
  } else {
    if (account.dmPolicy === "disabled") {
      updatePhotonDelivery(account.accountId, deliveryId, {
        status: "ignored",
        reason: "dm policy disabled",
        ignoredAt: Date.now(),
      });
      return { accepted: false, reason: "dm policy disabled", normalized, shouldAcknowledge: true };
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
        const reason = `dm policy ${account.dmPolicy}`;
        updatePhotonDelivery(account.accountId, deliveryId, {
          status: "ignored",
          reason,
          ignoredAt: Date.now(),
        });
        return { accepted: false, reason, normalized, shouldAcknowledge: true };
      }
    }
  }

  updatePhotonDelivery(account.accountId, deliveryId, {
    status: "accepted",
    acceptedAt: Date.now(),
  });
  await markReadBestEffort({ account, message, space, runtime });

  if (await handlePhotonDirectCommand({ account, cfg, createActions: params.createActions, message, normalized, running: params.running, space })) {
    updatePhotonDelivery(account.accountId, deliveryId, {
      status: "replied",
      reason: "direct command",
      repliedAt: Date.now(),
    });
    return { accepted: true, normalized, shouldAcknowledge: true };
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

  let dispatchFailed = false;
  let dispatchFailureReason: string | undefined;
  let replyDelivered = false;

  await runWithTypingIndicator(
    space,
    runtime,
    async () => {
      await runWithLongTurnNotice(
        {
          enabled: account.longTurnNotice,
          delayMs: account.longTurnNoticeDelayMs,
          message,
          runtime,
          running: params.running,
          space,
        },
        async () => {
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
              const result = params.sendReply
                ? await params.sendReply({ message, space, text: replyText, mediaUrls })
                : await replyPhotonRich(message, space, replyText, mediaUrls, params.running);
              replyDelivered = true;
              updatePhotonDelivery(account.accountId, deliveryId, {
                status: "replied",
                outboundMessageIds: result?.meta?.messageIds ?? (result?.messageId ? [result.messageId] : undefined),
                repliedAt: Date.now(),
              });
            },
            onRecordError: (err: unknown) => {
              runtime.error?.(`photon: failed updating session meta: ${String(err)}`);
            },
            onDispatchError: (err: unknown, info: { kind: string }) => {
              dispatchFailed = true;
              dispatchFailureReason = info.kind;
              runtime.error?.(`photon ${info.kind} reply failed: ${String(err)}`);
              updatePhotonDelivery(account.accountId, deliveryId, {
                status: "failed",
                reason: info.kind,
                error: String(err),
                failedAt: Date.now(),
              });
            },
            replyOptions: {
              disableBlockStreaming: true,
              ...createPhotonReplyOptions({ enabled: account.typingIndicators }),
            },
          });
        },
      );
    },
    { enabled: account.typingIndicators, refreshIntervalMs: 4_000 },
  );

  if (dispatchFailed) {
    return {
      accepted: false,
      reason: dispatchFailureReason ? `dispatch ${dispatchFailureReason} failed` : "dispatch failed",
      normalized,
      shouldAcknowledge: false,
    };
  }

  if (!replyDelivered) {
    updatePhotonDelivery(account.accountId, deliveryId, {
      status: "handled",
      reason: "no channel reply recorded",
      handledAt: Date.now(),
    });
  }

  return { accepted: true, normalized, shouldAcknowledge: true };
}
