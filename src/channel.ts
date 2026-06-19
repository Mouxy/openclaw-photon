import { DEFAULT_ACCOUNT_ID as _DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import type { Message, Space } from "spectrum-ts";
import { CHANNEL_ID, type ResolvedPhotonAccount, type RunningPhotonAccount } from "./types.js";
import { PhotonConfigSchema, listAccountIds, resolveAccount } from "./config.js";
import { getPhotonRuntime } from "./runtime.js";
import { createPhotonApp, rememberPhotonMessage, replyPhotonRich, sendPhotonRich, sendPhotonTyping, stopPhotonApp } from "./spectrum.js";
import {
  createBatchedPhotonMessage,
  handlePhotonInbound,
  isPhotonControlEventContent,
  normalizePhotonInbound,
  shouldIgnorePhotonControlEvent,
} from "./inbound.js";
import { isPhotonDirectCommandText } from "./directCommands.js";
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
  notePhotonTransportError,
  rememberProcessedPersistedMessage,
  updatePhotonStatus,
  listUnresolvedPhotonDeliveries,
} from "./state.js";

const DEFAULT_ACCOUNT_ID = _DEFAULT_ACCOUNT_ID ?? "default";

const runningAccounts = new Map<string, RunningPhotonAccount>();
const recreationLocks = new Map<string, Promise<RunningPhotonAccount>>();
const inboundBatches = new Map<string, PendingInboundBatch>();
const DEDUPE_WINDOW_MS = 48 * 60 * 60 * 1000;
const DEDUPE_MAX_SIZE = 4000;
const INFLIGHT_LEASE_MS = 10 * 60 * 1000;

const photonAppLifecycle = {
  create: createPhotonApp,
  stop: stopPhotonApp,
};

type PendingInboundBatch = {
  account: ResolvedPhotonAccount;
  cfg: any;
  core: any;
  firstQueuedAt: number;
  flushTimer?: ReturnType<typeof setTimeout>;
  maxTimer?: ReturnType<typeof setTimeout>;
  messages: Message[];
  runtime: { log?: (message: string) => void; error?: (message: string) => void };
  running: RunningPhotonAccount;
  sendReply: (input: {
    message: Message;
    space: Space;
    text: string;
    mediaUrls: string[];
  }) => Promise<any>;
  space: Space;
  typingStarted?: boolean;
};

function normalizeAllowEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

function pruneSeenMessages(seenMessages: Map<string, number>, now: number): void {
  for (const [id, timestamp] of seenMessages) {
    if (now - timestamp <= DEDUPE_WINDOW_MS && seenMessages.size <= DEDUPE_MAX_SIZE) break;
    seenMessages.delete(id);
  }
}

function tryAcquireMessage(running: RunningPhotonAccount, accountId: string, messageId: string): boolean {
  if (!messageId) return false;
  const now = Date.now();
  pruneSeenMessages(running.seenMessages, now);
  if (running.seenMessages.has(messageId)) return true;
  if (hasProcessedPersistedMessage(accountId, messageId)) {
    running.seenMessages.set(messageId, now);
    return true;
  }
  running.inflightMessages ??= new Map<string, number>();
  const inflightAt = running.inflightMessages.get(messageId);
  if (inflightAt && now - inflightAt <= INFLIGHT_LEASE_MS) return true;
  running.inflightMessages.set(messageId, now);
  return false;
}

function acknowledgeMessage(running: RunningPhotonAccount, accountId: string, messageId: string): void {
  if (!messageId) return;
  running.inflightMessages?.delete(messageId);
  running.seenMessages.set(messageId, Date.now());
  rememberProcessedPersistedMessage(accountId, messageId);
}

function releaseMessage(running: RunningPhotonAccount, messageId: string): void {
  if (!messageId) return;
  running.inflightMessages?.delete(messageId);
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
    message.includes("temporarily unavailable") ||
    message.includes("DEADLINE_EXCEEDED") ||
    message.includes("Connection dropped")
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
      const running = await photonAppLifecycle.create(account);
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
  const accountId = account.accountId;
  const existingLock = recreationLocks.get(accountId);
  if (existingLock) return existingLock;

  const task = (async () => {
    const latest = runningAccounts.get(accountId);
    if (latest !== current) {
      if (latest) return latest;
      throw new Error(`Photon account ${accountId} stopped before Spectrum app recreation`);
    }

    log?.warn?.("[photon] recreating Spectrum app after transport interruption");
    const next = await photonAppLifecycle.create(account);
    if (runningAccounts.get(accountId) !== current) {
      await photonAppLifecycle.stop(next).catch((error) => log?.warn?.(`[photon] superseded Spectrum app stop failed: ${String(error)}`));
      const newer = runningAccounts.get(accountId);
      if (newer) return newer;
      throw new Error(`Photon account ${accountId} stopped during Spectrum app recreation`);
    }

    // Space objects are tied to the old Spectrum client. Keep durable message
    // knowledge, but force fresh space resolution after reconnect.
    next.messages = current.messages;
    next.reactionMessages = current.reactionMessages;
    next.seenMessages = current.seenMessages;
    next.inflightMessages = current.inflightMessages;
    next.status = current.status;
    runningAccounts.set(accountId, next);
    await photonAppLifecycle.stop(current).catch((error) => log?.warn?.(`[photon] old Spectrum app stop failed: ${String(error)}`));
    log?.info?.(`[photon] recreated provider=${account.provider} local=${account.local}`);
    return next;
  })();

  recreationLocks.set(accountId, task);
  try {
    return await task;
  } finally {
    if (recreationLocks.get(accountId) === task) recreationLocks.delete(accountId);
  }
}

