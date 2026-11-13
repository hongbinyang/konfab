// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomAgent } from "../../web/src/api";
import { TeamSkills } from "../../web/src/TeamSkills";

const agent = (id: string, name: string, label: string, revision: number) =>
  ({
    id,
    display_name: name,
    assignment: {
      label,
      revision,
      instructions: `${id} notes`,
      skill_count: 1,
      update_available: false,
    },
  }) as unknown as RoomAgent;

let posts: Array<{ url: string; body: unknown }>;
let status: number;

beforeEach(() => {
  posts = [];
  status = 200;
  if (!HTMLDialogElement.prototype.showModal)
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  if (!HTMLDialogElement.prototype.close)
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
      return new Response(
        JSON.stringify(
          status === 200
            ? { ok: true }
            : { message: "Claude's assignment changed since the preview." },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setup = () => {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(
    <TeamSkills
      roomId={3}
      agents={[
        agent("claude", "Claude", "pm rev 1", 4),
        agent("codex", "Codex", "konfab-dev rev 2", 2),
      ]}
      onApplied={onApplied}
      onClose={onClose}
    />,
  );
  return { user: userEvent.setup(), onApplied, onClose };
};

describe("Team dialog", () => {
  it("swaps two bundles and applies them with base revisions", async () => {
    const { user, onApplied, onClose } = setup();
    expect(
      screen.getByRole("button", { name: /Apply 0 changes/ }),
    ).toBeTruthy();
    await user.selectOptions(
      screen.getByLabelText("Swap Claude's skills with"),
      "codex",
    );
    expect(
      screen.getByText("Claude: pm rev 1 → konfab-dev rev 2"),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Apply 2 changes/ }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(posts).toEqual([
      {
        url: "/api/rooms/3/assignments/reassign",
        body: {
          changes: [
            { agent_id: "claude", base_revision: 4, from_agent_id: "codex" },
            { agent_id: "codex", base_revision: 2, from_agent_id: "claude" },
          ],
        },
      },
    ]);
  });

  it("removes a bundle, undoes it, and shows a stale-preview error without closing", async () => {
    status = 409;
    const { user, onApplied, onClose } = setup();
    await user.click(
      screen.getByRole("button", { name: "Remove Codex's skills" }),
    );
    expect(
      screen.getByText("Codex: konfab-dev rev 2 → No skills"),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      screen.getByRole("button", { name: /Apply 0 changes/ }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Remove Codex's skills" }),
    );
    await user.click(screen.getByRole("button", { name: /Apply 1 changes/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "changed since the preview",
    );
    expect(posts[0]!.body).toEqual({
      changes: [
        { agent_id: "claude", base_revision: 4, from_agent_id: "claude" },
        { agent_id: "codex", base_revision: 2, none: true },
      ],
    });
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
