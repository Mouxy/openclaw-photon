import type { Message, Space } from "spectrum-ts";
import { resolveAccount } from "./config.js";
import { createPhotonMessageActions } from "./actions.js";
import { CHANNEL_ID, type PhotonNormalizedInbound, type ResolvedPhotonAccount, type RunningPhotonAccount } from "./types.js";
import { replyPhotonRich, replyPhotonText } from "./spectrum.js";
import { getPhotonStatus, listUnresolvedPhotonDeliveries, listPersistedSpaces } from "./state.js";

const EFFECT_ALIASES = [
  "slam",
  "loud",
  "gentle",
  "invisible",
  "confetti",
  "fireworks",
  "balloons",
  "heart",
  "lasers",
  "celebration",
  "sparkles",
  "spotlight",
  "echo",
];

const TEXT_EFFECT_ALIASES = [
  "big",
  "small",
  "shake",
  "nod",
  "explode",
  "ripple",
  "bloom",
  "jitter",
];

type DirectCommandContext = {
  account: ResolvedPhotonAccount;
  cfg: any;
  createActions?: () => {
    handleAction: (ctx: any) => Promise<any>;
  };
  message: Message;
  normalized: PhotonNormalizedInbound;
  running: RunningPhotonAccount;
  space: Space;
};

function hasUnresolvedTransportError(status: ReturnType<typeof getPhotonStatus>): boolean {
  const errorAt = status.lastTransportErrorAt ?? 0;
  if (!errorAt || !status.lastTransportError) return false;
  const recoveredAt = Math.max(status.lastTransportRecoveryAt ?? 0, status.lastOutboundAt ?? 0);
  return errorAt > recoveredAt;
}

function hasUnresolvedStreamReconnect(status: ReturnType<typeof getPhotonStatus>): boolean {
  const reconnectAt = status.lastStreamReconnectAt ?? 0;
  if (!reconnectAt) return false;
  const recoveredAt = Math.max(status.lastTransportRecoveryAt ?? 0, status.lastInboundAt ?? 0, status.lastOutboundAt ?? 0);
  return reconnectAt > recoveredAt;
}

function parseDirectCommand(body: string): { name: string; args: string } | undefined {
  const trimmed = body.trimStart();
  const match = trimmed.match(/^\/([^\s@:/]+)(?:@[^\s:/]+)?(?::|\s)?([\s\S]*)$/);
  if (!match) return undefined;
  return {
    name: match[1]!.trim().toLowerCase(),
    args: match[2]?.trimStart() ?? "",
  };
}

export function isPhotonDirectCommandText(body: string): boolean {
  return Boolean(parseDirectCommand(body));
}

function miniAppDefaultsStatus(account: ResolvedPhotonAccount): string {
  const defaults = account.miniAppDefaults ?? {};
  const missing = [
    defaults.appName ? "" : "appName",
    defaults.teamId ? "" : "teamId",
    defaults.extensionBundleId ? "" : "extensionBundleId",
    defaults.url ? "" : "url",
  ].filter(Boolean);
  if (missing.length === 0) return "mini-app defaults: configured";
  return `mini-app defaults: missing ${missing.join(", ")}`;
}

export function buildPhotonAppsSummary(account: ResolvedPhotonAccount): string {
  return [
    "Photon direct-chat apps",
    "",
    "- Native iMessage actions: read, reply, react, edit, unsend",
    "- Effects: /effects, /effect <name> <message>, /animate <name> <message>",
    "- Rich actions: contact cards, polls, poll management, stickers, location requests",
    "- Attachments/voice: available through OpenClaw media replies and upload-file",
    "- Mini-app cards: sendMiniApp / mini-app action",
    `- ${miniAppDefaultsStatus(account)}`,
  ].join("\n");
}

