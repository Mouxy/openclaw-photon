import {
  Spectrum,
  attachment,
  group,
  markdown,
  richlink,
  typing,
  voice,
  type ContentInput,
  type Message,
  type Space,
} from "spectrum-ts";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { CHANNEL_ID, type ResolvedPhotonAccount, type RunningPhotonAccount } from "./types.js";
import { notePhotonOutbound, rememberPersistedMessage, rememberPersistedSpace } from "./state.js";

export type PhotonOutboundResult = {
  channel: typeof CHANNEL_ID;
  messageId: string;
  channelId: string;
  meta?: {
    messageIds?: string[];
  };
};

export async function createPhotonApp(account: ResolvedPhotonAccount): Promise<RunningPhotonAccount> {
  const provider =
    account.provider === "terminal"
      ? terminal.config()
      : imessage.config(account.local ? { local: true } : {});

  const spectrumOptions =
    account.projectId && account.projectSecret
      ? {
          projectId: account.projectId,
          projectSecret: account.projectSecret,
          providers: [provider as any],
          telemetry: account.telemetry,
          options: { flattenGroups: account.flattenGroups },
        }
      : {
          providers: [provider as any],
          telemetry: account.telemetry,
          options: { flattenGroups: account.flattenGroups },
        };

  const app = await Spectrum(spectrumOptions as any);

  return {
    accountId: account.accountId,
    app: app as any,
    spaces: new Map<string, Space>(),
    messages: new Map<string, Message>(),
    reactionMessages: new Map<string, string>(),
    seenMessages: new Map<string, number>(),
    status: { running: true, startedAt: Date.now(), updatedAt: Date.now() },
  };
}

export async function stopPhotonApp(running: RunningPhotonAccount | undefined): Promise<void> {
  if (!running) return;
  await running.app.stop();
}

export function rememberPhotonMessage(
  running: RunningPhotonAccount,
  space: Space,
  message: Message,
): void {
  const messageSpace = (message as any).space as Space | undefined;
  const effectiveSpace = messageSpace?.id ? messageSpace : space;
  running.spaces.set(effectiveSpace.id, effectiveSpace);
  if (space.id !== effectiveSpace.id) running.spaces.set(space.id, effectiveSpace);
  const phoneTarget = phoneTargetFromSpaceId(space.id) || phoneTargetFromSpaceId(effectiveSpace.id) || normalizePhoneTarget((effectiveSpace as any).phone);
  if (phoneTarget) running.spaces.set(phoneTarget, effectiveSpace);
  running.messages.set(message.id, message);
  const now = Date.now();
  rememberPersistedSpace(running.accountId, {
    id: effectiveSpace.id,
    platform: (effectiveSpace as any).__platform || message.platform,
    type: (effectiveSpace as any).type === "group" ? "group" : "direct",
    phone: typeof (effectiveSpace as any).phone === "string" ? (effectiveSpace as any).phone : undefined,
    label: String((effectiveSpace as any).name || (effectiveSpace as any).displayName || effectiveSpace.id),
    updatedAt: now,
  });
  rememberPersistedMessage(running.accountId, {
    id: message.id,
    spaceId: effectiveSpace.id,
    platform: message.platform || (effectiveSpace as any).__platform,
    direction: message.direction,
    senderId: message.sender?.id,
    contentType: typeof (message.content as any)?.type === "string" ? (message.content as any).type : undefined,
    timestamp: message.timestamp instanceof Date ? message.timestamp.getTime() : undefined,
    updatedAt: now,
  });
}

