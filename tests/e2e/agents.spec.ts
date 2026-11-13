import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

function loginUrl(): string {
  const env = JSON.parse(process.env.KONFAB_E2E_ENV ?? "{}") as Record<
    string,
    string
  >;
  const output = execFileSync("node", ["dist/cli/login-link.js"], {
    env,
    encoding: "utf8",
  });
  const code = /[?&]code=([^\s&]+)/.exec(output)?.[1];
  const base = process.env.KONFAB_E2E_BASE_URL;
  if (!code || !base) throw new Error("No login link");
  return `${base}/login?code=${code}`;
}

async function openRoom(page: Page, name: string): Promise<void> {
  await page.goto(loginUrl());
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("heading", { name: `# ${name}` })).toBeVisible();
}

test("add an agent with an app and a confirmed role, then talk to the room", async ({
  page,
}, testInfo) => {
  const room = `e2e-${testInfo.project.name}`;
  await openRoom(page, room);

  await page.getByRole("button", { name: "+ Add agent" }).click();
  const form = page.getByRole("form", { name: "Add agent" });
  const name = `QA ${testInfo.project.name}`;
  await form.getByLabel("Display name").fill(name);
  await form.getByLabel(/^App/).selectOption("codex");
  await form
    .getByLabel(/^Role in this room/)
    .selectOption({ label: "Reviewer" });
  await expect(form.getByText(/^Preview: Reviewer · rev \d+$/)).toBeVisible();

  const submit = form.getByRole("button", { name: "Add agent", exact: true });
  await expect(submit).toBeDisabled();
  await form.getByLabel(/I reviewed this role/).check();
  await expect(submit).toBeEnabled();
  await submit.click();

  const card = page.locator(".compact-agent", { hasText: name });
  await expect(card.getByText("App: Codex")).toBeVisible();
  await expect(card.getByText(/^Role: Reviewer rev \d+$/)).toBeVisible();
  await expect(card.getByText("Not joined")).toBeVisible();

  await page
    .getByPlaceholder(/Message the room/)
    .fill("Hello team, this is an end-to-end check.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(
    page.getByText("Hello team, this is an end-to-end check."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText(/Room is paused/)).toBeVisible();
});

test("warns when a mentioned agent can't hear the lead", async ({
  page,
}, testInfo) => {
  await openRoom(page, `mention-${testInfo.project.name}`);
  await page.getByPlaceholder(/Message the room/).fill("@codex are you there?");
  await page.getByRole("button", { name: "Send" }).click();
  const notice = page.locator(".unreachable-notice");
  await expect(notice).toContainText(
    "Codex hasn't joined this room, so your mention is waiting.",
  );
  await expect(
    notice.getByRole("button", { name: "Copy join prompt" }),
  ).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);
});

test("name an agent in the room and mention it by that name", async ({
  page,
}, testInfo) => {
  await openRoom(page, `names-${testInfo.project.name}`);
  const roomName = `Q${testInfo.project.name}`;

  await page.getByRole("button", { name: "+ Add agent" }).click();
  const form = page.getByRole("form", { name: "Add agent" });
  await form.getByLabel("Display name").fill(`Namer ${testInfo.project.name}`);
  await form.getByLabel(/^App/).selectOption("claude");
  await form.getByLabel(/^Name in this room/).fill(roomName);
  await form.getByRole("button", { name: "Add agent", exact: true }).click();

  const card = page.locator(".compact-agent", { hasText: `@${roomName}` });
  await expect(card.getByRole("strong").first()).toHaveText(
    `${roomName} @${roomName}`,
  );
  await expect(page.getByText(" · default")).toHaveCount(0);

  // Before it joins, the name can still change; a clash is explained inline.
  const codexCard = page.locator(".compact-agent", { hasText: "@codex" });
  await codexCard.getByLabel("Name in this room").fill(roomName.toLowerCase());
  await codexCard.getByRole("button", { name: "Save" }).click();
  await expect(codexCard.getByRole("alert")).toContainText("would mean both");

  await page
    .getByPlaceholder(/Message the room/)
    .fill(`@${roomName.toLowerCase()} are you there?`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".unreachable-notice")).toContainText(
    `${roomName} hasn't joined this room, so your mention is waiting.`,
  );
});
