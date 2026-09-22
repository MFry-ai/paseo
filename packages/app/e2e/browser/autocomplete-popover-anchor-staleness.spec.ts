import { expect, test, type Page } from "../support/fixtures";
import { composerLocator, expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

const TEST_COMMANDS = [
  { name: "help", description: "Show help", argumentHint: "" },
  { name: "tdd", description: "Red test first", argumentHint: "" },
  { name: "hello", description: "Greeting", argumentHint: "" },
] as const;

async function installListCommandsStub(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (typeof message !== "string") {
        ws.send(message);
        return;
      }
      try {
        const parsed = JSON.parse(message) as {
          type?: string;
          message?: { type?: string; payload?: { commands?: unknown; error?: string | null } };
        };
        if (
          parsed.type === "session" &&
          parsed.message?.type === "list_commands_response" &&
          parsed.message.payload
        ) {
          parsed.message.payload.commands = TEST_COMMANDS;
          parsed.message.payload.error = null;
          ws.send(JSON.stringify(parsed));
          return;
        }
      } catch {
        // forward
      }
      ws.send(message);
    });
  });
}

async function boxes(page: Page) {
  const popover = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="composer-autocomplete-popover"]');
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });
  const composerBox = await page.getByTestId("message-input-root").boundingBox();
  return {
    popover,
    composer: composerBox
      ? {
          x: Math.round(composerBox.x),
          y: Math.round(composerBox.y),
          width: Math.round(composerBox.width),
          height: Math.round(composerBox.height),
        }
      : null,
  };
}

// Failing evidence for https://github.com/getpaseo/paseo/issues/4872: the slash
// autocomplete popover measures its anchor once per slash session, so a layout change
// under an open popover leaves it anchored to where the composer used to be.
test.describe("autocomplete popover anchoring", () => {
  test("follows the composer when the sidebar closes while the popover is open", async ({
    page,
  }) => {
    await installListCommandsStub(page);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "repro-4872-anchor-a-",
      title: "Repro 4872 anchor A",
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page, { timeout: 30_000 });
      const input = composerLocator(page);
      await expect(input).toBeEditable({ timeout: 30_000 });
      await input.click();
      await page.keyboard.type("/");
      await expect(page.getByText("/help", { exact: true })).toBeVisible({ timeout: 30_000 });

      console.log("A BEFORE", JSON.stringify(await boxes(page)));
      await page.getByTestId("menu-button").first().click();
      await page.waitForTimeout(1200);
      const after = await boxes(page);
      console.log("A AFTER", JSON.stringify(after));

      expect(
        Math.abs((after.popover?.x ?? 0) - (after.composer?.x ?? 0)),
        "popover stays anchored to the composer",
      ).toBeLessThanOrEqual(4);
    } finally {
      await session.cleanup();
    }
  });

  test("stays on screen when the sidebar opens while the popover is open", async ({ page }) => {
    await installListCommandsStub(page);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "repro-4872-anchor-b-",
      title: "Repro 4872 anchor B",
    });

    try {
      await openAgentRoute(page, session);
      await expectComposerVisible(page, { timeout: 30_000 });

      // Collapse the sidebar first, so the toggle under test expands it.
      await page.getByTestId("menu-button").first().click();
      await page.waitForTimeout(1200);

      const input = composerLocator(page);
      await expect(input).toBeEditable({ timeout: 30_000 });
      await input.click();
      await page.keyboard.type("/");
      await expect(page.getByText("/help", { exact: true })).toBeVisible({ timeout: 30_000 });
      console.log("B BEFORE", JSON.stringify(await boxes(page)));

      await page.getByTestId("menu-button").first().click();
      await page.waitForTimeout(1200);
      const after = await boxes(page);
      console.log("B AFTER", JSON.stringify(after), "viewport", JSON.stringify(page.viewportSize()));

      const popover = page.getByTestId("composer-autocomplete-popover").first();
      await expect(popover).toBeInViewport({ ratio: 0.9, timeout: 5_000 });
    } finally {
      await session.cleanup();
    }
  });
});