const DM_CHAT_GUID_RE = /^any;-;(\+\d{6,})$/;
const E164_RE = /^\+\d{6,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUDIO_EXTENSIONS = new Set([".aac", ".aif", ".aiff", ".caf", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav"]);
const DEFAULT_MAX_OUTBOUND_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export type PhotonContentOptions = {
  maxOutboundAttachmentBytes?: number;
};

function normalizePhoneTarget(value: unknown): string | undefined {
  const trimmed = String(value ?? "").trim();
  return E164_RE.test(trimmed) ? trimmed : undefined;
}

export function normalizeOutboundTarget(value: string): string {
  const target = value.trim().replace(/^photon:/i, "");
  if (E164_RE.test(target) || EMAIL_RE.test(target)) return `any;-;${target}`;
  return target;
}

function phoneTargetFromSpaceId(spaceId: string): string | undefined {
  if (E164_RE.test(spaceId)) return spaceId;
  return spaceId.match(DM_CHAT_GUID_RE)?.[1];
}

export function looksLikeAddressTarget(value: string): boolean {
  return E164_RE.test(value) || EMAIL_RE.test(value);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isLocalPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

function fileUrlToLocalPath(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeLocalMediaPath(value: string, maxBytes: number): string {
  const localPath = fileUrlToLocalPath(value) ?? value;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(localPath);
  } catch (err) {
    throw new Error(`Photon outbound media path is not readable: ${localPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Photon outbound media path is not a file: ${localPath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`Photon outbound media path is too large: ${localPath} (${stat.size} bytes > ${maxBytes} bytes)`);
  }
  return localPath;
}

export function assertOutboundMediaWithinLimits(input: string | Buffer, maxBytes = DEFAULT_MAX_OUTBOUND_ATTACHMENT_BYTES): string | Buffer {
  if (Buffer.isBuffer(input)) {
    if (input.length > maxBytes) {
      throw new Error(`Photon outbound media buffer is too large (${input.length} bytes > ${maxBytes} bytes)`);
    }
    return input;
  }
  if (isLocalPath(input) || fileUrlToLocalPath(input)) {
    return normalizeLocalMediaPath(input, maxBytes);
  }
  return input;
}

function attachmentName(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname.split("/").filter(Boolean).pop() || "attachment";
  } catch {
    return value.split("/").filter(Boolean).pop() || "attachment";
  }
}

function extensionFromName(value: string): string {
  const name = attachmentName(value);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function isLikelyAudioMedia(value: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionFromName(value));
}

function buildAttachmentContent(mediaUrl: string, options: Required<PhotonContentOptions>): ContentInput {
  const normalizedMediaUrl = assertOutboundMediaWithinLimits(mediaUrl, options.maxOutboundAttachmentBytes) as string;
  if (isHttpUrl(normalizedMediaUrl)) {
    const url = new URL(normalizedMediaUrl);
    return isLikelyAudioMedia(normalizedMediaUrl)
      ? voice(url, { name: attachmentName(normalizedMediaUrl) })
      : attachment(url, { name: attachmentName(normalizedMediaUrl) });
  }

  return isLikelyAudioMedia(normalizedMediaUrl) ? voice(normalizedMediaUrl) : attachment(normalizedMediaUrl);
}

function standaloneUrl(body: string): string | undefined {
  const trimmed = body.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed).toString();
  } catch {
    return undefined;
  }
}

export function buildPhotonContents(
  body: string,
  mediaUrls: string[] = [],
  options: PhotonContentOptions = {},
): ContentInput[] {
  const resolvedOptions = {
    maxOutboundAttachmentBytes: options.maxOutboundAttachmentBytes ?? DEFAULT_MAX_OUTBOUND_ATTACHMENT_BYTES,
  };
  const contents: ContentInput[] = [];
  const unsupportedMedia: string[] = [];
  const mediaContents: ContentInput[] = [];

  for (const mediaUrl of Array.from(new Set(mediaUrls.map((value) => value.trim()).filter(Boolean)))) {
    if (isHttpUrl(mediaUrl)) {
      mediaContents.push(buildAttachmentContent(mediaUrl, resolvedOptions));
    } else if (isLocalPath(mediaUrl)) {
      mediaContents.push(buildAttachmentContent(mediaUrl, resolvedOptions));
    } else if (fileUrlToLocalPath(mediaUrl)) {
      mediaContents.push(buildAttachmentContent(mediaUrl, resolvedOptions));
    } else {
      unsupportedMedia.push(mediaUrl);
    }
  }

  const trimmedBody = body.trim();
  const fallbackMediaText = unsupportedMedia.length
    ? `\n\n${unsupportedMedia.map((url) => `[Attachment: ${url}]`).join("\n")}`
    : "";
  const textBody = `${trimmedBody}${fallbackMediaText}`.trim();
  if (textBody) {
    const url = mediaContents.length === 0 ? standaloneUrl(textBody) : undefined;
    contents.push(url ? richlink(url) : markdown(textBody));
  }

  if (mediaContents.length >= 2) {
    contents.push(group(mediaContents[0]!, mediaContents[1]!, ...mediaContents.slice(2)));
  } else {
    contents.push(...mediaContents);
  }

  return contents;
}

async function sendContents(
  space: Space,
  contents: ContentInput[],
  running?: RunningPhotonAccount,
): Promise<Message[]> {
  const sent: Message[] = [];
  for (const content of contents) {
    const result = await space.send(content);
    const messages = Array.isArray(result) ? result : result ? [result] : [];
    for (const message of messages) {
      sent.push(message);
      if (running) rememberPhotonMessage(running, space, message);
    }
  }
  if (running) {
    const last = sent.at(-1);
    notePhotonOutbound(running.accountId, { id: last?.id, spaceId: space.id });
  }
  return sent;
}

function toPhotonOutboundResult(space: Space, messages: Message[]): PhotonOutboundResult {
  const messageIds = messages.map((message) => String(message.id ?? "")).filter(Boolean);
  return {
    channel: CHANNEL_ID,
    channelId: space.id,
    messageId: messageIds.at(-1) ?? "",
    meta: messageIds.length > 1 ? { messageIds } : undefined,
  };
}

export async function resolvePhotonSpace(
  running: RunningPhotonAccount,
  target: string,
): Promise<Space | undefined> {
  const targetId = normalizeOutboundTarget(target);
  if (!targetId) {
    throw new Error("Photon target is required");
  }

  const cached = running.spaces.get(targetId);
  if (cached) {
    return cached;
  }

  const platform = imessage(running.app as any) as any;
  let space: Space | undefined;
  const phoneTarget = phoneTargetFromSpaceId(targetId);
  if (phoneTarget) {
    space = platform?.space?.get ? await platform.space.get(targetId) : undefined;
    if (!space?.send) {
      const user = await platform.user(phoneTarget);
      space = await platform.space.create(user);
    }
    if (!space) {
      throw new Error(`Unable to resolve Photon iMessage space for ${targetId}`);
    }
    running.spaces.set(phoneTarget, space);
    running.spaces.set(space.id, space);
  } else if (looksLikeAddressTarget(targetId)) {
    const directSpaceId = `any;-;${targetId}`;
    space = platform?.space?.get ? await platform.space.get(directSpaceId) : undefined;
    if (!space) {
      throw new Error(`Unable to resolve Photon DM for ${targetId}`);
    }
    running.spaces.set(directSpaceId, space);
    running.spaces.set(targetId, space);
    running.spaces.set(space.id, space);
  } else {
    space = platform?.space?.get ? await platform.space.get(targetId) : undefined;
  }
  if (space?.send) running.spaces.set(targetId, space);
  return space;
}

export async function sendPhotonText(
  running: RunningPhotonAccount,
  target: string,
  body: string,
): Promise<PhotonOutboundResult> {
  return sendPhotonRich(running, target, body);
}

export async function sendPhotonRich(
  running: RunningPhotonAccount,
  target: string,
  body: string,
  mediaUrls: string[] = [],
  options: PhotonContentOptions = {},
): Promise<PhotonOutboundResult> {
  const targetId = normalizeOutboundTarget(target);
  const space = await resolvePhotonSpace(running, targetId);
  if (!space?.send) {
    throw new Error(`No cached Photon space for ${targetId}`);
  }
  running.spaces.set(targetId, space);
  const messages = await sendContents(space, buildPhotonContents(body, mediaUrls, options), running);
  return toPhotonOutboundResult(space, messages);
}

export async function sendPhotonTyping(
  running: RunningPhotonAccount,
  target: string,
  state: "start" | "stop",
): Promise<void> {
  const targetId = normalizeOutboundTarget(target);
  const space = await resolvePhotonSpace(running, targetId);
  if (!space?.send) {
    throw new Error(`No cached Photon space for ${targetId}`);
  }

  const method = state === "start" ? "startTyping" : "stopTyping";
  if (typeof (space as any)[method] === "function") {
    await (space as any)[method]();
    return;
  }

  await space.send(typing(state));
}

export async function replyPhotonText(message: Message, fallbackSpace: Space, body: string): Promise<PhotonOutboundResult | undefined> {
  return await replyPhotonRich(message, fallbackSpace, body);
}

export async function replyPhotonRich(
  message: Message,
  fallbackSpace: Space,
  body: string,
  mediaUrls: string[] = [],
  running?: RunningPhotonAccount,
  options: PhotonContentOptions = {},
): Promise<PhotonOutboundResult | undefined> {
  const contents = buildPhotonContents(body, mediaUrls, options);
  if (contents.length === 0) return undefined;

  const [first, ...rest] = contents;
  try {
    const result = await message.reply(first!);
    const messages = Array.isArray(result) ? result : result ? [result] : [];
    for (const sent of messages) {
      if (running) rememberPhotonMessage(running, fallbackSpace, sent);
    }
    const restMessages = await sendContents(fallbackSpace, rest, running);
    const allMessages = [...messages, ...restMessages];
    if (running) {
      const last = allMessages.at(-1);
      notePhotonOutbound(running.accountId, { id: last?.id, spaceId: fallbackSpace.id });
    }
    return toPhotonOutboundResult(fallbackSpace, allMessages);
  } catch {
    const messages = await sendContents(fallbackSpace, contents, running);
    return toPhotonOutboundResult(fallbackSpace, messages);
  }
}
