import type { ChannelSetupWizard, WizardPrompter } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID as _DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import {
  getIMessageLine,
  getSubscriptionTier,
  isE164,
  registerUserIfAbsent,
  runPhotonDeviceLogin,
  userAssignedLine,
} from "./deviceAuth.js";
import { listAccountIds, resolveAccount } from "./config.js";
import { CHANNEL_ID } from "./types.js";

const DEFAULT_ACCOUNT_ID = _DEFAULT_ACCOUNT_ID ?? "default";
const PROJECT_NAME = "OpenClaw";
// Photon plan tiers that include native mini-app cards.
const MINI_APP_TIERS = new Set(["business", "enterprise"]);

export type PhotonSetupWizardDeps = {
  runDeviceLogin: typeof runPhotonDeviceLogin;
  detectTier: (projectId: string) => Promise<string | undefined>;
};

function rawAccountConfig(cfg: any, accountId: string): Record<string, unknown> {
  const section = cfg?.channels?.[CHANNEL_ID] ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID && !section.accounts?.[accountId]) return section;
  return section.accounts?.[accountId] ?? {};
}

function patchPhotonAccountConfig(cfg: any, accountId: string, patch: Record<string, unknown>): any {
  const channels = { ...(cfg?.channels ?? {}) };
  const section = { ...(channels[CHANNEL_ID] ?? {}) };
  const fullPatch = { enabled: true, ...patch };
  if (accountId === DEFAULT_ACCOUNT_ID && !section.accounts?.[accountId]) {
    Object.assign(section, fullPatch);
  } else {
    const accounts = { ...(section.accounts ?? {}) };
    accounts[accountId] = { ...(accounts[accountId] ?? {}), ...fullPatch };
    section.accounts = accounts;
  }
  channels[CHANNEL_ID] = section;
  return { ...cfg, channels };
}

function isPhotonConfigured(cfg: any, accountId: string): boolean {
  const account = resolveAccount(cfg, accountId);
  return Boolean(account.local || (account.projectId && account.projectSecret));
}

async function registerOperatorNumber(params: {
  prompter: WizardPrompter;
  token: string;
  projectId: string;
  projectSecret: string;
}): Promise<void> {
  const { prompter, token, projectId, projectSecret } = params;
  const phone = (
    await prompter.text({
      message: "Your iMessage phone number, to register you with this Photon project (Enter to skip)",
      placeholder: "+15551234567",
      validate: (value) => (!value.trim() || isE164(value) ? undefined : "Use E.164 format, e.g. +15551234567"),
    })
  ).trim();
  if (!phone) return;

  const progress = prompter.progress("Registering your number with Photon…");
  try {
    const { user, created } = await registerUserIfAbsent(projectId, projectSecret, phone);
    let assigned = userAssignedLine(user);
    if (!assigned) {
      progress.update("Looking up the project's iMessage line…");
      const line = await getIMessageLine(token, projectId);
      assigned = line?.phoneNumber ? String(line.phoneNumber) : undefined;
    }
    progress.stop(created ? "Registered your number with Photon." : "Your number was already registered.");
    await prompter.note(
      assigned
        ? `Text the agent at ${assigned} from ${phone} to start chatting.`
        : "Photon has not assigned an iMessage line yet — check the Photon dashboard (app.photon.codes) for the number to text.",
      "iMessage line",
    );
  } catch (error) {
    progress.stop("Could not register your number.");
    await prompter.note(
      `Photon user registration failed: ${String((error as any)?.message ?? error)}\n` +
        "You can register your number later from the Photon dashboard.",
      "Photon",
    );
  }
}

async function runDeviceLoginStep(params: {
  prompter: WizardPrompter;
  cfg: any;
  accountId: string;
  runDeviceLogin: typeof runPhotonDeviceLogin;
}): Promise<{ cfg: any; credentialValues: Record<string, string> } | undefined> {
  const { prompter, cfg, accountId } = params;
  let progress: ReturnType<WizardPrompter["progress"]> | undefined;
  try {
    const login = await params.runDeviceLogin({
      projectName: PROJECT_NAME,
      onUserCode: async (code) => {
        await prompter.note(
          [
            `1. Open ${code.verificationUriComplete ?? code.verificationUri}`,
            `2. Confirm the code: ${code.userCode}`,
            "3. Approve the login for this device.",
          ].join("\n"),
          "Photon device login",
        );
        progress = prompter.progress("Waiting for approval in the browser…");
      },
      onStatus: (message) => progress?.update(message),
    });
    progress?.stop("Photon project ready.");
    await registerOperatorNumber({
      prompter,
      token: login.token,
      projectId: login.projectId,
      projectSecret: login.projectSecret,
    });
    return {
      cfg: patchPhotonAccountConfig(cfg, accountId, {
        projectId: login.projectId,
        projectSecret: login.projectSecret,
      }),
      credentialValues: { name: login.projectId, secret: login.projectSecret },
    };
  } catch (error) {
    progress?.stop("Photon device login failed.");
    await prompter.note(
      `${String((error as any)?.message ?? error)}\nFalling back to manual credential entry.`,
      "Photon device login failed",
    );
    return undefined;
  }
}

