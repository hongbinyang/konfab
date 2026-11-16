import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

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

const manifest = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Designs robots\n${extra}---\n\nGuide the team.\n`;

test("import a skill folder with any file name, then replace it from a single file", async ({
  page,
}, testInfo) => {
  const name = `e2e-architect-${testInfo.project.name}`;
  const home = mkdtempSync(join(tmpdir(), "konfab-e2e-import-"));
  try {
    // A folder named differently from the skill, whose skill file isn't SKILL.md.
    const folder = join(home, "guide-robotics");
    mkdirSync(join(folder, "notes"), { recursive: true });
    writeFileSync(join(folder, "architect.md"), manifest(name));
    writeFileSync(join(folder, "notes", "a.md"), "Supporting notes");
    writeFileSync(join(folder, ".DS_Store"), "junk");
    writeFileSync(join(home, "outside.md"), "outside");
    symlinkSync(join(home, "outside.md"), join(folder, "linked.md"));
    const single = join(home, "architect-v2.txt");
    writeFileSync(single, manifest(name, "license: MIT\n"));

    await page.goto(loginUrl());
    await page.getByRole("button", { name: "⚙ Manage library" }).click();
    await page.getByRole("button", { name: "Import…" }).click();
    const dialog = page.getByRole("region", { name: "Import a skill" });
    await dialog.getByLabel("Choose folder").setInputFiles(folder);

    await expect(
      dialog.getByText(/the only file with skill front matter/),
    ).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveValue(name);
    await expect(dialog.getByText(/may leave out linked files/)).toBeVisible();
    await expect(
      dialog.locator("code", { hasText: "notes/a.md" }),
    ).toBeVisible();
    await expect(dialog.getByText(/Not imported: \.DS_Store/)).toBeVisible();
    // Measured Chromium behaviour: a linked file is left out without notice.
    await expect(dialog.getByText("linked.md")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();

    // The same name again, from a single file with another name: a warned replace.
    await page.getByRole("button", { name: "Import…" }).click();
    await dialog.getByLabel("Choose file").setInputFiles(single);
    await expect(dialog.getByText(/already exists \(rev 1/)).toBeVisible();
    await expect(
      dialog.getByText(/Only this file is imported, as SKILL\.md/),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Import", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Replace…" }).click();
    await dialog.getByRole("button", { name: `Replace ${name}` }).click();
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByText("Licence: MIT")).toBeVisible();
    await page.getByText(/Kept copies: \d+ folder/).click();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: `${name} previous folder (rev 1)` }),
    ).toBeVisible();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
