import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { createReloadDetector } from "./e2eReloadDetector.mjs";

// A run is INVALID if the `next dev` server hot-reloads or 5xx-es mid-run (usually
// something editing app/). Set E2E_ALLOW_DEV_RELOADS=1 to only warn (interactive debugging).
const allowReloads = process.env.E2E_ALLOW_DEV_RELOADS === "1";
const reloadDetector = createReloadDetector();

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const isGroups = !!process.env.E2E_GROUPS;
const RELAY_PORT = 7777;
const BLOSSOM_MOCK_PORT = 3001;

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a local port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function waitForPort(port, host = "localhost", timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryConnect = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
        return;
      }
      const socket = createConnection({ port, host });
      socket.on("connect", () => { socket.destroy(); resolve(); });
      socket.on("error", () => { socket.destroy(); setTimeout(tryConnect, 500); });
    };
    tryConnect();
  });
}

// Groups mode: wait for strfry relay and blossom-mock
if (isGroups) {
  console.log(`[e2e] Waiting for strfry relay on port ${RELAY_PORT}`);
  await waitForPort(RELAY_PORT);
  console.log("[e2e] Relay ready");
  console.log(`[e2e] Waiting for blossom-mock on port ${BLOSSOM_MOCK_PORT}`);
  await waitForPort(BLOSSOM_MOCK_PORT);
  console.log("[e2e] Blossom mock ready");
}

const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;

const serverEnv = { ...process.env };
if (isGroups) {
  serverEnv.NEXT_PUBLIC_RELAYS = `ws://localhost:${RELAY_PORT}`;
  serverEnv.NEXT_PUBLIC_BLOSSOM_BASE_URL = `http://localhost:${BLOSSOM_MOCK_PORT}`;
  // USER_B (deterministic test keypair) is the maintainer in the e2e test suite
  // so dm-feedback-channel.spec.ts can control the maintainer's private key.
  // Derived from USER_B.privateKeyHex = 'cbecda1c7d37d4c0aa5466243bb4a0018c31bf06d74fa7338290dd3068db4fed'
  serverEnv.NEXT_PUBLIC_MAINTAINER_NPUBS = 'npub14cjwfhp3fpfafzj0prkz6jjlwvkmrlq8a6xjccgugyfj3wlq2scq9267f9';
}

const devServer = spawn(npxCommand, ["next", "dev", "--port", String(port)], {
  stdio: ["inherit", "pipe", "pipe"],
  detached: true,
  env: serverEnv,
});
// Pass-through, while scanning for reload/error lines.
devServer.stdout.on("data", (c) => { process.stdout.write(c); reloadDetector.feed(c); });
devServer.stderr.on("data", (c) => { process.stderr.write(c); reloadDetector.feed(c); });

function stopServer() {
  if (devServer.exitCode === null) {
    try {
      // Kill entire process group (detached) to ensure next dev is stopped
      process.kill(-devServer.pid, "SIGTERM");
    } catch {
      try { devServer.kill("SIGTERM"); } catch { /* already dead */ }
    }
  }
}

process.on("SIGINT", () => { stopServer(); process.exit(130); });
process.on("SIGTERM", () => { stopServer(); process.exit(143); });

async function waitForServer(timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (devServer.exitCode !== null) {
      throw new Error(`Dev server exited early with code ${devServer.exitCode}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Keep polling until the dev server is reachable.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${baseUrl}`);
}

// Compile every page once before Playwright starts. `next dev` compiles a route
// on its first request, and a first compile while a browser page is open can
// trigger a "Fast Refresh had to perform a full reload" that aborts the test
// in flight (seen on /settings and /groups) and trips the INVALID-run detector.
const WARM_ROUTES = [
  "/add/", "/contacts/", "/feedback/", "/groups/", "/imprint/",
  "/info/", "/profile/", "/settings/", "/theme-preview/",
];

async function warmRoutes() {
  for (const route of WARM_ROUTES) {
    try {
      await fetch(new URL(route, baseUrl));
    } catch {
      // Best effort: a route that fails here still compiles on first use.
    }
  }
}

try {
  await waitForServer();
  await warmRoutes();
  console.log(`[e2e] Dev server ready on ${baseUrl} (routes warmed)`);

  const runner = spawn(npxCommand, ["playwright", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      E2E_GROUPS: process.env.E2E_GROUPS || "",
      BLOSSOM_BASE_URL: isGroups ? `http://localhost:${BLOSSOM_MOCK_PORT}` : "",
    },
  });

  const exitCode = await new Promise((resolve, reject) => {
    runner.on("exit", resolve);
    runner.on("error", reject);
  });

  stopServer();
  reloadDetector.flush();
  let finalCode = exitCode ?? 1;
  if (reloadDetector.offending.length > 0) {
    const bar = "=".repeat(78);
    console.error(`\n${bar}\n[e2e] ${allowReloads ? "WARNING (E2E_ALLOW_DEV_RELOADS=1)" : "INVALID RUN"}: dev server reloaded/errored during the run — results untrustworthy; was something editing app/?`);
    for (const l of reloadDetector.offending) console.error(`[e2e]   ${l}`);
    console.error(`${bar}\n`);
    if (!allowReloads) finalCode = finalCode === 0 ? 1 : finalCode;
  }
  process.exit(finalCode);
} catch (error) {
  stopServer();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
