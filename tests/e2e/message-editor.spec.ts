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

let rooms = 0;
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const box = (page: Page) =>
  page.getByRole("textbox", { name: "Message", exact: true });

/** A new room with the rich box ready. Fails the test on any page error. */
async function open(page: Page, project: string, rich = true): Promise<void> {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto(loginUrl());
  rooms += 1;
  const name = `editor-${project}-${rooms}-${Date.now()}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create room" }).click();
  await expect(page.getByRole("heading", { name: `# ${name}` })).toBeVisible();
  if (rich) await expect(page.locator(".message-editor-text")).toBeVisible();
  await box(page).click();
}

/** Sends, and returns the exact text the server received. */
async function send(
  page: Page,
  how = () => page.keyboard.press(`${MOD}+Enter`),
) {
  const request = page.waitForRequest(
    (item) => item.method() === "POST" && /\/messages$/.test(item.url()),
  );
  await how();
  const sent = await request;
  if ((await sent.response())?.ok()) {
    await expect(box(page)).toHaveText("");
    await expect(page.getByText("Sending…")).toHaveCount(0);
  }
  return sent.postDataJSON() as { body: string; attachment_ids: string[] };
}

/** The page's own code, as text: these tests have no DOM types. */
async function paste(
  page: Page,
  text: string | null,
  html = "",
  image = false,
): Promise<void> {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await page.evaluate(`{
    const data = new DataTransfer();
    const [text, html, image] = ${JSON.stringify([text, html, image])};
    if (text !== null) data.setData("text/plain", text);
    if (html) data.setData("text/html", html);
    if (image) {
      const bytes = Uint8Array.from(atob("${png}"), (char) => char.charCodeAt(0));
      data.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    }
    document.activeElement.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }`);
}

test("shortcuts format in the box, with the menu hidden, and the message looks the same", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  await expect(page.getByRole("toolbar")).toBeHidden();
  await page.keyboard.type("plain ");
  for (const [key, tag] of [
    ["b", "strong"],
    ["i", "em"],
    ["Shift+x", "s"],
    ["e", "code"],
  ] as const) {
    await page.keyboard.press(`${MOD}+${key}`);
    await page.keyboard.type(tag);
    await expect(box(page).locator(tag)).toHaveText(tag);
    await page.keyboard.press(`${MOD}+${key}`);
    await page.keyboard.type(" ");
  }
  await expect(box(page)).toHaveText(/^plain strong em s code\s*$/);
  for (const [key, tag] of [
    ["8", "ul"],
    ["7", "ol"],
    ["9", "blockquote"],
  ] as const) {
    await page.keyboard.press("Enter");
    await page.keyboard.type(tag);
    await page.keyboard.press(`${MOD}+Shift+${key}`);
    await expect(box(page).locator(tag).last()).toContainText(tag);
    await page.keyboard.press("Enter");
    if (tag === "blockquote") await page.keyboard.press("Enter");
    else await page.keyboard.press("Enter");
  }
  await page.keyboard.type("end");
  const { body } = await send(page);
  expect(body).toBe(
    "plain **strong** _em_ ~~s~~ `code` \n- ul\n\n1. ol\n\n> blockquote\n\nend",
  );
  const message = page.locator(".messages .rich-text").last();
  for (const tag of ["strong", "em", "del", "code", "ul", "ol", "blockquote"])
    await expect(message.locator(tag)).toHaveCount(1);
  await expect(box(page)).toHaveText("");
  // Writing again straight away starts clean.
  await page.keyboard.type("again");
  expect((await send(page)).body).toBe("again");
});

