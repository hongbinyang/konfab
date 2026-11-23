import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const env = () =>
  JSON.parse(process.env.KONFAB_E2E_ENV ?? "{}") as Record<string, string>;

test("the lead can switch phone notices, and only a person's actions count as activity", async ({
  page,
}) => {
  const file = join(env().KONFAB_HOME ?? "", "telegram.json");
  const code = /[?&]code=([^\s&]+)/.exec(
    execFileSync("node", ["dist/cli/login-link.js"], {
      env: env(),
      encoding: "utf8",
    }),
  )?.[1];
  let pings = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/activity")) pings += 1;
  });
  await page.goto(`${process.env.KONFAB_E2E_BASE_URL}/login?code=${code}`);
  await page.evaluate(
    `localStorage.setItem("konfab.ui.v1.section.lead", "true")`,
  );
  const section = page.getByRole("region", { name: "Phone notices" });
  const openLead = async () => {
    const toggle = page.getByRole("button", { name: /^Lead · / });
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
  };
  try {
    await page.waitForTimeout(300);
    expect(pings).toBe(0);
    await openLead();
    await expect(section).toContainText("npm run setup -- --telegram");
    await page.keyboard.press("Shift");
    await expect.poll(() => pings).toBe(1);

    // As setup leaves it, off; there is no token, so nothing can be sent.
    writeFileSync(
      file,
      JSON.stringify({
        chat_id: 12345,
        chat_name: "Test",
        enabled: false,
        slot: "env",
        bot_id: "1",
        setup_id: "e2e",
      }),
    );
    await page.reload();
    await openLead();
    const toggle = section.getByRole("checkbox", {
      name: "Phone notices (Telegram) to Test",
    });
    await expect(toggle).not.toBeChecked();
    // It changes once Konfab has answered.
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(section).toContainText("after 10 minutes without activity");
    await page.reload();
    await openLead();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(section).toContainText("Off. Nothing is sent.");
    expect(await page.content()).not.toContain("12345");
  } finally {
    rmSync(file, { force: true });
  }
});
