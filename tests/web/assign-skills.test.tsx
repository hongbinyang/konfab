// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssignSkills, lineDiff } from "../../web/src/AssignSkills";
import { json, stubSkillApi } from "./skill-fetch";

const REV_DEV_2 = "11111111-1111-4111-8111-000000000002";
const REV_DEV_3 = "11111111-1111-4111-8111-000000000003";
const REV_QA = "11111111-1111-4111-8111-0000000000a1";

let api: ReturnType<typeof stubSkillApi>;
let putResponses: Array<() => Response>;

beforeEach(() => {
  putResponses = [];
  if (!HTMLDialogElement.prototype.showModal)
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  if (!HTMLDialogElement.prototype.close)
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
  api = stubSkillApi({
    "/api/rooms/7/members/claude/assignment": (_url, init) => {
      if (init?.method === "PUT")
        return putResponses.shift()?.() ?? json(200, { ok: true });
      return {
        revision: 5,
        instructions: "Old notes",
        limit: 64 * 1024,
        skills: [
          {
            skill_id: "s-dev",
            revision_id: REV_DEV_2,
            name: "konfab-dev",
            number: 2,
            delivery: "full",
            reviewed: true,
            latest: { id: REV_DEV_3, number: 3, reviewed: 0 },
          },
        ],
      };
    },
  });
  vi.stubGlobal("fetch", api.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setup = () => {
  const onAssigned = vi.fn();
  const onClose = vi.fn();
  render(
    <AssignSkills
      roomId={7}
      agentId="claude"
      agentName="Claude"
      onAssigned={onAssigned}
      onClose={onClose}
    />,
  );
  return { user: userEvent.setup(), onAssigned, onClose };
};
const selectedList = () =>
  within(screen.getByRole("region", { name: "Selected skills" }));

describe("Assign skills dialog", () => {
  it("loads the current assignment, adds and orders skills, and saves exactly what is shown", async () => {
    const { user, onAssigned, onClose } = setup();
    expect(await selectedList().findByText(/konfab-dev rev 2/)).toBeTruthy();
    expect(screen.getByDisplayValue("Old notes")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Add qa" }));
    await user.click(screen.getByRole("button", { name: "Add fresh" }));
    // Move qa to the top and send fresh as a summary.
    await user.click(screen.getByRole("button", { name: "Move qa up" }));
    const fresh = selectedList()
      .getByText(/^fresh/)
      .closest("li")!;
    await user.click(within(fresh).getByRole("button", { name: "Summary" }));
    expect(within(fresh).getByText(/confirming reviews it/)).toBeTruthy();
    expect(screen.getByText(/Confirming marks fresh as reviewed/)).toBeTruthy();
    const instructions = screen.getByLabelText(/Room instructions/);
    await user.clear(instructions);
    await user.type(instructions, "Use your worktree");
    await user.click(
      screen.getByRole("button", { name: "Assign 3 skills to Claude" }),
    );
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    const put = api.calls.find((call) => call.method === "PUT")!;
    expect(put.body).toEqual({
      base_revision: 5,
      instructions: "Use your worktree",
      pins: [
        { skill_id: "builtin:qa", revision_id: REV_QA, delivery: "full" },
        { skill_id: "s-dev", revision_id: REV_DEV_2, delivery: "full" },
        {
          skill_id: "s-new",
          revision_id: "11111111-1111-4111-8111-000000000009",
          delivery: "summary",
        },
      ],
      review: ["11111111-1111-4111-8111-000000000009"],
    });
  });

  it("shows the changes of a newer revision and moves this member to it on confirm", async () => {
    const { user } = setup();
    await user.click(
      await screen.findByRole("button", { name: "Show changes" }),
    );
    const changes = await screen.findByLabelText("Changes");
    expect(changes.textContent).toContain("- line from 02");
    expect(changes.textContent).toContain("+ line from 03");
    await user.click(screen.getByRole("button", { name: "Use rev 3" }));
    expect(selectedList().getByText(/konfab-dev rev 3/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Assign 1 skill to Claude" }),
    );
    await waitFor(() =>
      expect(api.calls.some((call) => call.method === "PUT")).toBe(true),
    );
    const put = api.calls.find((call) => call.method === "PUT")!;
    expect(put.body).toMatchObject({
      pins: [{ skill_id: "s-dev", revision_id: REV_DEV_3 }],
      review: [REV_DEV_3],
    });
  });

  it("blocks an assignment that would exceed the delivery limit", async () => {
    api.routes["/api/library?scope=personal"] = () => ({
      skills: [
        {
          id: "big",
          current_revision_id: "11111111-1111-4111-8111-0000000000b1",
          name: "big",
          number: 1,
          description: "Long",
          reviewed_at: 1,
          licence: null,
        },
      ],
    });
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Add big" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/agents can receive up to 64.0 KiB/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Assign 2 skills to Claude",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("keeping my version shows that exact saved revision for review and assigns it as an ordinary pin", async () => {
    putResponses.push(() =>
      json(409, {
        code: "local_changes",
        message:
          "web-testing has local changes. Keep your version, or add the upstream skill as a separate skill.",
        pin: 1,
        local: {
          skill_id: "s-web",
          revision_id: "11111111-1111-4111-8111-0000000000c2",
          name: "web-testing",
          number: 2,
          reviewed: false,
          draft: true,
        },
      }),
    );
    const { user, onAssigned } = setup();
    await user.click(
      await screen.findByRole("button", { name: /web-testing/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add to selection" }),
    );
    const assign = () =>
      screen.getByRole("button", { name: "Assign 2 skills to Claude" });
    await user.click(assign());
    const choice = await screen.findByRole("alertdialog");
    expect(choice.textContent).toContain("has local changes");
    // Nothing can be assigned until the lead chooses.
    expect((assign() as HTMLButtonElement).disabled).toBe(true);
    await user.click(
      within(choice).getByRole("button", { name: "Keep my version" }),
    );
    // The saved revision itself is shown, with the draft caveat.
    const kept = await selectedList().findByLabelText("web-testing rev 2");
    expect(kept.textContent).toContain("line from c2");
    expect(
      selectedList().getByText(
        /unsaved changes in its folder are not included/,
      ),
    ).toBeTruthy();
    expect(
      selectedList().getAllByText(/Not reviewed — confirming reviews it/),
    ).toHaveLength(1);
    await user.click(assign());
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
    const puts = api.calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toMatchObject({
      pins: [
        { skill_id: "s-dev", revision_id: REV_DEV_2 },
        {
          skill_id: "s-web",
          revision_id: "11111111-1111-4111-8111-0000000000c2",
          delivery: "full",
        },
      ],
      review: ["11111111-1111-4111-8111-0000000000c2"],
    });
  });

  it("keeps confirmation disabled while my saved version loads or fails, and offers retry or a copy", async () => {
    putResponses.push(() =>
      json(409, {
        code: "local_changes",
        message: "web-testing has local changes.",
        pin: 1,
        local: {
          skill_id: "s-web",
          revision_id: "11111111-1111-4111-8111-0000000000c2",
          name: "web-testing",
          number: 2,
          reviewed: true,
          draft: false,
        },
      }),
    );
    let attempts = 0;
    let release: () => void = () => undefined;
    api.routes.files = (url) => {
      if (!url.includes("11111111-1111-4111-8111-0000000000c2"))
        return undefined;
      attempts += 1;
      if (attempts === 1) return json(500, { message: "Disk unavailable" });
      // The second attempt is slow.
      return new Promise((resolve) => {
        release = () => resolve(undefined);
      });
    };
    const { user, onAssigned } = setup();
    await user.click(
      await screen.findByRole("button", { name: /web-testing/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add to selection" }),
    );
    const assign = () =>
      screen.getByRole("button", {
        name: "Assign 2 skills to Claude",
      }) as HTMLButtonElement;
    await user.click(assign());
    const choice = await screen.findByRole("alertdialog");
    await user.click(
      within(choice).getByRole("button", { name: "Keep my version" }),
    );
    // Failed: the choice stays, with the reason and a retry; nothing can be assigned.
    expect((await within(choice).findByRole("alert")).textContent).toContain(
      "Disk unavailable",
    );
    expect(assign().disabled).toBe(true);
    expect(
      within(choice).getByRole("button", { name: "Add as web-testing-2" }),
    ).toBeTruthy();
    // Delayed: still disabled while loading.
    await user.click(within(choice).getByRole("button", { name: "Try again" }));
    expect(
      await within(choice).findByText("Loading your saved version…"),
    ).toBeTruthy();
    expect(assign().disabled).toBe(true);
    expect(
      (
        within(choice).getByRole("button", {
          name: "Add as web-testing-2",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    release();
    expect(
      (await selectedList().findByLabelText("web-testing rev 2")).textContent,
    ).toContain("line from c2");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(assign().disabled).toBe(false);
    await user.click(assign());
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
  });

  it("locks the selection while a choice is open, so the kept revision replaces the right skill", async () => {
    putResponses.push(() =>
      json(409, {
        code: "local_changes",
        message: "web-testing has local changes.",
        pin: 1,
        local: {
          skill_id: "s-web",
          revision_id: "11111111-1111-4111-8111-0000000000c2",
          name: "web-testing",
          number: 2,
          reviewed: true,
          draft: false,
        },
      }),
    );
    let release: () => void = () => undefined;
    api.routes.files = (url) =>
      url.includes("11111111-1111-4111-8111-0000000000c2")
        ? new Promise((resolve) => {
            release = () => resolve(undefined);
          })
        : undefined;
    const { user } = setup();
    await user.click(
      await screen.findByRole("button", { name: /web-testing/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add to selection" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Assign 2 skills to Claude" }),
    );
    const choice = await screen.findByRole("alertdialog");
    const disabled = (name: string) =>
      (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
    // While the choice is open, and during the slow load, nothing in the list can change.
    for (const name of [
      "Move web-testing up",
      "Remove web-testing",
      "Move konfab-dev down",
      "Remove konfab-dev",
      "Add qa",
    ])
      expect(disabled(name)).toBe(true);
    await user.click(
      within(choice).getByRole("button", { name: "Keep my version" }),
    );
    expect(disabled("Move web-testing up")).toBe(true);
    expect(disabled("Remove konfab-dev")).toBe(true);
    release();
    await selectedList().findByLabelText("web-testing rev 2");
    const items = selectedList().getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("konfab-dev rev 2");
    expect(items[1]!.textContent).toContain("web-testing rev 2");
    expect(disabled("Remove konfab-dev")).toBe(false);
  });

  it("adds a separate copy when a different skill has the name", async () => {
    putResponses.push(() =>
      json(409, {
        code: "name_conflict",
        message: "A different skill named web-testing already exists.",
        pin: 1,
      }),
    );
    const { user, onAssigned } = setup();
    await user.click(
      await screen.findByRole("button", { name: /web-testing/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add to selection" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Assign 2 skills to Claude" }),
    );
    const choice = await screen.findByRole("alertdialog");
    expect(
      within(choice).queryByRole("button", { name: "Keep my version" }),
    ).toBeNull();
    await user.click(
      within(choice).getByRole("button", { name: "Add as web-testing-2" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Assign 2 skills to Claude" }),
    );
    await waitFor(() => expect(onAssigned).toHaveBeenCalled());
    const puts = api.calls.filter((call) => call.method === "PUT");
    expect((puts[1]!.body as { pins: unknown[] }).pins[1]).toEqual({
      public: {
        source_id: "22222222-2222-4222-8222-000000000001",
        commit: "a".repeat(40),
        path: "skills/web-testing",
        preview_hash: "f".repeat(64),
        copy_name: "web-testing-2",
      },
      delivery: "full",
    });
  });

  it("diffs lines removed from and added to a skill", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: "removed", line: "b" },
      { kind: "added", line: "d" },
    ]);
  });
});
