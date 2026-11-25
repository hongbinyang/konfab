import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

const env = () =>
  JSON.parse(process.env.KONFAB_E2E_ENV ?? "{}") as Record<string, string>;

// The server uses a stand-in for the app's command (see konfab-server.ts).
test("the lead asks an agent to rejoin, cancels and asks again", async ({
  page,
}, testInfo) => {
  test.skip(process.platform !== "darwin", "only offered on macOS");
  const home = env().KONFAB_HOME ?? "";
  const calls = join(home, "..", "codex.calls");
  const sent = () =>
    existsSync(calls)
      ? (readFileSync(calls, "utf8").match(/^queue$/gm) ?? []).length
      : 0;
  const conversation = randomUUID();
  const code = /[?&]code=([^\s&]+)/.exec(
    execFileSync("node", ["dist/cli/login-link.js"], {
      env: env(),
      encoding: "utf8",
    }),
  )?.[1];
  const name = `rejoin-${testInfo.project.name}-${Date.now()}`;
  await page.goto(`${process.env.KONFAB_E2E_BASE_URL}/login?code=${code}`);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("heading", { name: `# ${name}` })).toBeVisible();
  // Nobody has joined, so nobody can be asked.
  await expect(page.getByRole("button", { name: "Rejoin agents" })).toHaveCount(
    0,
  );
  const write = (sql: string, ...values: unknown[]) => {
    const db = new Database(join(home, "konfab.db"), { timeout: 5000 });
    try {
      db.prepare(sql).run(...values);
    } finally {
      db.close();
    }
  };
  // As if the agent had joined, come back and were waiting.
  const now = Date.now();
  for (const [id, state, wait] of [
    [`e2e-old-${name}`, "replaced", 0],
    [`e2e-${name}`, "active", now],
  ])
    write(
      `INSERT INTO sessions (id, room_id, agent_id, state, started_at, last_call_at, run_ends_at, conversation_id, first_wait_at)
       SELECT ?, id, 'codex', ?, ?, ?, ?, ?, ? FROM rooms WHERE name = ?`,
      id,
      state,
      now,
      now,
      now + 3_600_000,
      conversation,
      wait,
      name,
    );
  // Below 900 px the right panel is closed unless the lead opened it.
  await page.evaluate(`localStorage.setItem("konfab.ui.v1.panel", "true")`);
  await page.reload();
  // A reload opens the first room.
  await page
    .locator("nav, aside")
    .getByRole("button", { name: `# ${name}`, exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: `# ${name}` })).toBeVisible();
  const before = sent();
  // The button is there, greyed out, and says why.
  const hint = page
    .locator(".compact-agent", { hasText: "@codex" })
    .getByRole("group", { name: "Rejoin Codex" });
  await expect(hint.getByRole("button", { name: "Rejoin" })).toHaveAttribute(
    "title",
    "Available when the agent is away.",
  );
  await expect(
    hint.getByRole("button", { name: "Rejoin", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Rejoin agents" }),
  ).toBeDisabled();
  await expect(page.getByText("Codex is back")).toBeVisible();
  for (const button of [
    hint.getByRole("button", { name: "Rejoin", exact: true }),
    page.getByRole("button", { name: "Rejoin agents" }),
  ])
    await expect(button).toHaveCSS("opacity", "0.55");
  if (process.env.KONFAB_SHOTS) await hint.scrollIntoViewIfNeeded();
  if (process.env.KONFAB_SHOTS)
    await page.screenshot({
      path: join(process.env.KONFAB_SHOTS, `grey-${testInfo.project.name}.png`),
    });
  // Then its conversation stopped.
  write(
    "UPDATE sessions SET state = 'ended', end_reason = 'run_window_ended' WHERE id = ?",
    `e2e-${name}`,
  );
  await page.reload();
  await page
    .locator("nav, aside")
    .getByRole("button", { name: `# ${name}`, exact: true })
    .first()
    .click();

  const header = page.getByRole("button", { name: "Rejoin agents" });
  await header.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: /Rejoin agents/ });
  await expect(dialog.getByRole("listitem")).toHaveText([
    /^Codex\s*Codex will be asked$/,
  ]);
  if (process.env.KONFAB_SHOTS)
    await page.screenshot({
      path: join(process.env.KONFAB_SHOTS, `ask-${testInfo.project.name}.png`),
    });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(sent()).toBe(before);

  const card = page.locator(".compact-agent", { hasText: "@codex" });
  const details = card.getByRole("button", { expanded: false }).first();
  if (!(await card.getByRole("group", { name: "Rejoin Codex" }).isVisible()))
    await details.click();
  const group = card.getByRole("group", { name: "Rejoin Codex" });
  await group.getByRole("button", { name: "Rejoin", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(group.getByRole("status")).toHaveText(
    /^Rejoin asked .* · waiting\.$/,
  );
  // The page shows the request before the command has run.
  await expect.poll(sent).toBe(before + 1);
  await expect(group).toContainText("press Resume there");
  await expect(group.getByRole("button", { name: "Cancel" })).toHaveAttribute(
    "title",
    /can't take back the prompt in Codex/,
  );
  await group.getByText("Join prompts").click();
  await expect(
    group.getByRole("button", { name: "Copy rejoin prompt" }),
  ).toBeVisible();
  // No app is opened by a test server, so nothing says that one would be.
  await expect(group.getByRole("button", { name: /^Open/ })).toHaveCount(0);
  await expect(header).toHaveCount(0);
  if (process.env.KONFAB_SHOTS)
    await page.screenshot({
      path: join(
        process.env.KONFAB_SHOTS,
        `rejoin-${testInfo.project.name}.png`,
      ),
    });

  await page.setViewportSize({ width: 375, height: 800 });
  await expect(group).toBeVisible();
  await group.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
  ).toBe(true);
  const box = await group.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  if (process.env.KONFAB_SHOTS)
    await page.screenshot({
      path: join(
        process.env.KONFAB_SHOTS,
        `rejoin-narrow-${testInfo.project.name}.png`,
      ),
    });
  await page.setViewportSize({ width: 1280, height: 720 });

  await group.getByRole("button", { name: "Cancel" }).click();
  await expect(group.getByRole("status")).toHaveText(/^Rejoin closed\./);

  // A paused room: one click, after a question that names the whole room.
  write("UPDATE rooms SET paused = 1 WHERE name = ?", name);
  await page.reload();
  await page
    .locator("nav, aside")
    .getByRole("button", { name: `# ${name}` })
    .first()
    .click();
  const resume = group.getByRole("button", { name: "Resume and rejoin" });
  await resume.focus();
  await page.keyboard.press("Enter");
  const question = page.getByRole("dialog", { name: "Resume and rejoin" });
  await expect(question).toContainText("This resumes the whole room.");
  if (process.env.KONFAB_SHOTS)
    await page.screenshot({
      path: join(
        process.env.KONFAB_SHOTS,
        `resume-${testInfo.project.name}.png`,
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
  await expect(question).toBeHidden();
  await expect(resume).toBeVisible();
  expect(sent()).toBe(before + 1);
  await resume.click();
  await question.getByRole("button", { name: "Only resume" }).click();
  await expect(question).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  expect(sent()).toBe(before + 1);

  const questions: string[] = [];
  page.once("dialog", (question) => {
    questions.push(question.message());
    void question.dismiss();
  });
  const again = group.getByRole("button", { name: "Rejoin", exact: true });
  await again.click();
  expect(questions).toEqual([
    "Another prompt may already be waiting there. Send a new one? Only the newest can rejoin.",
  ]);
  expect(sent()).toBe(before + 1);
  page.once("dialog", (question) => void question.accept());
  await again.click();
  await expect(group.getByRole("status")).toHaveText(/waiting\.$/);
  await expect.poll(sent).toBe(before + 2);

  const number = [
    ...readFileSync(calls, "utf8").matchAll(/request "([A-Z0-9]{26})"/g),
  ].at(-1)![1]!;
  const content = await page.content();
  expect(content).not.toContain(number);
  expect(content).not.toContain(conversation);
  await page.getByText("Activity timeline").click();
  await expect(page.locator(".activity")).toContainText("Codex: rejoin asked");
  await expect(page.locator(".activity")).toContainText("Codex: rejoin closed");
});
