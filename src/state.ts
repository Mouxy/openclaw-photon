import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  PhotonPersistedMessage,
  PhotonPersistedReaction,
  PhotonDeliveryRecord,
  PhotonRuntimeStatus,
  PhotonPersistedSpace,
} from "./types.js";

type AccountState = {
  spaces: Record<string, PhotonPersistedSpace>;
  messages: Record<string, PhotonPersistedMessage>;
  latestBySpace: Record<string, string>;
  latestInboundBySpace: Record<string, string>;
  latestOutboundBySpace: Record<string, string>;
  processedMessages: Record<string, { updatedAt: number }>;
  reactions: Record<string, PhotonPersistedReaction>;
  deliveries: Record<string, PhotonDeliveryRecord>;
  status?: PhotonRuntimeStatus;
};

type PhotonState = {
  version: 1;
  accounts: Record<string, AccountState>;
};

const MAX_SPACES = 1000;
const MAX_MESSAGES = 3000;
const MAX_PROCESSED_MESSAGES = 4000;
const MAX_REACTIONS = 1000;
const MAX_DELIVERIES = 1000;

let cachedState: PhotonState | undefined;

function statePath(): string {
  const openclawHome = process.env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "state", "photon", "state.json");
}

function emptyState(): PhotonState {
  return { version: 1, accounts: {} };
}

function emptyAccountState(): AccountState {
  return {
    spaces: {},
    messages: {},
    latestBySpace: {},
    latestInboundBySpace: {},
    latestOutboundBySpace: {},
    processedMessages: {},
    reactions: {},
    deliveries: {},
  };
}

function readState(): PhotonState {
  if (cachedState) return cachedState;
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as PhotonState;
    cachedState = parsed?.version === 1 && parsed.accounts ? parsed : emptyState();
  } catch {
    cachedState = emptyState();
  }
  return cachedState;
}

function accountState(accountId: string): AccountState {
  const state = readState();
  state.accounts[accountId] ??= emptyAccountState();
  state.accounts[accountId]!.spaces ??= {};
  state.accounts[accountId]!.messages ??= {};
  state.accounts[accountId]!.latestBySpace ??= {};
  state.accounts[accountId]!.latestInboundBySpace ??= {};
  state.accounts[accountId]!.latestOutboundBySpace ??= {};
  state.accounts[accountId]!.processedMessages ??= {};
  state.accounts[accountId]!.reactions ??= {};
  state.accounts[accountId]!.deliveries ??= {};
  return state.accounts[accountId]!;
}

function writeState(): void {
  if (!cachedState) return;
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cachedState, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function pruneRecord<T extends { updatedAt: number }>(record: Record<string, T>, max: number): void {
  const entries = Object.entries(record);
  if (entries.length <= max) return;
  entries
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(max)
    .forEach(([key]) => {
      delete record[key];
    });
}

function pruneAccount(account: AccountState): void {
  pruneRecord(account.spaces, MAX_SPACES);
  pruneRecord(account.messages, MAX_MESSAGES);
  pruneRecord(account.processedMessages, MAX_PROCESSED_MESSAGES);
  pruneRecord(account.reactions, MAX_REACTIONS);
  pruneRecord(account.deliveries, MAX_DELIVERIES);
  const latestMaps = [
    account.latestBySpace,
    account.latestInboundBySpace,
    account.latestOutboundBySpace,
  ];
  for (const latest of latestMaps) for (const [spaceId, messageId] of Object.entries(latest)) {
    const message = account.messages[messageId];
    if (!message || message.spaceId !== spaceId) delete latest[spaceId];
  }
}

export function rememberPersistedSpace(accountId: string, space: PhotonPersistedSpace): void {
  const account = accountState(accountId);
  const existing = account.spaces[space.id];
  account.spaces[space.id] = {
    ...existing,
    ...space,
    updatedAt: Math.max(existing?.updatedAt ?? 0, space.updatedAt),
  };
  pruneAccount(account);
  writeState();
}

export function rememberPersistedMessage(accountId: string, message: PhotonPersistedMessage): void {
  const account = accountState(accountId);
  account.messages[message.id] = { ...account.messages[message.id], ...message };
  account.latestBySpace[message.spaceId] = message.id;
  if (message.direction === "inbound") account.latestInboundBySpace[message.spaceId] = message.id;
  if (message.direction === "outbound") account.latestOutboundBySpace[message.spaceId] = message.id;
  pruneAccount(account);
  writeState();
}

export function rememberPersistedReaction(accountId: string, reaction: PhotonPersistedReaction): void {
  const account = accountState(accountId);
  account.reactions[reaction.key] = reaction;
  pruneAccount(account);
  writeState();
}

export function forgetPersistedReaction(accountId: string, key: string): void {
  const account = accountState(accountId);
  delete account.reactions[key];
  writeState();
}

export function rememberPhotonDelivery(
  accountId: string,
  record: Omit<PhotonDeliveryRecord, "updatedAt"> & { updatedAt?: number },
): PhotonDeliveryRecord {
  const account = accountState(accountId);
  const existing = account.deliveries[record.id];
  const next: PhotonDeliveryRecord = {
    ...existing,
    ...record,
    outboundMessageIds: record.outboundMessageIds ?? existing?.outboundMessageIds,
    updatedAt: record.updatedAt ?? Date.now(),
  };
  account.deliveries[record.id] = next;
  pruneAccount(account);
  writeState();
  return next;
}

export function updatePhotonDelivery(
  accountId: string,
  id: string,
  patch: Partial<Omit<PhotonDeliveryRecord, "id" | "inboundMessageId" | "spaceId" | "receivedAt">>,
): PhotonDeliveryRecord | undefined {
  const account = accountState(accountId);
  const existing = account.deliveries[id];
  if (!existing) return undefined;
  const next: PhotonDeliveryRecord = {
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };
  account.deliveries[id] = next;
  writeState();
  return next;
}

export function getPhotonDelivery(accountId: string, id: string): PhotonDeliveryRecord | undefined {
  return accountState(accountId).deliveries[id];
}

export function listPhotonDeliveries(accountId: string, limit = 20): PhotonDeliveryRecord[] {
  return Object.values(accountState(accountId).deliveries)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, limit));
}