function accountStatus(accountId: string) {
  const running = runningAccounts.get(accountId);
  const persisted = getPhotonStatus(accountId);
  const runtimeStatus = running?.status ?? {};
  return {
    ...runtimeStatus,
    ...persisted,
    running: Boolean(running),
    cachedSpaces: running?.spaces.size ?? listPersistedSpaces(accountId).length,
    cachedMessages: running?.messages.size ?? undefined,
    cachedReactionHandles: running?.reactionMessages.size ?? undefined,
  };
}

function noteOutboundSuccess(accountId: string, result: { messageId: string; channelId: string }) {
  return updatePhotonStatus(accountId, {
    lastOutboundAt: Date.now(),
    lastOutboundMessageId: result.messageId,
    lastOutboundSpaceId: result.channelId,
    lastActionError: undefined,
    lastTransportErrorAt: undefined,
    lastTransportError: undefined,
    lastTransportRecoveryAt: Date.now(),
  });
}

function hasUnresolvedTransportError(status: ReturnType<typeof accountStatus>): boolean {
  const errorAt = status.lastTransportErrorAt ?? 0;
  if (!errorAt || !status.lastTransportError) return false;
  const recoveredAt = Math.max(status.lastTransportRecoveryAt ?? 0, status.lastOutboundAt ?? 0);
  return errorAt > recoveredAt;
}

function hasUnresolvedStreamReconnect(status: ReturnType<typeof accountStatus>): boolean {
  const reconnectAt = status.lastStreamReconnectAt ?? 0;
  if (!reconnectAt) return false;
  const recoveredAt = Math.max(status.lastTransportRecoveryAt ?? 0, status.lastInboundAt ?? 0, status.lastOutboundAt ?? 0);
  return reconnectAt > recoveredAt;
}

function noteActionFailure(accountId: string, error: unknown): void {
  updatePhotonStatus(accountId, { lastActionError: String(error) });
  if (isPhotonTransportError(error)) notePhotonTransportError(accountId, error);
}

function inboundBatchKey(accountId: string, spaceId: string, senderId: string): string {
  return `${accountId}\0${spaceId}\0${senderId}`;
}

function isBatchableInbound(params: {
  account: ResolvedPhotonAccount;
  message: Message;
  space: Space;
}): { batchable: boolean; senderId: string } {
  const normalized = normalizePhotonInbound(params);
  if (!normalized.spaceId || !normalized.messageId) return { batchable: false, senderId: normalized.senderId };
  if (params.message.direction === "outbound") return { batchable: false, senderId: normalized.senderId };
  if (isPhotonControlEventContent(params.message.content) && shouldIgnorePhotonControlEvent(params.account, params.message.content)) {
    return { batchable: false, senderId: normalized.senderId };
  }
  if (!normalized.rawBody) return { batchable: false, senderId: normalized.senderId };
  if (normalized.chatType === "direct" && isPhotonDirectCommandText(normalized.rawBody)) {
    return { batchable: false, senderId: normalized.senderId };
  }
  return { batchable: true, senderId: normalized.senderId };
}

function clearBatchTimers(batch: PendingInboundBatch): void {
  if (batch.flushTimer) clearTimeout(batch.flushTimer);
  if (batch.maxTimer) clearTimeout(batch.maxTimer);
  batch.flushTimer = undefined;
  batch.maxTimer = undefined;
}