async function configureMiniAppDefaults(params: {
  prompter: WizardPrompter;
  cfg: any;
  accountId: string;
  credentialValues: Record<string, string | undefined>;
  detectTier: PhotonSetupWizardDeps["detectTier"];
}): Promise<{ cfg: any } | undefined> {
  const { prompter, cfg, accountId, credentialValues, detectTier } = params;
  const account = resolveAccount(cfg, accountId);
  if (account.local || account.provider !== "imessage") return undefined;
  const projectId = credentialValues.name ?? account.projectId;
  if (!projectId) return undefined;
  const existing = (rawAccountConfig(cfg, accountId).miniAppDefaults ?? {}) as Record<string, unknown>;
  if (existing.extensionBundleId || existing.teamId) return undefined;

  const tier = await detectTier(projectId);
  if (tier && !MINI_APP_TIERS.has(tier)) {
    await prompter.note(
      [
        `This project is on Photon's "${tier}" plan. Native mini-app cards`,
        "(sendMiniApp / sendStatusCard) need a business-tier Photon account —",
        "upgrade at app.photon.codes and re-run setup to configure them.",
        "Everything else (text, media, reactions, edits, polls…) works on any plan.",
      ].join("\n"),
      "Mini-app cards",
    );
    return undefined;
  }

  const hasBusiness = tier
    ? true
    : await prompter.confirm({
        message: "Do you have a business Photon account? (needed for native mini-app cards)",
        initialValue: false,
      });
  if (!hasBusiness) {
    await prompter.note(
      [
        "Skipping mini-app card defaults. sendMiniApp / sendStatusCard need a",
        "business-tier Photon account plus an Apple iMessage extension; you can",
        "add channels.photon.miniAppDefaults later or re-run setup.",
      ].join("\n"),
      "Mini-app cards",
    );
    return undefined;
  }

  const configure = await prompter.confirm({
    message: tier
      ? `Photon "${tier}" plan detected — configure mini-app card defaults now?`
      : "Configure mini-app card defaults now?",
    initialValue: true,
  });
  if (!configure) return undefined;

  await prompter.note(
    [
      "These come from the Apple Developer account backing your Photon",
      "business registration: the 10-character Team ID, the iMessage",
      "extension's bundle identifier, and the https URL the card opens.",
    ].join("\n"),
    "Mini-app card defaults",
  );
  const appName = (
    await prompter.text({
      message: "Mini-app display name",
      initialValue: PROJECT_NAME,
      validate: (value) => (value.trim() ? undefined : "A display name is required"),
    })
  ).trim();
  const teamId = (
    await prompter.text({
      message: "Apple Team ID",
      placeholder: "ABCDE12345",
      validate: (value) => (/^[A-Z0-9]{10}$/.test(value.trim()) ? undefined : "Team IDs are 10 uppercase letters/digits"),
    })
  ).trim();
  const extensionBundleId = (
    await prompter.text({
      message: "iMessage extension bundle id",
      placeholder: "com.example.App.MessagesExtension",
      validate: (value) => (/^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(value.trim()) ? undefined : "Use a reverse-DNS bundle identifier"),
    })
  ).trim();
  const url = (
    await prompter.text({
      message: "Default card URL",
      placeholder: "https://example.com/card",
      validate: (value) => (/^https:\/\/\S+$/.test(value.trim()) ? undefined : "Use an https:// URL"),
    })
  ).trim();

  return {
    cfg: patchPhotonAccountConfig(cfg, accountId, {
      miniAppDefaults: { appName, teamId, extensionBundleId, url },
    }),
  };
}

