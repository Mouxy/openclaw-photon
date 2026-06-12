import type { Message, Space } from "spectrum-ts";
import { resolveAccount } from "./config.js";
import { createPhotonMessageActions } from "./actions.js";
import { CHANNEL_ID, type PhotonNormalizedInbound, type ResolvedPhotonAccount, type RunningPhotonAccount } from "./types.js";
import { replyPhotonRich, replyPhotonText } from "./spectrum.js";

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

type DirectCommandContext = {
  account: ResolvedPhotonAccount;
  cfg: any;
  message: Message;
  normalized: PhotonNormalizedInbound;
  running: RunningPhotonAccount;
  space: Space;
};

function parseDirectCommand(body: string): { name: string; args: string } | undefined {
  const trimmed = body.trimStart();
  const match = trimmed.match(/^\/([^\s@:/]+)(?:@[^\s:/]+)?(?::|\s)?([\s\S]*)$/);
  if (!match) return undefined;
  return {
    name: match[1]!.trim().toLowerCase(),
    args: match[2]?.trimStart() ?? "",
  };
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
    "- Effects: /effects, or /effect <name> <message>",
    "- Attachments/voice: available through OpenClaw media replies and upload-file",
    "- Mini-app cards: sendMiniApp / mini-app action",
    `- ${miniAppDefaultsStatus(account)}`,
  ].join("\n");
}

export function buildPhotonDoctorSummary(account: ResolvedPhotonAccount, running: RunningPhotonAccount): string {
  const status = running.status ?? {};
  return [
    "Photon doctor",
    "",
    `- account: ${account.accountId}`,
    `- provider: ${account.provider}${account.local ? " local" : " remote"}`,
    `- running: yes`,
    `- direct policy: ${account.dmPolicy}`,
    `- native actions: ${account.nativeActions ? "on" : "off"}`,
    `- cached spaces: ${running.spaces.size}`,
    `- cached messages: ${running.messages.size}`,
    `- reaction handles: ${running.reactionMessages.size}`,
    status.lastStreamError ? `- last stream error: ${status.lastStreamError}` : "",
    status.lastActionError ? `- last action error: ${status.lastActionError}` : "",
    status.lastMediaError ? `- last media error: ${status.lastMediaError}` : "",
  ].filter(Boolean).join("\n");
}

export function buildPhotonEffectsSummary(): string {
  return [
    "Photon iMessage effects",
    "",
    EFFECT_ALIASES.join(", "),
    "",
    "Use: /effect <name> <message>",
  ].join("\n");
}

async function sendEffectCommand(ctx: DirectCommandContext, args: string): Promise<void> {
  const [effectName, ...messageParts] = args.trim().split(/\s+/);
  const text = messageParts.join(" ").trim();
  if (!effectName || !text) {
    await replyPhotonText(ctx.message, ctx.space, "Use: /effect <name> <message>");
    return;
  }

  const actions = createPhotonMessageActions(new Map([[ctx.account.accountId, ctx.running]]));
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
    default:
      return false;
  }
}