function flushInboundBatch(key: string): void {
  const batch = inboundBatches.get(key);
  if (!batch) return;
  inboundBatches.delete(key);
  clearBatchTimers(batch);

  const batchedMessage = createBatchedPhotonMessage(batch.messages);
  const messageIds = batch.messages.map((message) => String(message?.id ?? "")).filter(Boolean);
  const running = runningAccounts.get(batch.account.accountId);
  if (!running) {
    for (const messageId of messageIds) releaseMessage(batch.running, messageId);
    batch.runtime.log?.(`[photon] dropped queued batch after account stopped messages=${messageIds.length}`);
    return;
  }
  const space = running.spaces.get(batch.space.id) ?? batch.space;
  const stopTyping = async () => {
    if (!batch.typingStarted || !batch.account.typingIndicators) return;
    await sendPhotonTyping(running, space.id, "stop").catch((error) => {
      batch.runtime.log?.(`photon: debounce typing stop failed: ${String(error)}`);
    });
  };

  void handlePhotonInbound({
    account: batch.account,
    cfg: batch.cfg,
    core: batch.core,
    running,
    space,
    message: batchedMessage,
    sendReply: batch.sendReply,
    createActions: () => createPhotonMessageActions(runningAccounts, {
      recreateRunning: (account, current) => replaceRunningPhotonApp(account, current),
    }),
    runtime: batch.runtime,
  }).then((result) => {
    for (const messageId of messageIds) {
      if (result.shouldAcknowledge) acknowledgeMessage(running, batch.account.accountId, messageId);
      else releaseMessage(running, messageId);
    }
    if (!result.accepted) {
      batch.runtime.log?.(`[photon] ignored space=${result.normalized.spaceId}: ${result.reason}`);
    }
  }).catch((error) => {
    for (const messageId of messageIds) releaseMessage(running, messageId);
    batch.runtime.error?.(`[photon] inbound handling failed: ${String(error)}`);
  }).finally(() => {
    void stopTyping();
  });
}

function enqueuePhotonInbound(params: Omit<PendingInboundBatch, "firstQueuedAt" | "flushTimer" | "maxTimer" | "messages"> & {
  message: Message;
}): void {
  const delayMs = params.account.inboundBatching ? params.account.inboundBatchDelayMs : 0;
  const maxDelayMs = Math.max(params.account.inboundBatchMaxDelayMs, delayMs);
  if (delayMs <= 0) {
    void handlePhotonInbound({
      account: params.account,
      cfg: params.cfg,
      core: params.core,
      running: params.running,
      space: params.space,
      message: params.message,
      sendReply: params.sendReply,
      createActions: () => createPhotonMessageActions(runningAccounts, {
        recreateRunning: (account, current) => replaceRunningPhotonApp(account, current),
      }),
      runtime: params.runtime,
    }).then((result) => {
      if (result.shouldAcknowledge) {
        acknowledgeMessage(params.running, params.account.accountId, String(params.message?.id ?? ""));
      } else {
        releaseMessage(params.running, String(params.message?.id ?? ""));
      }
      if (!result.accepted) {
        params.runtime.log?.(`[photon] ignored space=${result.normalized.spaceId}: ${result.reason}`);
      }
    }).catch((error) => {
      releaseMessage(params.running, String(params.message?.id ?? ""));
      params.runtime.error?.(`[photon] inbound handling failed: ${String(error)}`);
    });
    return;
  }

  const batchable = isBatchableInbound(params);
  if (!batchable.batchable) {
    enqueuePhotonInbound({ ...params, account: { ...params.account, inboundBatching: false } });
    return;
  }

  const key = inboundBatchKey(params.account.accountId, params.space.id, batchable.senderId);
  const now = Date.now();
  const batch = inboundBatches.get(key) ?? {
    account: params.account,
    cfg: params.cfg,
    core: params.core,
    firstQueuedAt: now,
    messages: [],
    runtime: params.runtime,
    running: params.running,
    sendReply: params.sendReply,
    space: params.space,
  };
  batch.account = params.account;
  batch.cfg = params.cfg;
  batch.core = params.core;
  batch.runtime = params.runtime;
  batch.running = params.running;
  batch.sendReply = params.sendReply;
  batch.space = params.space;
  batch.messages.push(params.message);
  inboundBatches.set(key, batch);

  if (batch.flushTimer) clearTimeout(batch.flushTimer);
  batch.flushTimer = setTimeout(() => flushInboundBatch(key), delayMs);
  batch.flushTimer.unref?.();
  if (!batch.maxTimer) {
    batch.maxTimer = setTimeout(() => flushInboundBatch(key), maxDelayMs);
    batch.maxTimer.unref?.();
  }

  if (params.account.typingIndicators && !batch.typingStarted) {
    batch.typingStarted = true;
    void sendPhotonTyping(params.running, params.space.id, "start").catch((error) => {
      params.runtime.log?.(`photon: debounce typing start failed: ${String(error)}`);
    });
  }
}

