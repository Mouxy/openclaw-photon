import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.OPENCLAW_HOME = process.env.OPENCLAW_HOME || mkdtempSync(path.join(tmpdir(), "photon-device-auth-"));

const {
  deviceResponseTokenCandidates,
  findOrCreateProject,
  getIMessageLine,
  isE164,
  pollForToken,
  registerUserIfAbsent,
  requestDeviceCode,
  runPhotonDeviceLogin,
  validatePhotonToken,
} = await import(`../dist/src/deviceAuth.js?test=${Date.now()}`);

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Sequenced fetch mock: match on method+path substring, in order of registration. */
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    for (const route of routes) {
      if (route.used && !route.repeat) continue;
      if (route.method !== method || !String(url).includes(route.path)) continue;
      route.used = true;
      const response = typeof route.response === "function" ? route.response(calls.at(-1)) : route.response;
      return response;
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

test("device token candidates cover every response shape, deduplicated", () => {
  const headers = new Headers({ "set-auth-token": "Bearer tok-header" });
  const candidates = deviceResponseTokenCandidates(
    {
      access_token: "tok-a",
      accessToken: "tok-a",
      session: { access_token: "tok-b" },
      data: { access_token: "tok-c", accessToken: "tok-d" },
    },
    headers,
  );
  assert.deepEqual(candidates, ["tok-a", "tok-b", "tok-c", "tok-d", "tok-header"]);
});

test("pollForToken honours authorization_pending, slow_down, and 429 backoff", async () => {
  const sleeps = [];
  const { fetchImpl } = mockFetch([
    { method: "POST", path: "/api/auth/device/token", response: jsonResponse(400, { error: "authorization_pending" }) },
    { method: "POST", path: "/api/auth/device/token", response: jsonResponse(400, { error: "slow_down" }) },
    { method: "POST", path: "/api/auth/device/token", response: jsonResponse(429, {}) },
    { method: "POST", path: "/api/auth/device/token", response: jsonResponse(200, { access_token: "tok-final" }) },
  ]);
  const token = await pollForToken(
    { deviceCode: "dev-1", userCode: "USER-1", verificationUri: "https://x", expiresInSeconds: 900, intervalSeconds: 5 },
    { fetchImpl, sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(token, "tok-final");
  assert.deepEqual(sleeps, [5000, 5000, 10000, 20000]);
});

test("pollForToken aborts on access_denied", async () => {
  const { fetchImpl } = mockFetch([
    { method: "POST", path: "/api/auth/device/token", response: jsonResponse(400, { error: "access_denied" }) },
  ]);
  await assert.rejects(
    pollForToken(
      { deviceCode: "dev-1", userCode: "USER-1", verificationUri: "https://x", expiresInSeconds: 900, intervalSeconds: 1 },
      { fetchImpl, sleep: noSleep },
    ),
    /access_denied/,
  );
});

test("pollForToken times out against the device-code deadline", async () => {
  let clock = 0;
  const { fetchImpl } = mockFetch([
    { method: "POST", path: "/api/auth/device/token", repeat: true, response: () => jsonResponse(400, { error: "authorization_pending" }) },
  ]);
  await assert.rejects(
    pollForToken(
      { deviceCode: "dev-1", userCode: "USER-1", verificationUri: "https://x", expiresInSeconds: 10, intervalSeconds: 5 },
      { fetchImpl, sleep: async (ms) => { clock += ms; }, now: () => clock },
    ),
    /timed out/,
  );
});

test("findOrCreateProject reuses a project matching by name, case-insensitive", async () => {
  const { fetchImpl, calls } = mockFetch([
    { method: "GET", path: "/api/projects", response: jsonResponse(200, [{ id: "proj-1", name: "openclaw" }]) },
  ]);
  const project = await findOrCreateProject("tok", "OpenClaw", { fetchImpl });
  assert.deepEqual(project, { id: "proj-1", created: false });
  assert.equal(calls.length, 1);
});

test("findOrCreateProject creates when absent", async () => {
  const { fetchImpl, calls } = mockFetch([
    { method: "GET", path: "/api/projects", response: jsonResponse(200, { data: [] }) },
    { method: "POST", path: "/api/projects", response: jsonResponse(200, { success: true, id: "proj-new" }) },
  ]);
  const project = await findOrCreateProject("tok", "OpenClaw", { fetchImpl });
  assert.deepEqual(project, { id: "proj-new", created: true });
  assert.equal(calls.at(-1).body.name, "OpenClaw");
});

test("registerUserIfAbsent is idempotent by normalized phone number", async () => {
  const existing = { id: "u1", phoneNumber: "+1 (555) 123-4567", assignedPhoneNumber: "+18885550000" };
  const { fetchImpl, calls } = mockFetch([
    { method: "GET", path: "/projects/proj-1/users/", response: jsonResponse(200, [existing]) },
  ]);
  const { user, created } = await registerUserIfAbsent("proj-1", "secret", "+15551234567", { fetchImpl });
  assert.equal(created, false);
  assert.equal(user.id, "u1");
  assert.equal(calls.length, 1);
});

test("registerUserIfAbsent rejects non-E.164 numbers and creates new users", async () => {
  await assert.rejects(registerUserIfAbsent("proj-1", "secret", "5551234567", { fetchImpl: async () => jsonResponse(200, []) }), /E\.164/);

  const { fetchImpl, calls } = mockFetch([
    { method: "GET", path: "/projects/proj-1/users/", response: jsonResponse(200, []) },
    { method: "POST", path: "/projects/proj-1/users/", response: jsonResponse(200, { user: { id: "u2", phoneNumber: "+15551234567" } }) },
  ]);
  const { user, created } = await registerUserIfAbsent("proj-1", "secret", "+15551234567", { fetchImpl });
  assert.equal(created, true);
  assert.equal(user.id, "u2");
  assert.deepEqual(calls.at(-1).body, { type: "shared", phoneNumber: "+15551234567" });
});

test("getIMessageLine returns the existing line without provisioning", async () => {
  const { fetchImpl, calls } = mockFetch([
    {
      method: "GET",
      path: "/api/projects/proj-1/lines",
      response: jsonResponse(200, { lines: [{ platform: "imessage", phoneNumber: "+18885550000" }] }),
    },
  ]);
  const line = await getIMessageLine("tok", "proj-1", { fetchImpl });
  assert.equal(line.phoneNumber, "+18885550000");
  assert.equal(calls.length, 1);
});

test("runPhotonDeviceLogin drives the full provisioning flow", async () => {
  const shownCodes = [];
  const { fetchImpl, calls } = mockFetch([
    {
      method: "POST",
      path: "/api/auth/device/code",
      response: jsonResponse(200, {
        device_code: "dev-1",
        user_code: "ABCD-1234",
        verification_uri: "https://app.photon.codes/device",
        verification_uri_complete: "https://app.photon.codes/device?code=ABCD-1234",
        expires_in: 900,
        interval: 5,
      }),
    },
    { method: "POST", path: "/api/auth/device/token", response: jsonResponse(200, { access_token: "tok-1" }) },
    { method: "GET", path: "/api/auth/get-session", response: jsonResponse(200, { user: { id: "me" } }) },
    { method: "GET", path: "/api/projects/", response: jsonResponse(200, []) },
    { method: "GET", path: "/api/projects", response: jsonResponse(200, []) },
    { method: "POST", path: "/api/projects", response: jsonResponse(200, { id: "proj-9" }) },
    { method: "POST", path: "/api/projects/proj-9/regenerate-secret", response: jsonResponse(200, { projectSecret: "sec-9" }) },
  ]);

  const result = await runPhotonDeviceLogin({
    projectName: "OpenClaw",
    deps: { fetchImpl, sleep: noSleep },
    onUserCode: (code) => shownCodes.push(code.userCode),
  });

  assert.deepEqual(result, { token: "tok-1", projectId: "proj-9", projectSecret: "sec-9", projectCreated: true });
  assert.deepEqual(shownCodes, ["ABCD-1234"]);
  const tokenCall = calls.find((call) => call.url.includes("/api/auth/device/token"));
  assert.equal(tokenCall.body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(tokenCall.body.client_id, "photon-cli");
});

test("validatePhotonToken fails loudly when the project API rejects the token", async () => {
  const { fetchImpl } = mockFetch([
    { method: "GET", path: "/api/auth/get-session", response: jsonResponse(200, { user: { id: "me" } }) },
    { method: "GET", path: "/api/projects/", response: jsonResponse(401, { error: "unauthorized" }) },
  ]);
  await assert.rejects(validatePhotonToken("tok", { fetchImpl }), /rejected by the project API/);
});

test("requestDeviceCode surfaces invalid_client errors", async () => {
  const { fetchImpl } = mockFetch([
    { method: "POST", path: "/api/auth/device/code", response: jsonResponse(400, { error: "invalid_client" }) },
  ]);
  await assert.rejects(requestDeviceCode({ fetchImpl }), /invalid_client/);
});

test("isE164 accepts formatted numbers and rejects garbage", () => {
  assert.equal(isE164("+1 (555) 123-4567"), true);
  assert.equal(isE164("+15551234567"), true);
  assert.equal(isE164("5551234567"), false);
  assert.equal(isE164("hello"), false);
});
