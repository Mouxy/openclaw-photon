import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.OPENCLAW_HOME = process.env.OPENCLAW_HOME || mkdtempSync(path.join(tmpdir(), "photon-setup-"));

const { photonSetupWizard, createPhotonSetupWizard } = await import(`../dist/src/setup.js?test=${Date.now()}`);

function prompterStub(answers = {}) {
  const notes = [];
  const texts = Array.isArray(answers.texts) ? [...answers.texts] : undefined;
  const confirms = Array.isArray(answers.confirms) ? [...answers.confirms] : undefined;
  return {
    notes,
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => notes.push({ message, title }),
    select: async ({ options, initialValue }) => answers.select ?? initialValue ?? options[0].value,
    multiselect: async () => [],
    text: async () => (texts ? texts.shift() ?? "" : answers.text ?? ""),
    confirm: async ({ initialValue }) => (confirms ? confirms.shift() ?? false : answers.confirm ?? initialValue ?? true),
    progress: () => ({ update: () => {}, stop: () => {} }),
  };
}

test("status reports configured only when credentials or local mode are present", async () => {
  const configured = { channels: { photon: { projectId: "proj-1", projectSecret: "sec-1" } } };
  const localMode = { channels: { photon: { local: true } } };
  const empty = { channels: {} };
  assert.equal(await photonSetupWizard.status.resolveConfigured({ cfg: configured, accountId: "default" }), true);
  assert.equal(await photonSetupWizard.status.resolveConfigured({ cfg: localMode, accountId: "default" }), true);
  assert.equal(await photonSetupWizard.status.resolveConfigured({ cfg: empty, accountId: "default" }), false);
});

test("prepare keeps existing credentials without touching config", async () => {
  const cfg = { channels: { photon: { projectId: "proj-1", projectSecret: "sec-1" } } };
  const result = await photonSetupWizard.prepare({
    cfg,
    accountId: "default",
    prompter: prompterStub({ select: "keep" }),
    credentialValues: {},
  });
  assert.equal(result.cfg, undefined);
  assert.deepEqual(result.credentialValues, { name: "proj-1", secret: "sec-1" });
});

test("prepare falls through to manual entry when selected", async () => {
  const cfg = { channels: {} };
  const result = await photonSetupWizard.prepare({
    cfg,
    accountId: "default",
    prompter: prompterStub({ select: "manual" }),
    credentialValues: {},
  });
  assert.equal(result, undefined);
});

test("credential and project id steps write to the default account section", async () => {
  const secretStep = photonSetupWizard.credentials[0];
  let cfg = { channels: {} };
  cfg = await secretStep.applySet({ cfg, accountId: "default", credentialValues: {}, value: "sec-2", resolvedValue: "sec-2" });
  const idStep = photonSetupWizard.textInputs[0];
  cfg = await idStep.applySet({ cfg, accountId: "default", value: " proj-2 " });
  assert.equal(cfg.channels.photon.projectSecret, "sec-2");
  assert.equal(cfg.channels.photon.projectId, "proj-2");
  assert.equal(cfg.channels.photon.enabled, true);
});

test("credential steps are skipped once prepare resolved values", () => {
  const secretStep = photonSetupWizard.credentials[0];
  assert.equal(secretStep.shouldPrompt({ credentialValues: { secret: "sec-1" } }), false);
  assert.equal(secretStep.shouldPrompt({ credentialValues: {} }), true);
  const idStep = photonSetupWizard.textInputs[0];
  assert.equal(idStep.shouldPrompt({ credentialValues: { name: "proj-1" } }), false);
  assert.equal(idStep.shouldPrompt({ credentialValues: {} }), true);
});

test("finalize configures mini-app defaults when a business tier is detected", async () => {
  const wizard = createPhotonSetupWizard({ detectTier: async () => "business" });
  const prompter = prompterStub({
    confirms: [true],
    texts: ["OpenClaw", "ABCDE12345", "com.example.App.MessagesExtension", "https://example.com/card"],
  });
  const result = await wizard.finalize({
    cfg: { channels: { photon: { projectId: "proj-1", projectSecret: "sec-1" } } },
    accountId: "default",
    credentialValues: { name: "proj-1", secret: "sec-1" },
    prompter,
  });
  assert.deepEqual(result.cfg.channels.photon.miniAppDefaults, {
    appName: "OpenClaw",
    teamId: "ABCDE12345",
    extensionBundleId: "com.example.App.MessagesExtension",
    url: "https://example.com/card",
  });
});

test("finalize explains and skips mini-app defaults on a non-business tier", async () => {
  const wizard = createPhotonSetupWizard({ detectTier: async () => "pro" });
  const prompter = prompterStub();
  const result = await wizard.finalize({
    cfg: { channels: { photon: { projectId: "proj-1", projectSecret: "sec-1" } } },
    accountId: "default",
    credentialValues: { name: "proj-1" },
    prompter,
  });
  assert.equal(result, undefined);
  assert.match(prompter.notes[0].message, /business-tier/);
});

test("finalize asks about a business account when the tier cannot be detected", async () => {
  const wizard = createPhotonSetupWizard({ detectTier: async () => undefined });
  const prompter = prompterStub({ confirms: [false] });
  const result = await wizard.finalize({
    cfg: { channels: { photon: { projectId: "proj-1", projectSecret: "sec-1" } } },
    accountId: "default",
    credentialValues: { name: "proj-1" },
    prompter,
  });
  assert.equal(result, undefined);
  assert.match(prompter.notes[0].message, /miniAppDefaults/);
});

test("finalize leaves existing mini-app defaults alone and skips local accounts", async () => {
  let tierCalls = 0;
  const wizard = createPhotonSetupWizard({
    detectTier: async () => {
      tierCalls += 1;
      return "business";
    },
  });
  const configured = await wizard.finalize({
    cfg: {
      channels: {
        photon: {
          projectId: "proj-1",
          projectSecret: "sec-1",
          miniAppDefaults: { teamId: "ABCDE12345", extensionBundleId: "com.example.X" },
        },
      },
    },
    accountId: "default",
    credentialValues: {},
    prompter: prompterStub(),
  });
  assert.equal(configured, undefined);
  const local = await wizard.finalize({
    cfg: { channels: { photon: { local: true } } },
    accountId: "default",
    credentialValues: {},
    prompter: prompterStub(),
  });
  assert.equal(local, undefined);
  assert.equal(tierCalls, 0);
});

test("named accounts are patched under accounts.<id>", async () => {
  const secretStep = photonSetupWizard.credentials[0];
  const cfg = await secretStep.applySet({
    cfg: { channels: { photon: { accounts: { work: { projectId: "old" } } } } },
    accountId: "work",
    credentialValues: {},
    value: "sec-3",
    resolvedValue: "sec-3",
  });
  assert.equal(cfg.channels.photon.accounts.work.projectSecret, "sec-3");
  assert.equal(cfg.channels.photon.accounts.work.projectId, "old");
});
