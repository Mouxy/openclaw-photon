import type { Message, Space, SpectrumInstance } from "spectrum-ts";

export const CHANNEL_ID = "photon";

export type PhotonProvider = "imessage" | "terminal";
export type DmPolicy = "allowlist" | "pairing" | "open" | "disabled";
export type GroupPolicy = "allowlist" | "open" | "disabled";

export interface PhotonMiniAppDefaults {
  appName?: string;
  appStoreId?: number;
  extensionBundleId?: string;
  teamId?: string;
  url?: string;
  caption?: string;
  subcaption?: string;
  trailingCaption?: string;
  trailingSubcaption?: string;
  imageTitle?: string;
  imageSubtitle?: string;
  summary?: string;
}

export interface PhotonAccountConfig {
  enabled?: boolean;
  provider?: PhotonProvider;
  projectId?: string;
  projectSecret?: string;
  projectIdEnv?: string;
  projectSecretEnv?: string;
  local?: boolean;
  telemetry?: boolean;
  flattenGroups?: boolean;
  dmPolicy?: DmPolicy;
  allowFrom?: Array<string | number>;
  groupPolicy?: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  requireMention?: boolean;
  mentionNames?: string[];
  textChunkLimit?: number;
  maxInboundAttachmentBytes?: number;
  maxOutboundAttachmentBytes?: number;
  sendReadReceipts?: boolean;
  typingIndicators?: boolean;
  progressUpdates?: boolean;
  dispatchControlEvents?: boolean;
  dispatchPollVotes?: boolean;
  nativeActions?: boolean;
  dangerousNativeActions?: boolean;
  miniAppDefaults?: PhotonMiniAppDefaults;
}

export interface ResolvedPhotonAccount {
  accountId: string;
  enabled: boolean;
  provider: PhotonProvider;
  projectId?: string;
  projectSecret?: string;
  local: boolean;
  telemetry: boolean;
  flattenGroups: boolean;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groupPolicy: GroupPolicy;
  groupAllowFrom: string[];
  requireMention: boolean;
  mentionNames: string[];
  textChunkLimit: number;
  maxInboundAttachmentBytes: number;
  maxOutboundAttachmentBytes: number;
  sendReadReceipts: boolean;
  typingIndicators: boolean;
  progressUpdates: boolean;
  dispatchControlEvents: boolean;
  dispatchPollVotes: boolean;
  nativeActions: boolean;
  dangerousNativeActions: boolean;
  miniAppDefaults: PhotonMiniAppDefaults;
}

export interface PhotonNormalizedInbound {
  provider: typeof CHANNEL_ID;
  accountId: string;
  platform: string;
  spaceId: string;
  spaceLabel: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  rawBody: string;
  chatType: "direct" | "group";
  wasMentioned: boolean;
  timestamp: number;
}

export interface RunningPhotonAccount {
  accountId: string;
  app: SpectrumInstance;
  spaces: Map<string, Space>;
  messages: Map<string, Message>;
  reactionMessages: Map<string, string>;
  seenMessages: Map<string, number>;
  status: PhotonRuntimeStatus;
}

export interface PhotonPersistedSpace {
  id: string;
  platform?: string;
  type?: "direct" | "group";
  phone?: string;
  label?: string;
  updatedAt: number;
}

export interface PhotonPersistedMessage {
  id: string;
  spaceId: string;
  platform?: string;
  direction?: "inbound" | "outbound";
  senderId?: string;
  contentType?: string;
  timestamp?: number;
  updatedAt: number;
}

export interface PhotonPersistedReaction {
  key: string;
  spaceId: string;
  targetMessageId: string;
  emoji: string;
  reactionMessageId: string;
  updatedAt: number;
}

export type PhotonDeliveryStatus = "received" | "accepted" | "ignored" | "replied" | "failed";

export interface PhotonDeliveryRecord {
  id: string;
  inboundMessageId: string;
  spaceId: string;
  platform?: string;
  senderId?: string;
  chatType?: "direct" | "group";
  bodyPreview?: string;
  status: PhotonDeliveryStatus;
  reason?: string;
  error?: string;
  outboundMessageIds?: string[];
  receivedAt: number;
  acceptedAt?: number;
  ignoredAt?: number;
  repliedAt?: number;
  failedAt?: number;
  updatedAt: number;
}

export interface PhotonRuntimeStatus {
  running: boolean;
  startedAt?: number;
  stoppedAt?: number;
  lastStartAttemptAt?: number;
  lastStartError?: string;
  nextStartRetryAt?: number;
  startAttemptCount?: number;
  lastInboundAt?: number;
  lastInboundMessageId?: string;
  lastInboundSpaceId?: string;
  lastOutboundAt?: number;
  lastOutboundMessageId?: string;
  lastOutboundSpaceId?: string;
  lastStreamReconnectAt?: number;
  streamReconnectCount?: number;
  lastStreamError?: string;
  lastMediaError?: string;
  lastActionError?: string;
  lastUnsupportedContent?: string;
  updatedAt: number;
}
