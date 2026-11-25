import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parse } from "yaml";

const env = () =>
  JSON.parse(process.env.KONFAB_E2E_ENV ?? "{}") as Record<string, string>;

test("the lead changes settings in the page, which are in use at once", async ({
  page,
}, testInfo) => {
  const saved = () =>
    parse(
      readFileSync(join(env().KONFAB_HOME ?? "", "config.yaml"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
  const code = /[?&]code=([^\s&]+)/.exec(
    execFileSync("node", ["dist/cli/login-link.js"], {
      env: env(),
      encoding: "utf8",
    }),
  )?.[1];
  const shot = async (what: string) => {
    if (process.env.KONFAB_SHOTS)
      await page.screenshot({
        path: join(
          process.env.KONFAB_SHOTS,
          `settings-${what}-${testInfo.project.name}.png`,
        ),
      });
  };
  await page.goto(`${process.env.KONFAB_E2E_BASE_URL}/login?code=${code}`);
  const open = page.getByRole("button", { name: "⚙ Settings" });
  await open.focus();
  await page.keyboard.press("Enter");
  const settings = page.getByRole("region", { name: "Settings" });
  const away = settings.getByRole("textbox", { name: "Away after" });
  await expect(away).toHaveValue("10");
  await away.fill("0");
  await expect(settings.getByRole("alert")).toHaveText(
    "A whole number from 1 to 1440",
  );
  await expect(settings.getByRole("button", { name: "Save" })).toBeDisabled();
  await away.fill("5");
  await settings.getByRole("textbox", { name: "Quiet from" }).fill("22:00");
  await shot("phone");
  // Leaving asks.
  page.once("dialog", (question) => void question.dismiss());
  await page.getByRole("button", { name: "⚙ Manage library" }).click();
  await expect(away).toHaveValue("5");
  await settings.getByRole("button", { name: "Save" }).click();
  await expect(settings.getByRole("button", { name: "Save" })).toHaveCount(0);
  expect(saved().phone_notices).toEqual({
    away_minutes: 5,
    quiet_from: "22:00",
  });
  await settings.getByRole("button", { name: "Reset Away after" }).click();
  await expect(away).toHaveValue("10");
  await settings.getByRole("button", { name: "Reset Quiet from" }).click();
  await expect(
    settings.getByRole("textbox", { name: "Quiet from" }),
  ).toHaveValue("");
  expect(saved()).not.toHaveProperty("phone_notices");

  await settings.getByRole("button", { name: "Rejoin" }).click();
  const watcher = settings.getByRole("switch", { name: "Wake Claude agents" });
  await expect(watcher).not.toBeChecked();
  let asked = "";
  page.once("dialog", (question) => {
    asked = question.message();
    void question.dismiss();
  });
  await watcher.focus();
  await page.keyboard.press("Space");
  await expect(watcher).not.toBeChecked();
  expect(asked).toContain("from its next join");
  expect(saved().rejoin).not.toHaveProperty("claude_watcher");
  page.once("dialog", (question) => void question.accept());
  await watcher.focus();
  await page.keyboard.press("Space");
  await expect(watcher).toBeChecked();
  expect(saved().rejoin).toMatchObject({ claude_watcher: true });
  await shot("rejoin");
  // The command line and the page see the same.
  execFileSync(
    "node",
    ["dist/cli/config.js", "reset", "rejoin.claude_watcher"],
    { env: env() },
  );
  await expect(watcher).not.toBeChecked({ timeout: 10_000 });

  await settings.getByRole("button", { name: "Change…" }).click();
  const dialog = page.getByRole("dialog", { name: "Codex command" });
  await dialog.getByLabel("Absolute path").fill("/usr/bin/true");
  await dialog.getByRole("button", { name: "Look at it" }).click();
  await expect(
    dialog.getByRole("button", { name: "Use this file" }),
  ).toBeVisible();
  await shot("command");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.setViewportSize({ width: 375, height: 800 });
  await expect(watcher).toBeVisible();
  expect(
    await page.evaluate(
      "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
    ),
  ).toBe(true);
  const box = await watcher.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await shot("narrow");
});
