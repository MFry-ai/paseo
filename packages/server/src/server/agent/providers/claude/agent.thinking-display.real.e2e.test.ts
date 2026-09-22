import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";

import type { AgentStreamEvent, AgentSession } from "../../agent-sdk-types.js";
import {
  canRunRealProvider,
  createRealProviderClient,
} from "../../../daemon-e2e/real-provider-test-config.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";

// Adaptive thinking is the model's choice, so the prompt has to be hard enough
// that it always reasons. A trivial sum does not think at all.
const THINKING_PROMPT =
  "You have 12 identical-looking balls; exactly one has a different weight (you do not " +
  "know if heavier or lighter). Using a balance scale only 3 times, give the complete " +
  "decision procedure that always identifies the odd ball AND whether it is heavy or " +
  "light. Work out every branch.";

function isTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

async function collectUntilTerminal(session: AgentSession): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamSession(session, THINKING_PROMPT)) {
    events.push(event);
    if (isTerminalEvent(event)) {
      return events;
    }
  }
  return events;
}

function reasoningTexts(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" && event.item.type === "reasoning" ? [event.item.text] : [],
  );
}

describe("Claude thinking display (real)", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("emits reasoning timeline items when thinking is enabled", async () => {
    const client = createRealProviderClient("claude", pino({ level: "silent" }));
    const session = await client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      modeId: "bypassPermissions",
      model: "claude-sonnet-5",
      thinkingOptionId: "high",
    });

    try {
      const events = await collectUntilTerminal(session);
      const failure = events.find((event) => event.type === "turn_failed");
      expect(failure, JSON.stringify(failure)).toBeUndefined();

      const reasoning = reasoningTexts(events);
      expect(reasoning.length).toBeGreaterThan(0);
      expect(reasoning.join("").trim().length).toBeGreaterThan(0);
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 180_000);
});
