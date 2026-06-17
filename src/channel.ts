import { DEFAULT_ACCOUNT_ID as _DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { CHANNEL_ID, type RunningPhotonAccount } from "./types.js";
import { PhotonConfigSchema, listAccountIds, resolveAccount } from "./config.js";
import { getPhotonRuntime } from "./runtime.js";
import { createPhotonApp, rememberPhotonMessage, sendPhotonRich, sendPhotonTyping, stopPhotonApp } from "./spectrum.js";
import { handlePhotonInbound } from "./inbound.js";
import { createPhotonMessageActions } from "./actions.js";
import {
  getPhotonStatus,
  hasProcessedPersistedMessage,
  listPersistedSpaces,
  notePhotonInbound,
  notePhotonStartFailed,
  notePhotonStarted,
  notePhotonStopped,
  notePhotonStreamReconnect,
  rememberProcessedPersistedMessage,
  updatePhotonStatus,
} from "./state.js";

const DEFAULT_ACCOUNT_ID = _DEFAULT_ACCOUNT_ID ?? "default";

const runningAccounts = new Map<string, RunningPhotonAccount>();
const DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEDUPE_MAX_SIZE = 4000;

function normalizeAllowEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

function pruneSeenMessages(seenMessages: Map<string, number>, now: number): void {
  for (const [id, timestamp] of seenMessages) {
    if (now - timestamp <= DEDUPE_WINDOW_MS && seenMessages.size <= DEDUPE_MAX_SIZE) break;
    seenMessages.delete(id);
  }
}

function isDuplicateMessage(running: RunningPhotonAccount, accountId: string, messageId: string): boolean {
  if (!messageId) return false;
  const now = Date.now();
  pruneSeenMessages(running.seenMessages, now);
  if (running.seenMessages.has(messageId)) return true;
  if (hasProcessedPersistedMessage(accountId, messageId)) {
    running.seenMessages.set(messageId, now);
    return true;
  }
  running.seenMessages.set(messageId, now);
  return false;
}

async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function isPhotonTransportError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return (
    message.includes("ECONNRESET") ||
    message.includes("UNAVAILABLE") ||
    message.includes("stream interrupted") ||
    message.includes("ConnectionError") ||
    message.includes("fetch failed") ||
    message.includes("temporarily unavailable")
  );
}