export function buildPhotonDoctorSummary(account: ResolvedPhotonAccount, running: RunningPhotonAccount): string {
  const status = { ...(running.status ?? {}), ...getPhotonStatus(account.accountId) };
  const unresolvedDeliveries = listUnresolvedPhotonDeliveries(account.accountId, 30_000, 10);
  const unresolvedTransportError = hasUnresolvedTransportError(status);
  const unresolvedStreamReconnect = hasUnresolvedStreamReconnect(status);
  const ok = Boolean(running) && !unresolvedTransportError && !unresolvedStreamReconnect && unresolvedDeliveries.length === 0;
  const cachedSpaces = running.spaces.size || listPersistedSpaces(account.accountId).length;
  return [
    "Photon doctor",
    "",
    `- account: ${account.accountId}`,
    `- provider: ${account.provider}${account.local ? " local" : " remote"}`,
    `- running: ${running ? "yes" : "no"}`,
    `- health: ${ok ? "ok" : "degraded"}`,
    `- direct policy: ${account.dmPolicy}`,
    `- native actions: ${account.nativeActions ? "on" : "off"}`,
    `- cached spaces: ${cachedSpaces}`,
    `- cached messages: ${running.messages.size}`,
    `- reaction handles: ${running.reactionMessages.size}`,
    unresolvedTransportError ? `- unresolved transport error: ${status.lastTransportError}` : "",
    unresolvedStreamReconnect ? `- unresolved stream reconnect: ${status.lastStreamError ?? "stream ended"}` : "",
    unresolvedDeliveries.length > 0 ? `- unresolved deliveries: ${unresolvedDeliveries.length} (${unresolvedDeliveries.map((delivery) => delivery.id).join(", ")})` : "",
    status.lastStreamError ? `- last stream error: ${status.lastStreamError}` : "",
    status.lastActionError ? `- last action error: ${status.lastActionError}` : "",
    status.lastMediaError ? `- last media error: ${status.lastMediaError}` : "",
  ].filter(Boolean).join("\n");
}

export function buildPhotonEffectsSummary(): string {
  return [
    "Photon iMessage effects",
    "",
    "Bubble and screen effects:",
    EFFECT_ALIASES.join(", "),
    "",
    "Text animations:",
    TEXT_EFFECT_ALIASES.join(", "),
    "",
    "Use: /effect <name> <message>",
    "Use: /animate <name> <message>",
  ].join("\n");
}

async function sendEffectCommand(ctx: DirectCommandContext, args: string): Promise<void> {
  const [effectName, ...messageParts] = args.trim().split(/\s+/);
  const text = messageParts.join(" ").trim();
  if (!effectName || !text) {
    await replyPhotonText(ctx.message, ctx.space, "Use: /effect <name> <message>");
    return;
  }

  const actions = ctx.createActions?.() ?? createPhotonMessageActions(new Map([[ctx.account.accountId, ctx.running]]));
  await actions.handleAction({
    action: "sendWithEffect",
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
    params: {
      to: ctx.normalized.spaceId,
      effect: effectName,
      message: text,
    },
    senderIsOwner: true,
    toolContext: {
      currentChannelId: ctx.normalized.spaceId,
      currentMessageId: ctx.normalized.messageId,
      currentChannelProvider: CHANNEL_ID,
    },
  });
}

async function sendTextAnimationCommand(ctx: DirectCommandContext, args: string): Promise<void> {
  const [textEffectName, ...messageParts] = args.trim().split(/\s+/);
  const text = messageParts.join(" ").trim();
  if (!textEffectName || !text) {
    await replyPhotonText(ctx.message, ctx.space, "Use: /animate <name> <message>");
    return;
  }

  const actions = ctx.createActions?.() ?? createPhotonMessageActions(new Map([[ctx.account.accountId, ctx.running]]));
  await actions.handleAction({
    action: "sendWithEffect",
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
    params: {
      to: ctx.normalized.spaceId,
      textEffect: textEffectName,
      message: text,
    },
    senderIsOwner: true,
    toolContext: {
      currentChannelId: ctx.normalized.spaceId,
      currentMessageId: ctx.normalized.messageId,
      currentChannelProvider: CHANNEL_ID,
    },
  });
}

export async function handlePhotonDirectCommand(ctx: DirectCommandContext): Promise<boolean> {
  if (ctx.normalized.chatType !== "direct") return false;
  const command = parseDirectCommand(ctx.normalized.rawBody);
  if (!command) return false;

  switch (command.name) {
    case "doctor":
    case "photon":
      await replyPhotonRich(ctx.message, ctx.space, buildPhotonDoctorSummary(resolveAccount(ctx.cfg, ctx.account.accountId), ctx.running), [], ctx.running);
      return true;
    case "effects":
      await replyPhotonRich(ctx.message, ctx.space, buildPhotonEffectsSummary(), [], ctx.running);
      return true;
    case "apps":
      await replyPhotonRich(ctx.message, ctx.space, buildPhotonAppsSummary(resolveAccount(ctx.cfg, ctx.account.accountId)), [], ctx.running);
      return true;
    case "effect":
      await sendEffectCommand(ctx, command.args);
      return true;
    case "animate":
    case "animation":
      await sendTextAnimationCommand(ctx, command.args);
      return true;
    default:
      return false;
  }
}