export function createPhotonSetupWizard(overrides: Partial<PhotonSetupWizardDeps> = {}): ChannelSetupWizard {
  const deps: PhotonSetupWizardDeps = {
    runDeviceLogin: overrides.runDeviceLogin ?? runPhotonDeviceLogin,
    detectTier: overrides.detectTier ?? ((projectId) => getSubscriptionTier(projectId)),
  };
  return {
  channel: CHANNEL_ID,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs Photon project credentials",
    resolveConfigured: ({ cfg, accountId }: any) =>
      accountId
        ? isPhotonConfigured(cfg, accountId)
        : listAccountIds(cfg).some((candidate) => isPhotonConfigured(cfg, candidate)),
    resolveStatusLines: ({ cfg }: any) => [`Accounts: ${listAccountIds(cfg).length || 0}`],
  },
  introNote: {
    title: "Photon (iMessage via Spectrum)",
    lines: [
      "Photon connects OpenClaw to iMessage through Spectrum Cloud.",
      "The recommended path signs in with a device code and provisions a",
      `project named "${PROJECT_NAME}" automatically — no manual dashboard visit needed.`,
      "Manual entry expects a project id + secret from app.photon.codes.",
    ],
  },
  prepare: async ({ cfg, accountId, prompter }: any) => {
    const account = resolveAccount(cfg, accountId);
    const alreadyConfigured = Boolean(account.projectId && account.projectSecret);
    const method = await prompter.select({
      message: alreadyConfigured
        ? "Photon credentials found. How do you want to proceed?"
        : "How do you want to connect Photon?",
      options: [
        ...(alreadyConfigured
          ? [{ value: "keep", label: "Keep the existing project credentials" }]
          : []),
        {
          value: "device",
          label: "Log in with a device code (recommended)",
          hint: alreadyConfigured
            ? "Rotates the project secret — other consumers of this project must be updated"
            : "Approve in the browser; project + secret are provisioned automatically",
        },
        { value: "manual", label: "Enter a project id and secret manually" },
      ],
      initialValue: alreadyConfigured ? "keep" : "device",
    });
    if (method === "keep") {
      return {
        credentialValues: {
          name: account.projectId!,
          secret: account.projectSecret!,
        },
      };
    }
    if (method !== "device") return undefined;
    return await runDeviceLoginStep({ prompter, cfg, accountId, runDeviceLogin: deps.runDeviceLogin });
  },
  credentials: [
    {
      inputKey: "secret",
      providerHint: CHANNEL_ID,
      credentialLabel: "Photon project secret",
      preferredEnvVar: "PHOTON_PROJECT_SECRET",
      helpTitle: "Photon project secret",
      helpLines: [
        "Create or open your project at https://app.photon.codes and use",
        "Regenerate Secret — the dashboard shows the secret exactly once.",
      ],
      envPrompt: "Use PHOTON_PROJECT_SECRET from the environment?",
      keepPrompt: "Keep the configured Photon project secret?",
      inputPrompt: "Photon project secret",
      allowEnv: ({ accountId }: any) => accountId === DEFAULT_ACCOUNT_ID,
      inspect: ({ cfg, accountId }: any) => {
        const raw = rawAccountConfig(cfg, accountId);
        const account = resolveAccount(cfg, accountId);
        return {
          accountConfigured: isPhotonConfigured(cfg, accountId),
          hasConfiguredValue: Boolean(String(raw.projectSecret ?? "").trim()),
          resolvedValue: account.projectSecret,
          envValue: accountId === DEFAULT_ACCOUNT_ID ? process.env.PHOTON_PROJECT_SECRET?.trim() || undefined : undefined,
        };
      },
      shouldPrompt: ({ credentialValues }: any) => !credentialValues.secret,
      applyUseEnv: ({ cfg, accountId }: any) => patchPhotonAccountConfig(cfg, accountId, { projectSecret: undefined }),
      applySet: ({ cfg, accountId, resolvedValue }: any) =>
        patchPhotonAccountConfig(cfg, accountId, { projectSecret: resolvedValue }),
    },
  ],
  textInputs: [
    {
      inputKey: "name",
      message: "Photon project id",
      placeholder: "proj_…",
      helpTitle: "Photon project id",
      helpLines: ["The project id from https://app.photon.codes — the same value spectrum-ts uses as projectId."],
      currentValue: ({ cfg, accountId, credentialValues }: any) =>
        credentialValues.name ?? (String(rawAccountConfig(cfg, accountId).projectId ?? "").trim() || undefined),
      shouldPrompt: ({ credentialValues }: any) => !credentialValues.name,
      keepPrompt: (value: string) => `Keep Photon project id ${value}?`,
      applySet: ({ cfg, accountId, value }: any) =>
        patchPhotonAccountConfig(cfg, accountId, { projectId: value.trim() }),
    },
  ],
  finalize: async ({ cfg, accountId, credentialValues, prompter }: any) => {
    const result = await configureMiniAppDefaults({
      prompter,
      cfg,
      accountId,
      credentialValues,
      detectTier: deps.detectTier,
    });
    return result ?? undefined;
  },
  completionNote: {
    title: "Photon",
    lines: [
      "iMessage senders are pairing-gated by default (dmPolicy: pairing).",
      "Group chats work too: add group space ids to groupAllowFrom (groupPolicy",
      'defaults to "allowlist") and mention the agent by name to trigger it.',
      "Approve new senders with: openclaw pairing approve photon <code>",
      "Run the photonDoctor message action any time to check channel health.",
    ],
  },
  disable: (cfg: any) => patchPhotonAccountConfig(cfg, DEFAULT_ACCOUNT_ID, { enabled: false }),
  };
}

export const photonSetupWizard: ChannelSetupWizard = createPhotonSetupWizard();
