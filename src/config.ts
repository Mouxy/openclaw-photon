import { DEFAULT_ACCOUNT_ID as _DEFAULT_ACCOUNT_ID, buildChannelConfigSchema } from "openclaw/plugin-sdk/core";
import { z } from "zod";
import { CHANNEL_ID, type PhotonAccountConfig, type ResolvedPhotonAccount } from "./types.js";

const DEFAULT_ACCOUNT_ID = _DEFAULT_ACCOUNT_ID ?? "default";

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeList(values: Array<string | number> | undefined): string[] {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function normalizeNames(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

const PhotonAccountSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    provider: z.enum(["imessage", "terminal"]).optional().default("imessage"),
    projectId: z.preprocess(trimmedString, z.string().optional()),
    projectSecret: z.preprocess(trimmedString, z.string().optional()),
    projectIdEnv: z.preprocess(trimmedString, z.string().optional().default("PHOTON_PROJECT_ID")),
    projectSecretEnv: z.preprocess(trimmedString, z.string().optional().default("PHOTON_PROJECT_SECRET")),
    local: z.boolean().optional().default(false),
    telemetry: z.boolean().optional().default(false),
    flattenGroups: z.boolean().optional().default(true),
    dmPolicy: z.enum(["allowlist", "pairing", "open", "disabled"]).optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional().default([]),
    groupPolicy: z.enum(["allowlist", "open", "disabled"]).optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional().default([]),
    requireMention: z.boolean().optional().default(true),
    mentionNames: z.array(z.string()).optional().default(["Ambrósio", "Ambrosio", "OpenClaw"]),
    textChunkLimit: z.number().int().positive().optional().default(4000),
    maxInboundAttachmentBytes: z.number().int().positive().optional().default(20 * 1024 * 1024),
    maxOutboundAttachmentBytes: z.number().int().positive().optional().default(50 * 1024 * 1024),
    sendReadReceipts: z.boolean().optional().default(true),
    dispatchControlEvents: z.boolean().optional().default(false),
    nativeActions: z.boolean().optional().default(true),
    dangerousNativeActions: z.boolean().optional().default(false),
    miniAppDefaults: z
      .object({
        appName: z.preprocess(trimmedString, z.string().optional()),
        appStoreId: z.number().int().positive().optional(),
        extensionBundleId: z.preprocess(trimmedString, z.string().optional()),
        teamId: z.preprocess(trimmedString, z.string().optional()),
        url: z.preprocess(trimmedString, z.string().optional()),
        caption: z.preprocess(trimmedString, z.string().optional()),
        subcaption: z.preprocess(trimmedString, z.string().optional()),
        trailingCaption: z.preprocess(trimmedString, z.string().optional()),
        trailingSubcaption: z.preprocess(trimmedString, z.string().optional()),
        summary: z.preprocess(trimmedString, z.string().optional()),
      })
      .optional()
      .default({}),
  })
  .passthrough();

export const PhotonConfigSchema = buildChannelConfigSchema(PhotonAccountSchema);

function parseAccount(input: unknown): PhotonAccountConfig {
  try {
    return PhotonAccountSchema.parse(input ?? {});
  } catch (err: any) {
    console.error("[photon] parseAccount failed:", err?.message ?? err);
    return PhotonAccountSchema.parse({});
  }
}

function readCredential(raw: string | undefined, envName: string | undefined): string | undefined {
  return raw || (envName ? trimmedString(process.env[envName]) : undefined);
}

export function listAccountIds(cfg: any): string[] {
  const section = cfg?.channels?.[CHANNEL_ID] ?? {};
  const accountIds = Object.keys(section.accounts ?? {});
  return accountIds.length ? accountIds : [DEFAULT_ACCOUNT_ID];
}

export function resolveAccount(cfg: any, accountId?: string | null): ResolvedPhotonAccount {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const section = cfg?.channels?.[CHANNEL_ID] ?? {};
  const raw =
    resolvedAccountId === DEFAULT_ACCOUNT_ID && !section.accounts?.[resolvedAccountId]
      ? parseAccount(section)
      : parseAccount(section.accounts?.[resolvedAccountId] ?? {});

  return {
    accountId: resolvedAccountId,
    enabled: raw.enabled ?? true,
    provider: raw.provider ?? "imessage",
    projectId: readCredential(raw.projectId, raw.projectIdEnv ?? "PHOTON_PROJECT_ID"),
    projectSecret: readCredential(raw.projectSecret, raw.projectSecretEnv ?? "PHOTON_PROJECT_SECRET"),
    local: raw.local ?? false,
    telemetry: raw.telemetry ?? false,
    flattenGroups: raw.flattenGroups ?? true,
    dmPolicy: raw.dmPolicy ?? "pairing",
    allowFrom: normalizeList(raw.allowFrom),
    groupPolicy: raw.groupPolicy ?? "allowlist",
    groupAllowFrom: normalizeList(raw.groupAllowFrom),
    requireMention: raw.requireMention ?? true,
    mentionNames: normalizeNames(raw.mentionNames),
    textChunkLimit: raw.textChunkLimit ?? 4000,
    maxInboundAttachmentBytes: raw.maxInboundAttachmentBytes ?? 20 * 1024 * 1024,
    maxOutboundAttachmentBytes: raw.maxOutboundAttachmentBytes ?? 50 * 1024 * 1024,
    sendReadReceipts: raw.sendReadReceipts ?? true,
    dispatchControlEvents: raw.dispatchControlEvents ?? false,
    nativeActions: raw.nativeActions ?? true,
    dangerousNativeActions: raw.dangerousNativeActions ?? false,
    miniAppDefaults: raw.miniAppDefaults ?? {},
  };
}
