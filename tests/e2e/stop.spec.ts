import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

const env = () =>
  JSON.parse(process.env.KONFAB_E2E_ENV ?? "{}") as Record<string, string>;

test("the lead stops an agent on its card, keeps it, and sees what is confirmed", async ({
  page,
}, testInfo) => {
  const code = /[?&]code=([^\s&]+)/.exec(
    execFileSync("node", ["dist/cli/login-link.js"], {
      env: env(),
      encoding: "utf8",
    }),
  )?.[1];
  const name = `stop-${testInfo.project.name}-${Date.now()}`;
  await page.goto(`${process.env.KONFAB_E2E_BASE_URL}/login?code=${code}`);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("heading", { name: `# ${name}` })).toBeVisible();
  const write = (sql: string, ...values: unknown[]) => {
    const db = new Database(join(env().KONFAB_HOME ?? "", "konfab.db"), {
      timeout: 5000,
    });
    try {
      db.prepare(sql).run(...values);
    } finally {
      db.close();
    }
  };
  // As if the agent had joined and were in a turn.
  const now = Date.now();
  const id = randomUUID();
  write(
    `INSERT INTO sessions (id, room_id, agent_id, state, started_at, last_call_at, run_ends_at)
     SELECT ?, id, 'codex', 'active', ?, ?, ? FROM rooms WHERE name = ?`,
    id,
    now,
    now,
    now + 3_600_000,
    name,
  );
  write(
    `INSERT INTO turns (room_id, agent_id, reason, state, session_id, created_at, started_at)
     SELECT id, 'codex', 'user', 'active', ?, ?, ? FROM rooms WHERE name = ?`,
    id,
    now,
    now,
    name,
  );
  const open = async () => {
    await page.evaluate(`localStorage.setItem("konfab.ui.v1.panel", "true")`);
    await page.reload();
    await page
      .locator("nav, aside")
      .getByRole("button", { name: `# ${name}`, exact: true })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: `# ${name}` }),
    ).toBeVisible();
  };
  await open();
  const card = page.locator(".compact-agent", { hasText: "@codex" });
  const group = card.getByRole("group", { name: "Stop Codex" });
  const shot = async (what: string) => {
    if (!process.env.KONFAB_SHOTS) return;
    await group.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(
        process.env.KONFAB_SHOTS,
        `stop-${what}-${testInfo.project.name}.png`,
      ),
    });
  };
  const button = group.getByRole("button", { name: "Stop after turn" });
  await expect(button).toBeVisible();
  // On the card, and for all in the header.
  await expect(page.getByRole("button", { name: /^Stop/ })).toHaveCount(2);
  const all = page.getByRole("button", { name: "Stop agents", exact: true });
  await all.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Stop agents" });
  await expect(dialog).toContainText("in a turn · will be asked after it");
  await expect(dialog).toContainText("not there");
  if (process.env.KONFAB_SHOTS)
    await page.screenshot({
      path: join(
        process.env.KONFAB_SHOTS,
        `stop-all-${testInfo.project.name}.png`,
      ),
    });
  await page.setViewportSize({ width: 375, height: 800 });
  expect(
    await page.evaluate(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(group.getByRole("status")).toHaveCount(0);
  await all.click();
  await dialog.getByRole("button", { name: "Stop agents" }).click();
  await expect(dialog).toBeHidden();
  const summary = page.locator(".stop-summary");
  await expect(summary).toContainText("Stop: 1 after its turn");
  await shot("summary");
  await summary.getByRole("button", { name: "Keep all" }).click();
  await expect(summary).toHaveCount(0);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const hint = page.getByRole("button", { name: "Stop agents…" });
  await expect(hint).toBeVisible();
  await shot("pause");
  await hint.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(hint).toHaveCount(0);
  await shot("turn");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(group.getByRole("status")).toHaveText(
    "Stopping after this turn.",
  );
  const keep = group.getByRole("button", { name: "Keep in room" });
  await expect(keep).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(button).toBeFocused();
  await expect(group.getByRole("status")).toHaveCount(0);

  // The turn is over: it stops at once, and nothing is confirmed.
  write(
    "UPDATE turns SET state = 'completed' WHERE session_id = ? AND state = 'active'",
    id,
  );
  await open();
  await group.getByRole("button", { name: "Stop agent" }).click();
  await expect(group.getByRole("status")).toHaveText(
    "Stop not delivered yet. It is told at its next call.",
  );
  await expect(card).toContainText("Stopped");
  await expect(card).toContainText("saved");
  await expect(card).not.toContainText("On break");
  await expect(page.getByText("Codex was stopped")).toBeVisible();
  // Wherever the controls are that have them.
  await card.getByText("Join prompts").click();
  await expect(
    card.getByRole("button", { name: "Copy rejoin prompt" }),
  ).toBeVisible();
  // Its connector has it.
  write(
    "UPDATE sessions SET stop_answered_at = ?, stop_received_at = ? WHERE id = ?",
    now,
    now,
    id,
  );
  await open();
  await expect(group.getByRole("status")).toHaveText(/^Stopped .*Its app may/);
  await expect(group).toContainText("Konfab can't see whether its app");
  await shot("stopped");
  await page.setViewportSize({ width: 375, height: 800 });
  await group.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
  ).toBe(true);
  await shot("narrow");
  await page.setViewportSize({ width: 1280, height: 720 });

  // A mention waits, and says why.
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("@codex hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".unreachable-notice")).toContainText(
    "Codex is stopped, so your mention is waiting.",
  );
  await expect(
    page.getByRole("region", { name: "Conversation next step" }),
  ).toContainText("Codex (queued · stopped)");
  await page.getByText("Activity timeline").click();
  await expect(page.locator(".activity")).toContainText("Codex: stop undone");
});