export function getPersistedMessage(accountId: string, messageId: string): PhotonPersistedMessage | undefined {
  return accountState(accountId).messages[messageId];
}

export function rememberProcessedPersistedMessage(accountId: string, messageId: string): void {
  const id = messageId.trim();
  if (!id) return;
  const account = accountState(accountId);
  account.processedMessages[id] = { updatedAt: Date.now() };
  pruneAccount(account);
  writeState();
}

export function hasProcessedPersistedMessage(accountId: string, messageId: string): boolean {
  const id = messageId.trim();
  return Boolean(id && accountState(accountId).processedMessages[id]);
}

export function getLatestPersistedMessageForSpace(
  accountId: string,
  spaceId: string,
  direction: "inbound" | "outbound" | "any" = "any",
): PhotonPersistedMessage | undefined {
  const account = accountState(accountId);
  const messageId =
    direction === "inbound"
      ? account.latestInboundBySpace[spaceId] ?? account.latestBySpace[spaceId]
      : direction === "outbound"
        ? account.latestOutboundBySpace[spaceId] ?? account.latestBySpace[spaceId]
        : account.latestBySpace[spaceId];
  return messageId ? account.messages[messageId] : undefined;
}

export function getPersistedReaction(accountId: string, key: string): PhotonPersistedReaction | undefined {
  return accountState(accountId).reactions[key];
}

export function listPersistedSpaces(accountId: string): PhotonPersistedSpace[] {
  return Object.values(accountState(accountId).spaces).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getPhotonStatus(accountId: string): PhotonRuntimeStatus {
  return accountState(accountId).status ?? { running: false, updatedAt: 0 };
}

export function updatePhotonStatus(accountId: string, patch: Partial<PhotonRuntimeStatus>): PhotonRuntimeStatus {
  const account = accountState(accountId);
  const previous = account.status ?? { running: false, updatedAt: 0 };
  const next: PhotonRuntimeStatus = {
    ...previous,
    ...patch,
    updatedAt: Date.now(),
  };
  account.status = next;
  writeState();
  return next;
}

export function notePhotonStarted(accountId: string): PhotonRuntimeStatus {
  const now = Date.now();
  return updatePhotonStatus(accountId, {
    running: true,
    startedAt: now,
    stoppedAt: undefined,
    lastStreamReconnectAt: undefined,
    streamReconnectCount: 0,
    lastStreamError: undefined,
  });
}

export function notePhotonStopped(accountId: string): PhotonRuntimeStatus {
  return updatePhotonStatus(accountId, {
    running: false,
    stoppedAt: Date.now(),
  });
}

export function notePhotonInbound(accountId: string, message: { id: string; spaceId: string }): PhotonRuntimeStatus {
  return updatePhotonStatus(accountId, {
    lastInboundAt: Date.now(),
    lastInboundMessageId: message.id,
    lastInboundSpaceId: message.spaceId,
  });
}

export function notePhotonOutbound(accountId: string, message: { id?: string; spaceId?: string }): PhotonRuntimeStatus {
  return updatePhotonStatus(accountId, {
    lastOutboundAt: Date.now(),
    lastOutboundMessageId: message.id,
    lastOutboundSpaceId: message.spaceId,
  });
}

export function notePhotonStreamReconnect(accountId: string, error?: unknown): PhotonRuntimeStatus {
  const previous = getPhotonStatus(accountId);
  return updatePhotonStatus(accountId, {
    lastStreamReconnectAt: Date.now(),
    streamReconnectCount: (previous.streamReconnectCount ?? 0) + 1,
    lastStreamError: error == null ? previous.lastStreamError : String(error),
  });
}

export function notePhotonMediaError(accountId: string, error: unknown): PhotonRuntimeStatus {
  return updatePhotonStatus(accountId, { lastMediaError: String(error) });
}

export function notePhotonActionError(accountId: string, error: unknown): PhotonRuntimeStatus {
  return updatePhotonStatus(accountId, { lastActionError: String(error) });
}

export function notePhotonUnsupportedContent(accountId: string, contentType: string): PhotonRuntimeStatus {
  return updatePhotonStatus(accountId, { lastUnsupportedContent: contentType });
}
