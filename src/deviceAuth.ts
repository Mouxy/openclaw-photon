/**
 * Photon Dashboard API client + OAuth 2.0 device-code login flow (RFC 8628).
 *
 * Management-plane twin of the Hermes `plugins/platforms/photon/auth.py`
 * module: every operation (login, find/create project, rotate the project
 * secret, register a user, list the assigned iMessage line) talks to Photon's
 * Dashboard API — the same host the official Photon CLI uses:
 *
 *     Dashboard API   https://app.photon.codes/api/...
 *                     OAuth 2.0 device flow, Bearer access token
 *
 * A Photon project has a single identifier: the dashboard `id` *is* the
 * Spectrum Cloud project id, so the `(id, projectSecret)` pair this module
 * provisions is exactly what `spectrum-ts` needs at runtime.
 *
 * This module intentionally has no spectrum-ts dependency and takes its
 * fetch/sleep implementations as parameters so the flow is unit-testable.
 */

const DEFAULT_DASHBOARD_HOST = "https://app.photon.codes";
const DEFAULT_SPECTRUM_HOST = "https://spectrum.photon.codes";

// Hosted Photon allowlists registered device clients on the device-code
// endpoint — an unregistered client_id is rejected with
// `400 {"error":"invalid_client"}`. Use Photon's published CLI device client
// until the dashboard registers OpenClaw as its own client_id.
export const DEFAULT_CLIENT_ID = "photon-cli";
const DEFAULT_SCOPE = "openid profile email";

// Polling defaults per RFC 8628. Photon overrides via `interval` /
// `expires_in` in the device-code response — those win.
const DEFAULT_POLL_INTERVAL_S = 5;
const DEFAULT_POLL_TIMEOUT_S = 1800;

const E164_RE = /^\+[1-9]\d{6,14}$/;

export type PhotonDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type PhotonDeviceAuthDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export class PhotonDashboardAuthError extends Error {}

function dashboardHost(): string {
  return (process.env.PHOTON_DASHBOARD_HOST || DEFAULT_DASHBOARD_HOST).replace(/\/+$/, "");
}

function spectrumHost(): string {
  return (process.env.PHOTON_SPECTRUM_HOST || DEFAULT_SPECTRUM_HOST).replace(/\/+$/, "");
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function basic(projectId: string, projectSecret: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${projectId}:${projectSecret}`).toString("base64")}` };
}

function resolveDeps(deps: PhotonDeviceAuthDeps = {}) {
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? (() => Date.now()),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const data = await response.json();
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function responseErrorDetail(body: Record<string, unknown>): string {
  for (const key of ["error", "message", "detail"]) {
    const value = body[key];
    if (value) return String(value);
  }
  const encoded = JSON.stringify(body);
  return encoded && encoded !== "{}" ? encoded.slice(0, 500) : "no response body";
}

async function assertOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  throw new Error(`Photon ${action} failed: HTTP ${response.status}: ${responseErrorDetail(await readJson(response))}`);
}

export async function requestDeviceCode(
  deps: PhotonDeviceAuthDeps = {},
  options: { clientId?: string; scope?: string } = {},
): Promise<PhotonDeviceCode> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${dashboardHost()}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: options.clientId ?? DEFAULT_CLIENT_ID, scope: options.scope ?? DEFAULT_SCOPE }),
  });
  await assertOk(response, "device-code request");
  const data = await readJson(response);
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error("Photon device-code response is missing device_code/user_code/verification_uri.");
  }
  return {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    verificationUriComplete: data.verification_uri_complete ? String(data.verification_uri_complete) : undefined,
    expiresInSeconds: Number(data.expires_in) || DEFAULT_POLL_TIMEOUT_S,
    intervalSeconds: Number(data.interval) || DEFAULT_POLL_INTERVAL_S,
  };
}

function cleanBearerToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim().replace(/^bearer\s+/i, "").trim();
  return token || undefined;
}

/**
 * Photon's device-token endpoint has returned tokens under several keys
 * across versions (`access_token`, `accessToken`, `session.*`, `data.*`) and
 * the documented `set-auth-token` response header. Collect every shape so the
 * caller can validate each against the dashboard API before trusting it.
 */
