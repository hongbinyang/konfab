// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RichText } from "../../web/src/RichText";

afterEach(cleanup);

const html = (body: string, chat = true) =>
  render(<RichText chat={chat}>{body}</RichText>).container;

describe("message formatting", () => {
  it("renders a pipe table as a table that scrolls instead of widening the page", () => {
    const view = html(
      [
        "| What you see | What it is |",
        "|---|:--:|",
        "| `max_n_episodes=-1` | **all** demos |",
        "| 100% | done |",
      ].join("\n"),
    );
    const table = view.querySelector(".table-scroll > table");
    expect(table).not.toBeNull();
    expect(
      [...table!.querySelectorAll("th")].map((cell) => cell.textContent),
    ).toEqual(["What you see", "What it is"]);
    const rows = table!.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("code")?.textContent).toBe(
      "max_n_episodes=-1",
    );
    expect(rows[0].querySelector("strong")?.textContent).toBe("all");
  });

  it("renders bullet, numbered and task lists, strikethrough and quotes", () => {
    const view = html(
      [
        "- one",
        "  - nested",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "- [x] done",
        "- [ ] open",
        "",
        "~~old~~ and > not a quote",
        "",
        "> quoted",
      ].join("\n"),
    );
    expect(view.querySelectorAll("ul ul li")).toHaveLength(1);
    expect(view.querySelectorAll("ol li")).toHaveLength(2);
    const boxes = view.querySelectorAll<HTMLInputElement>(
      "li.task-list-item input[type=checkbox]",
    );
    expect([...boxes].map((box) => box.checked)).toEqual([true, false]);
    expect(view.querySelector("del")?.textContent).toBe("old");
    expect(view.querySelector("blockquote")?.textContent?.trim()).toBe(
      "quoted",
    );
  });

  it("keeps single line breaks in chat, as Slack does, but not in documents", () => {
    expect(html("line one\nline two").querySelectorAll("br")).toHaveLength(1);
    expect(html("line one\nline two", false).querySelector("br")).toBeNull();
  });

  it("drops unsafe link targets and keeps mentions as plain text", () => {
    const view = html(
      "@codex see [click](javascript:alert(1)) and [data](data:text/html,x)",
    );
    for (const link of view.querySelectorAll("a"))
      expect(link.getAttribute("href") ?? "").not.toMatch(
        /^(javascript|data):/i,
      );
    expect(view.textContent).toContain("@codex see click and data");
  });

  it("doesn't render raw HTML and opens links in a new tab", () => {
    const view = html(
      '<img src=x onerror="alert(1)"> see https://example.com and [docs](https://example.com/docs)',
    );
    expect(view.querySelector("img")).toBeNull();
    const links = [...view.querySelectorAll("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com",
      "https://example.com/docs",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });
});
