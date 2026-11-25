import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startKonfab, type KonfabServer } from "./konfab-server.js";

// Made up. Telegram is a stand-in on this computer, and an isolated server
// uses no Keychain.
const SECRET = "MARKEDaabbCCddEEffGGhhIIjjKKllMMnnOO";
const TOKEN = `1234567890:${SECRET}`;

test("the lead sets up, tests, turns off and removes phone notices in the page", async ({
  page,
}, testInfo) => {
  let code = "";
  const sent: string[] = [];
  const telegram: Server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += String(chunk)));
    request.on("end", () => {
      const method = request.url!.split("/").at(-1);
      const result =
        method === "getMe"
          ? { username: "konfab_bot" }
          : method === "getWebhookInfo"
            ? { url: "" }
            : method === "getUpdates"
              ? code
                ? [
                    {
                      update_id: 1,
                      message: {
                        date: Math.floor(Date.now() / 1000),
                        text: code,
                        chat: {
                          id: 987654321,
                          type: "private",
                          first_name: "Lead",
                        },
                        from: { id: 987654321, is_bot: false },
                      },
                    },
                  ]
                : []
              : {};
      if (method === "sendMessage")
        sent.push((JSON.parse(text) as { text: string }).text);
      response.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((done) => telegram.listen(0, "127.0.0.1", done));
  let server: KonfabServer | undefined;
  const shot = async (what: string) => {
    if (process.env.KONFAB_SHOTS)
      await page.screenshot({
        path: join(
          process.env.KONFAB_SHOTS,
          `phone-${what}-${testInfo.project.name}.png`,
        ),
      });
  };
  try {
    server = await startKonfab({
      env: {
        KONFAB_ISOLATED: "1",
        KONFAB_TELEGRAM_TOKEN: TOKEN,
        KONFAB_TELEGRAM_TEST: `http://127.0.0.1:${(telegram.address() as AddressInfo).port}`,
      },
    });
    const login = /[?&]code=([^\s&]+)/.exec(
      execFileSync("node", ["dist/cli/login-link.js"], {
        env: server.env,
        encoding: "utf8",
      }),
    )![1];
    await page.goto(`${server.baseUrl}/login?code=${login}`);
    await page.getByRole("button", { name: "⚙ Settings" }).click();
    const setup = page
      .getByRole("region", { name: "Settings" })
      .getByRole("region", { name: "Phone notices" });
    await setup.getByRole("button", { name: "Set up…" }).click();
    await shot("start");
    await setup.getByRole("button", { name: "Start" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      setup.getByRole("heading", { name: /Your chat/ }),
    ).toBeFocused();
    await expect(setup).toContainText("@konfab_bot");
    await setup.getByRole("button", { name: "Show a code" }).click();
    const shown = setup.locator(".phone-code");
    await expect(shown).toHaveText(/^KONFAB-/);
    await shot("code");
    await page.setViewportSize({ width: 375, height: 800 });
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    code = (await shown.textContent())!;
    await expect(
      setup.getByRole("heading", { name: /Is this you/ }),
    ).toBeFocused({
      timeout: 15_000,
    });
    expect(sent).toEqual([]);
    await setup.getByRole("button", { name: "Send a test" }).click();
    await expect(
      setup.getByRole("heading", { name: /Did the test arrive/ }),
    ).toBeFocused();
    expect(sent).toEqual(["Konfab: test"]);
    await shot("test");
    await setup.getByRole("button", { name: "Yes, it arrived" }).click();
    await shot("finish");
    await setup.getByRole("button", { name: "Turn on" }).click();
    const toggle = setup.getByRole("checkbox");
    await expect(toggle).toBeChecked();
    await shot("done");
    await setup.getByRole("button", { name: "Send a test" }).click();
    await expect(setup).toContainText("Sent “Konfab: test”.");
    expect(sent).toHaveLength(2);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    // The command line says the same.
    expect(
      execFileSync("node", ["dist/cli/setup.js", "--telegram", "--status"], {
        env: server.env,
        encoding: "utf8",
      }),
    ).toContain("off, to Lead");
    const content = await page.content();
    expect(content).not.toContain(SECRET);
    expect(content).not.toContain("987654321");
    page.once("dialog", (question) => void question.accept());
    await setup.getByRole("button", { name: "Remove" }).click();
    await expect(setup.getByRole("button", { name: "Set up…" })).toBeVisible();
    // Nothing that Konfab wrote has the token.
    const look = (folder: string): void => {
      for (const name of readdirSync(folder)) {
        const path = join(folder, name);
        if (statSync(path).isDirectory()) look(path);
        else if (statSync(path).isFile())
          expect(readFileSync(path).toString("latin1"), name).not.toContain(
            SECRET,
          );
      }
    };
    look(server.env.KONFAB_HOME!);
  } finally {
    server?.stop();
    telegram.close();
  }
});