test("undo, redo, nesting, and typing a format with Backspace to take it back", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  await page.keyboard.type("bold");
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+b`);
  await expect(box(page).locator("strong")).toHaveCount(1);
  await page.keyboard.press(`${MOD}+z`);
  await expect(box(page).locator("strong")).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(box(page).locator("strong")).toHaveCount(1);
  expect((await send(page)).body).toBe("**bold**");

  await page.keyboard.type("- one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press(`${MOD}+]`);
  expect((await send(page)).body).toBe("- one\n  - two");

  await page.keyboard.type("- ");
  await expect(box(page).locator("ul")).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await expect(box(page).locator("ul")).toHaveCount(0);
  await page.keyboard.type("not a list **b**");
  await expect(box(page).locator("strong")).toHaveText("b");
  expect((await send(page)).body).toBe("- not a list **b**");
});

test("ordinary text, tables, task lists and code are sent exactly as written, and shown live", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  const text =
    "@codex x < y && z, array[0] src/__init__.py\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\n- [x] done\n- [ ] open\n```\n* code\n```\nend  ";
  await paste(page, text);
  // What can't be shown in the box is rendered under it, without a click.
  const live = page.getByRole("region", { name: "How it will look when sent" });
  await expect(live.locator("table")).toBeVisible();
  await expect(live.locator("input[type=checkbox]")).toHaveCount(2);
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(live).toBeHidden();
  await box(page).click();
  expect((await send(page)).body).toBe(text);
  await expect(page.locator(".messages table")).toBeVisible();
  // The mention reached the server as a mention.
  await expect(page.locator(".unreachable-notice")).toContainText("Codex");

  for (const line of ["```", "- x", "**y**", "```"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  expect((await send(page)).body).toBe("```\n- x\n**y**\n```\n");
});

test("a message that would look different is reviewed before it is sent", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  let posts = 0;
  page.on("request", (item) => {
    if (item.method() === "POST" && /\/messages$/.test(item.url())) posts += 1;
  });
  const write = async () => {
    await page.keyboard.type("foo!bar");
    await page.keyboard.press("Home");
    for (let count = 0; count < 4; count += 1)
      await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press(`${MOD}+b`);
  };
  const review = page.getByRole("dialog", {
    name: "This will look different when sent",
  });
  await write();
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(review).toContainText("“foo!” won't be bold");
  await expect(review.locator(".rich-text")).toHaveText("**foo!**bar");
  await expect(
    review.getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(box(page)).toBeFocused();
  await expect(box(page)).toHaveText("foo!bar");

  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.keyboard.press("Enter");
  await expect(box(page)).toBeFocused();
  expect(await page.evaluate("getSelection().toString()")).toBe("foo!");

  await page.keyboard.press(`${MOD}+Enter`);
  await review.getByRole("button", { name: "Remove that formatting" }).click();
  await expect(box(page).locator("strong")).toHaveCount(0);
  await expect(box(page)).toBeFocused();
  await page.keyboard.press(`${MOD}+z`);
  await expect(box(page).locator("strong")).toHaveText("foo!");
  expect(posts).toBe(0);

  await page.keyboard.press(`${MOD}+Enter`);
  const { body } = await send(page, () =>
    review.getByRole("button", { name: "Send as shown here" }).click(),
  );
  expect(body).toBe("**foo!**bar");
  await expect(box(page)).toHaveText("");

  // A difference that removing formats can't fix says so.
  await expect(box(page)).toBeFocused();
  await page.keyboard.type("- a \\[b");
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(review).toContainText("Markdown characters");
  await expect(
    review.getByRole("button", { name: "Remove that formatting" }),
  ).toHaveCount(0);
  expect(posts).toBe(1);
});

test("a failed send keeps the formatted draft and its attachment, and can be sent again", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  await paste(page, null, "", true);
  await expect(page.getByLabel("Remove shot.png")).toBeVisible();
  await page.keyboard.type("with **bold**");
  await page.route(/\/messages$/, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, body: '{"error":"no"}' })
      : route.continue(),
  );
  await page.keyboard.press(`${MOD}+Enter`);
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(box(page).locator("strong")).toHaveText("bold");
  await expect(page.getByLabel("Remove shot.png")).toBeVisible();
  await page.unroute(/\/messages$/);
  await box(page).click();
  const { body, attachment_ids } = await send(page);
  expect(body).toBe("with **bold**");
  expect(attachment_ids).toHaveLength(1);
  await expect(page.getByLabel("Remove shot.png")).toHaveCount(0);
});

test("paste keeps formats it can, and plain text when it can't", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  for (const [text, html, sent] of [
    [
      "b and l\none",
      '<p><b>b</b> and <a href="https://e.com">l</a></p><ul><li>one</li></ul>',
      "**b** and [l](https://e.com)\n- one",
    ],
    ["a\tb", "<table><tr><td><b>a</b></td><td>b</td></tr></table>", "a\tb"],
    ["x", '<a href="javascript:alert(1)">x</a>', "x"],
    [
      "not bold",
      '<b style="font-weight:normal"><p>not bold</p><i></i></b>',
      "not bold",
    ],
    ["one\ntwo", "<p><b>one</b><br>two</p>", "**one**\ntwo"],
    ["kept words", "<p><b>kept</b></p>", "kept words"],
  ] as const) {
    await paste(page, text, html);
    expect((await send(page)).body, html).toBe(sent);
    await expect(box(page)).toHaveText("");
  }
  // Copied here and pasted here keeps its formats.
  await page.keyboard.type("a **b**");
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.press(`${MOD}+c`);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press(`${MOD}+v`);
  await expect(box(page).locator("strong")).toHaveCount(2);
  expect((await send(page)).body).toBe("a **b**a **b**");
  // A double click in the empty box doesn't add a line.
  await box(page).dblclick();
  await page.keyboard.type("z");
  expect((await send(page)).body).toBe("z");
});

test("links ask for an address and refuse unsafe ones; emoji goes in at the cursor", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  await page.keyboard.type("see docs");
  for (let count = 0; count < 4; count += 1)
    await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press(`${MOD}+k`);
  const address = page.getByLabel("Link address");
  await expect(address).toBeFocused();
  await address.fill("javascript:alert(1)");
  await page.keyboard.press("Enter");
  await expect(page.locator(".message-editor-link [role=alert]")).toContainText(
    "https://",
  );
  await address.fill("https://example.com/a(b)");
  await page.keyboard.press("Enter");
  await expect(box(page)).toBeFocused();
  await expect(box(page).locator("a")).toHaveText("docs");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type(" ");
  await page.getByRole("button", { name: "Choose emoji" }).click();
  await page.getByRole("button", { name: "thinking", exact: true }).click();
  await page.keyboard.type("!");
  expect((await send(page)).body).toBe(
    "see [docs](<https://example.com/a(b)>) 🤔!",
  );
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Link address")).toHaveCount(0);
  await expect(box(page)).toBeFocused();
});

test("the formatting menu is optional and remembered, and every shortcut is listed", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  const menu = page.getByRole("button", { name: "Formatting menu" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  const toolbar = page.getByRole("toolbar", { name: "Formatting" });
  await expect(toolbar).toBeVisible();
  await page.reload();
  await expect(toolbar).toBeVisible();
  await box(page).click();
  await page.keyboard.type("x");
  await page.keyboard.press(`${MOD}+a`);
  const bold = toolbar.getByRole("button", { name: "Bold" });
  await bold.click();
  await expect(bold).toHaveAttribute("aria-pressed", "true");
  await expect(box(page)).toBeFocused();
  // One Tab stop, arrow keys inside, and Tab leaves the box.
  await bold.focus();
  await page.keyboard.press("ArrowRight");
  await expect(toolbar.getByRole("button", { name: "Italic" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(box(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(box(page)).not.toBeFocused();

  await page.getByRole("button", { name: "Shortcuts" }).click();
  const list = page.getByRole("table", { name: "Formatting shortcuts" });
  for (const name of [
    "Bold",
    "Italic",
    "Strikethrough",
    "Code",
    "Link",
    "Bulleted list",
    "Numbered list",
    "Quote",
    "Nest a list item",
    "Un-nest a list item",
    "Undo",
    "Redo",
    "New line in the same list item",
    "Send",
  ])
    await expect(
      list.getByRole("rowheader", { name, exact: true }),
    ).toBeVisible();
});

test("plain text keeps the same text both ways, is remembered, and is the fallback", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  const text = "**b** x < y\n- a\n  - b\n\n| t |\n|---|";
  await paste(page, text);
  const plain = page.getByRole("button", { name: "Plain text" });
  await plain.click();
  await expect(page.locator("textarea#message")).toHaveValue(text);
  await plain.click();
  await expect(page.locator(".message-editor-text")).toBeVisible();
  await plain.click();
  await page.reload();
  await expect(page.locator("textarea#message")).toBeVisible();
  await box(page).fill("typed **plainly**");
  expect((await send(page)).body).toBe("typed **plainly**");
  await page.evaluate("localStorage.clear()");

  // If the editor can't load, messages can still be written and sent.
  await page.route(/RichEditor-.*\.js/, (route) => route.abort());
  await page.reload();
  await box(page).fill("still works");
  expect((await send(page)).body).toBe("still works");
  await expect(page.locator(".message-editor-text")).toHaveCount(0);
});

test("text typed before the editor loads stays, and isn't swapped away", async ({
  page,
}, info) => {
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  await page.route(/RichEditor-.*\.js/, async (route) => {
    await held;
    await route.continue();
  });
  await open(page, info.project.name, false);
  await page.keyboard.type("early");
  release();
  await page.waitForTimeout(500);
  await expect(page.locator("textarea#message")).toHaveValue("early");
  await page.keyboard.type(" bird");
  expect((await send(page)).body).toBe("early bird");
  await expect(page.locator(".message-editor-text")).toBeVisible();
  await expect(box(page)).toBeFocused();
  await page.keyboard.type("later");
  expect((await send(page)).body).toBe("later");
});

test("composing with an input method, also after sending", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  const session = await page.context().newCDPSession(page);
  for (const format of ["", "b", ""]) {
    if (format) await page.keyboard.press(`${MOD}+${format}`);
    for (const step of ["n", "に", "にほ"]) {
      await session.send("Input.imeSetComposition", {
        text: step,
        selectionStart: step.length,
        selectionEnd: step.length,
      });
      await page.waitForTimeout(40);
    }
    await session.send("Input.insertText", { text: "日本" });
    await expect(box(page)).toHaveText("日本");
    expect((await send(page)).body).toBe(format ? "**日本**" : "日本");
    await expect(box(page)).toHaveText("");
  }
});

test("fits a phone-width page", async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, info.project.name);
  await page.getByRole("button", { name: "Formatting menu" }).click();
  await page.getByRole("button", { name: "Shortcuts" }).click();
  await box(page).click();
  await paste(page, `| ${"wide | ".repeat(20)}\n|${"---|".repeat(20)}`);
  await expect(page.getByRole("region", { name: /How it will/ })).toBeVisible();
  expect(
    await page.evaluate("document.documentElement.scrollWidth"),
  ).toBeLessThanOrEqual(375);
});

for (const mode of ["rich", "plain"] as const)
  for (const outcome of ["succeeds", "fails"] as const)
    test(`text and files added during a slow send are kept when it ${outcome} (${mode} box)`, async ({
      page,
    }, info) => {
      await open(page, info.project.name);
      if (mode === "plain") {
        await page.getByRole("button", { name: "Plain text" }).click();
        await expect(page.locator("textarea#message")).toBeFocused();
      }
      const text = () =>
        page.evaluate<string>(
          `(() => { const box = document.getElementById("message"); return box.value ?? [...box.children].map((line) => line.textContent).join("\\n"); })()`,
        );
      await paste(page, null, "", true);
      await expect(page.getByLabel("Remove shot.png")).toHaveCount(1);
      await page.keyboard.type("first **one**");

      let answer = () => {};
      const held = new Promise<void>((done) => {
        answer = done;
      });
      const bodies: { body: string; attachment_ids: string[] }[] = [];
      await page.route(/\/messages$/, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        bodies.push(route.request().postDataJSON() as (typeof bodies)[number]);
        if (bodies.length > 1) return route.continue();
        await held;
        if (outcome === "fails")
          return route.fulfill({ status: 500, body: '{"error":"no"}' });
        return route.continue();
      });
      await page.keyboard.press(`${MOD}+Enter`);
      await expect(page.getByText("Sending…")).toBeVisible();
      await expect(page.getByLabel("Remove shot.png")).toHaveCount(0);
      expect(await text()).toBe("");

      // Written, attached and even sent again while the first is on its way.
      await page.keyboard.type("second");
      await paste(page, null, "", true);
      await expect(page.getByLabel("Remove shot.png")).toHaveCount(1);
      await page.keyboard.press(`${MOD}+Enter`);
      await page.waitForTimeout(100);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.body).toBe("first **one**");
      expect(bodies[0]?.attachment_ids).toHaveLength(1);
      expect(await text()).toBe("second");

      answer();
      await expect(page.getByText("Sending…")).toHaveCount(0);
      const kept = outcome === "fails";
      await expect(page.getByLabel("Remove shot.png")).toHaveCount(
        kept ? 2 : 1,
      );
      const first = mode === "rich" ? "first one" : "first **one**";
      await expect.poll(text).toBe(kept ? `${first}\nsecond` : "second");
      // The cursor is still where it was.
      await page.keyboard.type("!");
      await expect.poll(text).toBe(kept ? `${first}\nsecond!` : "second!");

      await send(page);
      expect(bodies).toHaveLength(2);
      expect(bodies[1]?.body).toBe(kept ? "first **one**\nsecond!" : "second!");
      expect(bodies[1]?.attachment_ids).toHaveLength(kept ? 2 : 1);
      expect(new Set(bodies[1]?.attachment_ids).size).toBe(kept ? 2 : 1);
      if (!kept)
        expect(bodies[1]?.attachment_ids).not.toEqual(
          bodies[0]?.attachment_ids,
        );
    });

test("formats a reviewed message shows come back if it can't be sent", async ({
  page,
}, info) => {
  await open(page, info.project.name);
  await page.keyboard.type("foo!bar");
  await page.keyboard.press("Home");
  for (let count = 0; count < 4; count += 1)
    await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press(`${MOD}+b`);
  await page.route(/\/messages$/, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, body: '{"error":"no"}' })
      : route.continue(),
  );
  await page.keyboard.press(`${MOD}+Enter`);
  await page.getByRole("button", { name: "Send as shown here" }).click();
  await expect(box(page).locator("strong")).toHaveText("foo!");
});

for (const mode of ["rich", "plain"] as const)
  test(`a send that fails during a composition puts the draft back after it (${mode} box)`, async ({
    page,
  }, info) => {
    await open(page, info.project.name);
    if (mode === "plain") {
      await page.getByRole("button", { name: "Plain text" }).click();
      await expect(page.locator("textarea#message")).toBeFocused();
    }
    let answer = () => {};
    const held = new Promise<void>((done) => {
      answer = done;
    });
    await page.route(/\/messages$/, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      return route.fulfill({ status: 500, body: '{"error":"no"}' });
    });
    await page.keyboard.type("first");
    await page.keyboard.press(`${MOD}+Enter`);
    await expect(page.getByText("Sending…")).toBeVisible();
    const session = await page.context().newCDPSession(page);
    const compose = (text: string) =>
      session.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    await compose("に");
    await page.waitForTimeout(50);
    answer();
    await expect(page.getByText("Sending…")).toHaveCount(0);
    await compose("にほ");
    await page.waitForTimeout(50);
    await session.send("Input.insertText", { text: "日本" });
    await page.unroute(/\/messages$/);
    await page.waitForTimeout(200);
    await page.keyboard.type("!");
    expect((await send(page)).body).toBe("first\n日本!");
  });