function clearInboundBatchesForAccount(accountId: string): void {
  for (const [key, batch] of inboundBatches) {
    if (batch.account.accountId !== accountId) continue;
    inboundBatches.delete(key);
    clearBatchTimers(batch);
    for (const message of batch.messages) releaseMessage(batch.running, String(message?.id ?? ""));
  }
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
  actions: createPhotonMessageActions(runningAccounts, {
    recreateRunning: (account, current) => replaceRunningPhotonApp(account, current),
  }),
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
      const unresolvedStreamReconnect = hasUnresolvedStreamReconnect(status);
      const unresolvedTransportError = hasUnresolvedTransportError(status);
      const unresolvedDeliveries = listUnresolvedPhotonDeliveries(resolvedAccountId, 30_000, 10);
      return {
        ok: status.running && !unresolvedStreamReconnect && !unresolvedTransportError && unresolvedDeliveries.length === 0,
        state: status.running ? "running" : "stopped",
        details: {
          ...status,
          unresolvedStreamReconnect,
          unresolvedTransportError,
          unresolvedDeliveries: unresolvedDeliveries.length,
          unresolvedDeliveryIds: unresolvedDeliveries.map((delivery) => delivery.id),
        },
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
        running.status = noteOutboundSuccess(account.accountId, result);
        return result;
      } catch (error) {
        noteActionFailure(account.accountId, error);
        running.status = accountStatus(account.accountId);
        if (account.provider !== "imessage" || account.local || !isPhotonTransportError(error)) throw error;
        running = await replaceRunningPhotonApp(account, running);
        try {
          const result = await sendPhotonRich(running, to, text.slice(0, account.textChunkLimit), [], {
            maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes,
          });
          running.status = noteOutboundSuccess(account.accountId, result);
          return result;
        } catch (retryError) {
          noteActionFailure(account.accountId, retryError);
          running.status = accountStatus(account.accountId);
          throw retryError;
        }
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
        running.status = noteOutboundSuccess(account.accountId, result);
        return result;
      } catch (error) {
        noteActionFailure(account.accountId, error);
        running.status = accountStatus(account.accountId);
        if (account.provider !== "imessage" || account.local || !isPhotonTransportError(error)) throw error;
        running = await replaceRunningPhotonApp(account, running);
        try {
          const result = await sendPhotonRich(
            running,
            to,
            String(text ?? "").slice(0, account.textChunkLimit),
            mediaUrl ? [String(mediaUrl)] : [],
            { maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes },
          );
          running.status = noteOutboundSuccess(account.accountId, result);
          return result;
        } catch (retryError) {
          noteActionFailure(account.accountId, retryError);
          running.status = accountStatus(account.accountId);
          throw retryError;
        }
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
              if (tryAcquireMessage(running!, account.accountId, String(message?.id ?? ""))) {
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
                enqueuePhotonInbound({
                  account,
                  cfg: ctx.cfg,
                  core,
                  running: running!,
                  space,
                  message,
                  sendReply: async ({ message: replyTo, space: replySpace, text, mediaUrls }) => {
                    try {
                      const result = await replyPhotonRich(replyTo, replySpace, text, mediaUrls, running!, {
                        maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes,
                      });
                      if (result) running!.status = noteOutboundSuccess(account.accountId, result);
                      return result;
                    } catch (error) {
                      noteActionFailure(account.accountId, error);
                      running!.status = accountStatus(account.accountId);
                      if (account.provider !== "imessage" || account.local || !isPhotonTransportError(error)) throw error;
                      ctx.log?.warn?.(`[photon] reply failed after transport drop; reconnecting and sending unthreaded fallback: ${String(error)}`);
                      running = await replaceRunningPhotonApp(account, running!, ctx.log);
                      const result = await sendPhotonRich(running!, replySpace.id, text, mediaUrls, {
                        maxOutboundAttachmentBytes: account.maxOutboundAttachmentBytes,
                      });
                      running!.status = noteOutboundSuccess(account.accountId, result);
                      return result;
                    }
                  },
                  runtime: {
                    log: (msg: string) => ctx.log?.info?.(msg),
                    error: (msg: string) => ctx.log?.error?.(msg),
                  },
                });
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
        clearInboundBatchesForAccount(account.accountId);
        notePhotonStopped(account.accountId);
        await photonAppLifecycle.stop(running);
        await loop.catch(() => undefined);
      });
    },
  },
};

export const __testing = {
  runningAccounts,
  recreationLocks,
  acknowledgeMessage,
  clearInboundBatchesForAccount,
  inboundBatches,
  isBatchableInbound,
  releaseMessage,
  replaceRunningPhotonApp,
  setPhotonAppLifecycleForTests(lifecycle: Partial<typeof photonAppLifecycle>) {
    const previous = { ...photonAppLifecycle };
    Object.assign(photonAppLifecycle, lifecycle);
    return () => Object.assign(photonAppLifecycle, previous);
  },
  tryAcquireMessage,
};