async function startPhotonAppWithRetry(
  account: any,
  abortSignal: AbortSignal | undefined,
  log?: { info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void },
): Promise<RunningPhotonAccount | undefined> {
  let backoffMs = 1000;
  while (!abortSignal?.aborted) {
    try {
      const running = await createPhotonApp(account);
      running.status = notePhotonStarted(account.accountId);
      runningAccounts.set(account.accountId, running);
      log?.info?.(`[photon] started provider=${account.provider} local=${account.local}`);
      return running;
    } catch (error) {
      const retryAt = Date.now() + backoffMs;
      notePhotonStartFailed(account.accountId, error, retryAt);
      log?.error?.(`[photon] failed to start; retrying in ${backoffMs}ms: ${String(error)}`);
      await sleepWithAbort(backoffMs + Math.random() * backoffMs * 0.2, abortSignal);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }
  return undefined;
}

async function replaceRunningPhotonApp(
  account: any,
  current: RunningPhotonAccount,
  log?: { info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void },
): Promise<RunningPhotonAccount> {
  log?.warn?.("[photon] recreating Spectrum app after transport interruption");
  const next = await createPhotonApp(account);
  next.spaces = current.spaces;
  next.messages = current.messages;
  next.reactionMessages = current.reactionMessages;
  next.seenMessages = current.seenMessages;
  next.status = current.status;
  runningAccounts.set(account.accountId, next);
  await stopPhotonApp(current).catch((error) => log?.warn?.(`[photon] old Spectrum app stop failed: ${String(error)}`));
  log?.info?.(`[photon] recreated provider=${account.provider} local=${account.local}`);
  return next;
}

function accountStatus(accountId: string) {
  const running = runningAccounts.get(accountId);
  return {
    ...getPhotonStatus(accountId),
    ...(running ? running.status : {}),
    running: Boolean(running),
    cachedSpaces: running?.spaces.size ?? listPersistedSpaces(accountId).length,
    cachedMessages: running?.messages.size ?? undefined,
    cachedReactionHandles: running?.reactionMessages.size ?? undefined,
  };
}

export const photonPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "Photon",
    selectionLabel: "Photon (Spectrum)",
    detailLabel: "Photon",
    docsPath: "/channels/photon",
    blurb: "Photon Spectrum messaging channel for OpenClaw",
    order: 94,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    threads: true,
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
    effects: true,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.photon"] },
  configSchema: PhotonConfigSchema,
  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string | null) => resolveAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  },
  pairing: {
    idLabel: "photonSenderId",
    normalizeAllowEntry,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }: any) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const channelCfg = cfg?.channels?.[CHANNEL_ID];
      const useAccountPath = Boolean(channelCfg?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.${CHANNEL_ID}.accounts.${resolvedAccountId}.`
        : `channels.${CHANNEL_ID}.`;
      return {
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: "openclaw pairing approve photon <code>",
        normalizeEntry: normalizeAllowEntry,
      };
    },
    collectWarnings: ({ account }: any) => {
      const warnings: string[] = [];
      if (account.provider === "imessage" && !account.local && !(account.projectId && account.projectSecret)) {
        warnings.push("- Photon: iMessage cloud mode needs PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET, or set local=true.");
      }
      if (account.groupPolicy === "allowlist" && account.groupAllowFrom.length === 0) {
        warnings.push('- Photon: groupPolicy="allowlist" with empty groupAllowFrom blocks all group chats.');
      }
      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (target: string) => target.trim(),
    targetResolver: {
      looksLikeId: (id: string) => Boolean(id?.trim()),
      hint: "<spectrum-space-id>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ accountId }: any = {}) =>
      listPersistedSpaces(accountId ?? DEFAULT_ACCOUNT_ID)
        .filter((space) => space.type !== "group")
        .map((space) => ({
          kind: "user",
          id: space.id,
          name: space.label,
          handle: space.phone,
          rank: 70,
          raw: space,
        })),
    listGroups: async ({ accountId }: any = {}) =>
      listPersistedSpaces(accountId ?? DEFAULT_ACCOUNT_ID)
        .filter((space) => space.type === "group")
        .map((space) => ({
          kind: "group",
          id: space.id,
          name: space.label,
          rank: 70,
          raw: space,
        })),
  },
  actions: createPhotonMessageActions(runningAccounts),
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    probeAccount: async ({ accountId }: any = {}) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const status = accountStatus(resolvedAccountId);
      const streamReconnectCount = status.streamReconnectCount ?? 0;
      return {
        ok: status.running && !status.lastStreamError && streamReconnectCount === 0,
        state: status.running ? "running" : "stopped",
        details: status,
      };
    },
  },
  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, cfg }: any) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      let running = runningAccounts.get(resolvedAccountId);
      if (!running) {
        throw new Error(`Photon account ${resolvedAccountId} is not running`);
      }
      const account = resolveAccount(cfg, resolvedAccountId);
      try {
        const result = await sendPhotonRich(running, to, text.slice(0, account.textChunkLimit), [], {
          maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes,
        });
        running.status = updatePhotonStatus(account.accountId, {
          lastOutboundAt: Date.now(),
          lastOutboundMessageId: result.messageId,
          lastOutboundSpaceId: result.channelId,
        });
        return result;
      } catch (error) {
        running.status = updatePhotonStatus(account.accountId, { lastActionError: String(error) });
        if (account.provider !== "imessage" || account.local || !isPhotonTransportError(error)) throw error;
        running = await replaceRunningPhotonApp(account, running);
        const result = await sendPhotonRich(running, to, text.slice(0, account.textChunkLimit), [], {
          maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes,
        });
        running.status = updatePhotonStatus(account.accountId, {
          lastOutboundAt: Date.now(),
          lastOutboundMessageId: result.messageId,
          lastOutboundSpaceId: result.channelId,
        });
        return result;
      }
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg }: any) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      let running = runningAccounts.get(resolvedAccountId);
      if (!running) {
        throw new Error(`Photon account ${resolvedAccountId} is not running`);
      }
      const account = resolveAccount(cfg, resolvedAccountId);
      try {
        const result = await sendPhotonRich(
          running,
          to,
          String(text ?? "").slice(0, account.textChunkLimit),
          mediaUrl ? [String(mediaUrl)] : [],
          { maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes },
        );
        running.status = updatePhotonStatus(account.accountId, {
          lastOutboundAt: Date.now(),
          lastOutboundMessageId: result.messageId,
          lastOutboundSpaceId: result.channelId,
        });
        return result;
      } catch (error) {
        running.status = updatePhotonStatus(account.accountId, { lastActionError: String(error) });
        if (account.provider !== "imessage" || account.local || !isPhotonTransportError(error)) throw error;
        running = await replaceRunningPhotonApp(account, running);
        const result = await sendPhotonRich(
          running,
          to,
          String(text ?? "").slice(0, account.textChunkLimit),
          mediaUrl ? [String(mediaUrl)] : [],
          { maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes },
        );
        running.status = updatePhotonStatus(account.accountId, {
          lastOutboundAt: Date.now(),
          lastOutboundMessageId: result.messageId,
          lastOutboundSpaceId: result.channelId,
        });
        return result;
      }
    },
  },
  heartbeat: {
    sendTyping: async ({ cfg, to, accountId }: any) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const account = resolveAccount(cfg, resolvedAccountId);
      if (!account.enabled || account.provider !== "imessage" || account.local) return;
      const running = runningAccounts.get(resolvedAccountId);
      if (!running) return;
      await sendPhotonTyping(running, to, "start");
    },
    clearTyping: async ({ cfg, to, accountId }: any) => {
      const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
      const account = resolveAccount(cfg, resolvedAccountId);
      if (!account.enabled || account.provider !== "imessage" || account.local) return;
      const running = runningAccounts.get(resolvedAccountId);
      if (!running) return;
      await sendPhotonTyping(running, to, "stop");
    },
  },
  gateway: {
    startAccount: async (ctx: any) => {
      const account = resolveAccount(ctx.cfg, ctx.accountId);
      if (!account.enabled) {
        ctx.log?.info?.("[photon] account disabled");
        return waitUntilAbort(ctx.abortSignal);
      }

      let running = await startPhotonAppWithRetry(account, ctx.abortSignal, ctx.log);
      if (!running) {
        return waitUntilAbort(ctx.abortSignal);
      }

      const loop = (async () => {
        let backoffMs = 1000;
        while (!ctx.abortSignal?.aborted) {
          try {
            for await (const [space, message] of running!.app.messages) {
              backoffMs = 1000;
              if (ctx.abortSignal?.aborted) return;
              if (isDuplicateMessage(running!, account.accountId, String(message?.id ?? ""))) {
                ctx.log?.info?.(`[photon] ignored duplicate message=${String(message?.id ?? "missing")}`);
                continue;
              }
              rememberPhotonMessage(running!, space, message);
              running!.status = notePhotonInbound(account.accountId, {
                id: String(message?.id ?? ""),
                spaceId: String(space?.id ?? ""),
              });
              try {
                const core = getPhotonRuntime();
                const result = await handlePhotonInbound({
                  account,
                  cfg: ctx.cfg,
                  core,
                  running: running!,
                  space,
                  message,
                  runtime: {
                    log: (msg: string) => ctx.log?.info?.(msg),
                    error: (msg: string) => ctx.log?.error?.(msg),
                  },
                });
                rememberProcessedPersistedMessage(account.accountId, String(message?.id ?? ""));
                if (!result.accepted) {
                  ctx.log?.info?.(`[photon] ignored space=${result.normalized.spaceId}: ${result.reason}`);
                }
              } catch (error) {
                ctx.log?.error?.(`[photon] inbound handling failed: ${String(error)}`);
              }
            }
            ctx.log?.warn?.("[photon] message stream ended; re-subscribing");
            if (!ctx.abortSignal?.aborted && running) {
              running.status = notePhotonStreamReconnect(account.accountId);
            }
          } catch (error) {
            running!.status = notePhotonStreamReconnect(account.accountId, error);
            ctx.log?.error?.(`[photon] message stream failed; re-subscribing: ${String(error)}`);
          }
          if (!ctx.abortSignal?.aborted) {
            try {
              running = await replaceRunningPhotonApp(account, running!, ctx.log);
            } catch (error) {
              ctx.log?.error?.(`[photon] failed to recreate Spectrum app: ${String(error)}`);
            }
          }
          await sleepWithAbort(backoffMs + Math.random() * backoffMs * 0.2, ctx.abortSignal);
          backoffMs = Math.min(backoffMs * 2, 30000);
        }
      })();

      return waitUntilAbort(ctx.abortSignal, async () => {
        runningAccounts.delete(account.accountId);
        notePhotonStopped(account.accountId);
        await stopPhotonApp(running);
        await loop.catch(() => undefined);
      });
    },
  },
};