export function deviceResponseTokenCandidates(
  body: Record<string, unknown>,
  headers?: Headers,
): string[] {
  const candidates: string[] = [];
  const push = (value: unknown) => {
    const token = cleanBearerToken(value);
    if (token && !candidates.includes(token)) candidates.push(token);
  };
  push(body.access_token);
  push(body.accessToken);
  const session = body.session;
  if (session && typeof session === "object") push((session as Record<string, unknown>).access_token);
  const data = body.data;
  if (data && typeof data === "object") {
    push((data as Record<string, unknown>).access_token);
    push((data as Record<string, unknown>).accessToken);
  }
  push(headers?.get("set-auth-token"));
  return candidates;
}

/**
 * Poll `/api/auth/device/token` until the user approves. Mirrors the official
 * CLI's loop: sleep first, then poll; `authorization_pending` keeps the
 * interval, `slow_down` adds 5s, HTTP 429 adds 10s, and `access_denied` /
 * `expired_token` abort.
 */
export async function pollForToken(
  code: PhotonDeviceCode,
  deps: PhotonDeviceAuthDeps = {},
  options: { clientId?: string; timeoutSeconds?: number; onPending?: () => void } = {},
): Promise<string> {
  const { fetchImpl, sleep, now } = resolveDeps(deps);
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  const deadline = now() + (options.timeoutSeconds ?? code.expiresInSeconds ?? DEFAULT_POLL_TIMEOUT_S) * 1000;
  let intervalSeconds = code.intervalSeconds || DEFAULT_POLL_INTERVAL_S;

  while (now() < deadline) {
    await sleep(intervalSeconds * 1000);
    let response: Response;
    try {
      response = await fetchImpl(`${dashboardHost()}/api/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.deviceCode,
          client_id: clientId,
        }),
      });
    } catch {
      continue;
    }
    if (response.status === 200) {
      const body = await readJson(response);
      const candidates = deviceResponseTokenCandidates(body, response.headers);
      if (candidates.length === 0) {
        throw new Error(
          "Photon returned 200 but no token candidate in the device-token response " +
            "(expected access_token, data.access_token, accessToken, or set-auth-token).",
        );
      }
      return candidates[0]!;
    }
    if (response.status === 429) {
      // RFC 8628 §3.5 — treat 429 as slow_down.
      intervalSeconds += 10;
      options.onPending?.();
      continue;
    }
    if (response.status === 400) {
      const body = await readJson(response);
      const error = String(body.error ?? body.message ?? "");
      if (error === "authorization_pending") {
        options.onPending?.();
        continue;
      }
      if (error === "slow_down") {
        intervalSeconds += 5;
        options.onPending?.();
        continue;
      }
      if (error === "expired_token" || error === "access_denied") {
        throw new Error(`Photon login failed: ${error}`);
      }
      throw new Error(`Photon device token error: ${error || "unknown"}`);
    }
  }
  throw new Error("Photon device login timed out");
}

/**
 * Verify a device-flow token is usable for dashboard project APIs. The device
 * flow can return a token that authenticates the session lookup but is
 * rejected by the project APIs — fail loudly at login instead of saving a
 * token that 401s downstream.
 */
export async function validatePhotonToken(token: string, deps: PhotonDeviceAuthDeps = {}): Promise<void> {
  const { fetchImpl } = resolveDeps(deps);
  const session = await fetchImpl(`${dashboardHost()}/api/auth/get-session`, { headers: bearer(token) });
  if (session.status === 401 || session.status === 403) {
    throw new PhotonDashboardAuthError("Photon issued a device token, but the dashboard session lookup rejected it.");
  }
  await assertOk(session, "get-session");
  const sessionBody = await readJson(session);
  const user = sessionBody.user;
  if (!user || typeof user !== "object") {
    throw new PhotonDashboardAuthError("Photon issued a device token, but the dashboard session lookup did not recognize it.");
  }
  const projects = await fetchImpl(`${dashboardHost()}/api/projects/`, { headers: bearer(token) });
  if (projects.status === 401 || projects.status === 403) {
    throw new PhotonDashboardAuthError("Photon device token was accepted for the session lookup but rejected by the project API.");
  }
  await assertOk(projects, "list-projects");
}

function unwrapList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object") {
    for (const key of ["data", "projects", "users", "lines", "items"]) {
      const inner = (data as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>;
      if (inner && typeof inner === "object") {
        for (const nestedKey of ["projects", "users", "lines", "items"]) {
          const nested = (inner as Record<string, unknown>)[nestedKey];
          if (Array.isArray(nested)) return nested as Array<Record<string, unknown>>;
        }
      }
    }
  }
  return [];
}

export async function listProjects(token: string, deps: PhotonDeviceAuthDeps = {}): Promise<Array<Record<string, unknown>>> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${dashboardHost()}/api/projects`, { headers: bearer(token) });
  await assertOk(response, "list-projects");
  return unwrapList(await response.json());
}

export async function findOrCreateProject(
  token: string,
  name: string,
  deps: PhotonDeviceAuthDeps = {},
): Promise<{ id: string; created: boolean }> {
  const target = name.trim().toLowerCase();
  for (const project of await listProjects(token, deps)) {
    if (String(project.name ?? "").trim().toLowerCase() === target && project.id) {
      return { id: String(project.id), created: false };
    }
  }
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${dashboardHost()}/api/projects`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ name, location: "United States", template: false, observability: false }),
  });
  await assertOk(response, "create-project");
  const data = await readJson(response);
  if (data.error) throw new Error(`Photon create-project failed: ${String(data.error)}`);
  if (!data.id) throw new Error("Photon create-project did not return a project id");
  return { id: String(data.id), created: true };
}

/**
 * POST `/api/projects/{id}/regenerate-secret` → the new project secret. This
 * is the only way to read a project secret (the dashboard shows it exactly
 * once), so callers must persist the returned value immediately.
 */
export async function regenerateProjectSecret(
  token: string,
  projectId: string,
  deps: PhotonDeviceAuthDeps = {},
): Promise<string> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${dashboardHost()}/api/projects/${projectId}/regenerate-secret`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: "{}",
  });
  await assertOk(response, "regenerate-secret");
  const data = await readJson(response);
  if (data.error) throw new Error(`Photon regenerate-secret failed: ${String(data.error)}`);
  const secret = data.projectSecret;
  if (!secret) throw new Error("Photon regenerate-secret returned no projectSecret");
  return String(secret);
}

