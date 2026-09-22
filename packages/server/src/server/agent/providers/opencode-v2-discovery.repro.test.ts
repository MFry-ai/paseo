import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { expect, test } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { OpenCodeAgentClient } from "./opencode-agent.js";
import { OpenCodeEventConsumer } from "./opencode/event-consumer.js";
import { OpenCodeServerManager } from "./opencode/server-manager.js";

/**
 * Upstream modelled on opencode v2.0.3 as read from its own source:
 *  - packages/cli/src/server-process.ts always has a password (env or random)
 *  - packages/protocol/src/groups/provider.ts serves provider.list at /api/provider
 *  - packages/cli/src/services/web-ui.ts serves index.html for any unmatched route
 */
async function createUpstream(options: { readonly auth: boolean; readonly apiPrefix: boolean }) {
  const password = randomBytes(32).toString("base64url");
  const providerPayload = {
    connected: ["synthetic"],
    all: [
      {
        id: "synthetic",
        name: "Synthetic",
        source: "api",
        models: { "hf:zai-org/GLM-4.6": { id: "hf:zai-org/GLM-4.6", name: "GLM 4.6" } },
      },
    ],
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (options.auth) {
      const header = request.headers.authorization ?? "";
      const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      if (header !== expected) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="Secure Area"' });
        response.end();
        return;
      }
    }
    const prefix = options.apiPrefix ? "/api" : "";
    if (pathname === `${prefix}/provider`) return json(response, providerPayload);
    if (pathname === `${prefix}/agent`) return json(response, []);
    if (options.apiPrefix) {
      // web-ui.ts fallback: every unmatched route yields the SPA shell.
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html><body>opencode</body></html>");
      return;
    }
    return json(response, []);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

class FakeServerProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly pid = 42_101;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor() {
    super();
    queueMicrotask(() => this.stdout.emit("data", Buffer.from("listening on test server\n")));
  }
  exit(): void {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}

function createClientFor(port: number) {
  let serverProcess: FakeServerProcess | null = null;
  const manager = new OpenCodeServerManager({
    logger: createTestLogger(),
    portAllocator: async () => port,
    resolveCommandPrefix: async () => ({ command: "opencode", args: [] }),
    resolveHomeDir: () => process.cwd(),
    spawnServerProcess: () => {
      serverProcess = new FakeServerProcess();
      return serverProcess as unknown as ChildProcess;
    },
    terminateProcess: async () => {
      serverProcess?.exit();
      return "terminated";
    },
    createEventSource: (options) => new OpenCodeEventConsumer(options),
  });
  const client = new OpenCodeAgentClient(createTestLogger(), undefined, {
    serverManager: manager,
    createClient: ({ baseUrl, directory }) => createOpencodeClient({ baseUrl, directory }),
  });
  return { manager, client };
}

/**
 * Ablation over the two things opencode v2 changed. Each case reports the
 * error Paseo surfaces today, so the decisive factor is visible: the
 * mandatory server password fails first and produces the reported string,
 * masking the /api route move behind it.
 */
const CASES = [
  {
    name: "v1: no auth, bare routes — discovery works",
    auth: false,
    apiPrefix: false,
    error: null,
  },
  {
    name: "v2 password only: bare routes — reported symptom",
    auth: true,
    apiPrefix: false,
    error: "Failed to fetch OpenCode providers: {}",
  },
  {
    name: "v2 routes only: no password — distinct, legible error",
    auth: false,
    apiPrefix: true,
    error: "Request is not supported by this version of OpenCode Server",
  },
  {
    name: "v2.0.3: password and /api routes — password fails first",
    auth: true,
    apiPrefix: true,
    error: "Failed to fetch OpenCode providers: {}",
  },
] as const;

for (const testCase of CASES) {
  test(`#4878 ${testCase.name}`, async () => {
    const upstream = await createUpstream(testCase);
    const { manager, client } = createClientFor(upstream.port);
    try {
      const attempt = client.fetchCatalog({ scope: "global", cwd: process.cwd(), force: false });
      if (testCase.error === null) {
        const catalog = await attempt;
        expect(catalog.models.map((model) => model.id)).toContain("synthetic/hf:zai-org/GLM-4.6");
      } else {
        await expect(attempt).rejects.toThrow(testCase.error);
      }
    } finally {
      await manager.shutdown();
      await upstream.close();
    }
  });
}

// Red repro for #4878: the behaviour users expect from a supported provider.
test("#4878 discovery lists models against an OpenCode v2.0.3 server", async () => {
  const upstream = await createUpstream({ auth: true, apiPrefix: true });
  const { manager, client } = createClientFor(upstream.port);
  try {
    const catalog = await client.fetchCatalog({
      scope: "global",
      cwd: process.cwd(),
      force: false,
    });
    expect(catalog.models.map((model) => model.id)).toContain("synthetic/hf:zai-org/GLM-4.6");
  } finally {
    await manager.shutdown();
    await upstream.close();
  }
});
