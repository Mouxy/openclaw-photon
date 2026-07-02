import { createClient, type AdvancedIMessage } from "@photon-ai/advanced-imessage";
import { cloud, type Space } from "spectrum-ts";
import type { ResolvedPhotonAccount } from "./types.js";

// The advanced client resolves its `token` option per RPC (auth middleware),
// so gRPC channels can stay open across actions while token issuance is
// memoized briefly — instead of issuing tokens and building + tearing down
// every channel on each advanced action (polls, stickers, text effects,
// edit/unsend fallbacks).
const ADVANCED_TOKEN_TTL_MS = 45_000;

type AdvancedClientEntry = { phone: string; client: AdvancedIMessage };

type AccountAdvancedState = {
  clients?: AdvancedClientEntry[];
  tokenCache?: { data: any; fetchedAt: number };
};

const stateByAccount = new Map<string, AccountAdvancedState>();

function isAdvancedTransportError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? "");
  return (
    message.includes("ECONNRESET") ||
    message.includes("UNAVAILABLE") ||
    message.includes("DEADLINE_EXCEEDED") ||
    message.includes("ConnectionError") ||
    message.includes("Connection dropped") ||
    message.includes("stream interrupted")
  );
}

export function advancedSpacePhone(space: Space): string | undefined {
  const phone = String((space as any).phone ?? "").trim();
  return phone || undefined;
}

export function advancedChatId(space: Space): string {
  const id = String(space.id ?? "").trim();
  if (!id) throw new Error("Photon advanced iMessage action could not resolve a chat id.");
  return id;
}

/** Split a spectrum child message id (`p:<part>/<guid>`) into its advanced-SDK target. */
export function advancedTargetMessage(messageId: string): { messageGuid: string; partIndex?: number } {
  const match = String(messageId ?? "").trim().match(/^p:(\d+)\/(.+)$/);
  if (!match) return { messageGuid: String(messageId ?? "").trim() };
  return { messageGuid: match[2]!, partIndex: Number(match[1]) };
}

async function issueTokens(account: ResolvedPhotonAccount, state: AccountAdvancedState): Promise<any> {
  const now = Date.now();
  if (state.tokenCache && now - state.tokenCache.fetchedAt < ADVANCED_TOKEN_TTL_MS) {
    return state.tokenCache.data;
  }
  const data: any = await cloud.issueImessageTokens(account.projectId!, account.projectSecret!);
  state.tokenCache = { data, fetchedAt: now };
  return data;
}

async function buildClients(account: ResolvedPhotonAccount, state: AccountAdvancedState): Promise<AdvancedClientEntry[]> {
  const tokenData = await issueTokens(account, state);
  const clients: AdvancedClientEntry[] = [];

  if (tokenData.type === "shared") {
    const address = process.env.SPECTRUM_IMESSAGE_ADDRESS ?? "imessage.spectrum.photon.codes:443";
    clients.push({
      phone: "shared",
      client: createClient({
        address,
        tls: true,
        token: async () => (await issueTokens(account, state)).token,
      }),
    });
  } else {
    const numbers = tokenData.numbers ?? {};
    for (const instanceId of Object.keys(tokenData.auth ?? {})) {
      const phone = String(numbers[instanceId] ?? "");
      if (!phone) continue;
      clients.push({
        phone,
        client: createClient({
          address: `${instanceId}.imsg.photon.codes:443`,
          tls: true,
          token: async () => String((await issueTokens(account, state))?.auth?.[instanceId] ?? ""),
        }),
      });
    }
  }

  if (clients.length === 0) throw new Error("Photon could not create an advanced iMessage client.");
  return clients;
}

export async function closeAdvancedClients(accountId: string): Promise<void> {
  const state = stateByAccount.get(accountId);
  stateByAccount.delete(accountId);
  if (state?.clients) {
    await Promise.allSettled(state.clients.map(({ client }) => client.close()));
  }
}

export async function withAdvancedIMessageClient<T>(
  account: ResolvedPhotonAccount,
  space: Space,
  fn: (client: AdvancedIMessage) => Promise<T>,
): Promise<T> {
  if (account.local) throw new Error("Photon advanced iMessage actions require remote/cloud iMessage mode.");
  if (!account.projectId || !account.projectSecret) {
    throw new Error("Photon advanced iMessage actions require Photon projectId/projectSecret credentials.");
  }

  let state = stateByAccount.get(account.accountId);
  if (!state) {
    state = {};
    stateByAccount.set(account.accountId, state);
  }
  if (!state.clients) {
    state.clients = await buildClients(account, state);
  }

  const phone = advancedSpacePhone(space);
  const entry = state.clients.length === 1 || state.clients[0]?.phone === "shared"
    ? state.clients[0]
    : state.clients.find((candidate) => candidate.phone === phone);
  if (!entry) {
    throw new Error(`Photon could not find an advanced iMessage client for phone ${phone ?? "<unknown>"}.`);
  }

  try {
    return await fn(entry.client);
  } catch (error) {
    // A dead channel would poison every later action; reconnect fresh next
    // call. Dedicated-mode instance ids can also change when a line moves, so
    // rebuilding on transport failure covers re-routing too.
    if (isAdvancedTransportError(error)) await closeAdvancedClients(account.accountId);
    throw error;
  }
}