function normalizePhone(phone: string): string {
  return (phone || "").replace(/[^\d+]/g, "");
}

export function isE164(phone: string): boolean {
  return E164_RE.test(normalizePhone(phone));
}

export async function listSpectrumUsers(
  projectId: string,
  projectSecret: string,
  deps: PhotonDeviceAuthDeps = {},
): Promise<Array<Record<string, unknown>>> {
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${spectrumHost()}/projects/${projectId}/users/`, {
    headers: basic(projectId, projectSecret),
  });
  await assertOk(response, "list-users");
  return unwrapList(await response.json());
}

/**
 * Idempotently register a Spectrum user by phone number. Returns
 * `{ user, created }` — the official CLI does no dedup, so we add it here to
 * make setup safely re-runnable.
 */
export async function registerUserIfAbsent(
  projectId: string,
  projectSecret: string,
  phoneNumber: string,
  deps: PhotonDeviceAuthDeps = {},
): Promise<{ user: Record<string, unknown>; created: boolean }> {
  const normalized = normalizePhone(phoneNumber);
  if (!E164_RE.test(normalized)) {
    throw new Error(`phoneNumber must be E.164 (e.g. +15551234567); got ${JSON.stringify(phoneNumber)}`);
  }
  for (const user of await listSpectrumUsers(projectId, projectSecret, deps)) {
    if (normalizePhone(String(user.phoneNumber ?? "")) === normalized) {
      return { user, created: false };
    }
  }
  const { fetchImpl } = resolveDeps(deps);
  const response = await fetchImpl(`${spectrumHost()}/projects/${projectId}/users/`, {
    method: "POST",
    headers: { ...basic(projectId, projectSecret), "content-type": "application/json" },
    body: JSON.stringify({ type: "shared", phoneNumber: normalized }),
  });
  await assertOk(response, "create-user");
  const data = await readJson(response);
  if (data.error) throw new Error(`Photon create-user failed: ${String(data.error)}`);
  const user = data.user ?? data.data ?? data;
  if (!user || typeof user !== "object") throw new Error("Photon create-user returned an unexpected response");
  return { user: user as Record<string, unknown>, created: true };
}

/**
 * Return the iMessage number a Spectrum user is assigned to text on — the
 * dashboard's "TEXTS ON" column, as opposed to the user's own phoneNumber. On
 * shared-number plans there is no dedicated `/lines` entry, so this per-user
 * field is the source of truth.
 */
export function userAssignedLine(user: Record<string, unknown> | undefined): string | undefined {
  const value = user?.assignedPhoneNumber;
  return value ? String(value) : undefined;
}

export async function getIMessageLine(
  token: string,
  projectId: string,
  deps: PhotonDeviceAuthDeps = {},
  options: { createIfMissing?: boolean } = {},
): Promise<Record<string, unknown> | undefined> {
  const { fetchImpl } = resolveDeps(deps);
  const listResponse = await fetchImpl(`${dashboardHost()}/api/projects/${projectId}/lines`, { headers: bearer(token) });
  await assertOk(listResponse, "list-lines");
  for (const line of unwrapList(await listResponse.json())) {
    if (String(line.platform ?? "").toLowerCase() === "imessage") return line;
  }
  if (options.createIfMissing === false) return undefined;
  const createResponse = await fetchImpl(`${dashboardHost()}/api/projects/${projectId}/lines`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ platform: "imessage" }),
  });
  await assertOk(createResponse, "add-line");
  const data = await readJson(createResponse);
  if (data.error) throw new Error(`Photon add-line failed: ${String(data.error)}`);
  return (data.line as Record<string, unknown>) ?? data;
}

/**
 * Best-effort lookup of the project's Photon plan tier (pro/business/
 * enterprise) via Spectrum Cloud's unauthenticated billing endpoint — the
 * same one `spectrum-ts`'s `cloud.getSubscription` calls. Returns undefined
 * on any failure so callers can fall back to asking the operator.
 */
export async function getSubscriptionTier(projectId: string, deps: PhotonDeviceAuthDeps = {}): Promise<string | undefined> {
  const { fetchImpl } = resolveDeps(deps);
  try {
    const response = await fetchImpl(`${spectrumHost()}/projects/${projectId}/billing/subscription`);
    if (!response.ok) return undefined;
    const body = await readJson(response);
    const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : body;
    const tier = data.tier;
    return typeof tier === "string" && tier.trim() ? tier.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export type PhotonDeviceLoginResult = {
  token: string;
  projectId: string;
  projectSecret: string;
  projectCreated: boolean;
};

/**
 * Run the full device login + provisioning flow:
 * request a device code, wait for browser approval, validate the token,
 * find-or-create the project, and rotate the project secret so we can read it.
 */
export async function runPhotonDeviceLogin(params: {
  projectName?: string;
  clientId?: string;
  deps?: PhotonDeviceAuthDeps;
  onUserCode: (code: PhotonDeviceCode) => void | Promise<void>;
  onStatus?: (message: string) => void;
  onPending?: () => void;
}): Promise<PhotonDeviceLoginResult> {
  const deps = params.deps ?? {};
  const code = await requestDeviceCode(deps, { clientId: params.clientId });
  await params.onUserCode(code);
  const token = await pollForToken(code, deps, { clientId: params.clientId, onPending: params.onPending });
  params.onStatus?.("Validating Photon session…");
  await validatePhotonToken(token, deps);
  params.onStatus?.("Locating Photon project…");
  const projectName = params.projectName ?? "OpenClaw";
  const project = await findOrCreateProject(token, projectName, deps);
  params.onStatus?.(project.created ? `Created project "${projectName}"…` : `Using existing project "${projectName}"…`);
  const projectSecret = await regenerateProjectSecret(token, project.id, deps);
  return { token, projectId: project.id, projectSecret, projectCreated: project.created };
}
