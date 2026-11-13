import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

function loginPath(): string {
  const env = JSON.parse(process.env.KONFAB_E2E_ENV ?? "{}") as Record<
    string,
    string
  >;
  const output = execFileSync("node", ["dist/cli/login-link.js"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const url = /http:\/\/\S+\/login\?code=\S+/.exec(output)?.[0];
  if (!url) throw new Error("No login link");
  return new URL(url).pathname + new URL(url).search;
}

async function openRoom(page: Page, name: string): Promise<void> {
  await page.goto(loginPath());
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
