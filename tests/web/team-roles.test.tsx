// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomAgent } from "../../web/src/api";
import { TeamRoles } from "../../web/src/TeamRoles";

const agent = (id: string, name: string, role: string) =>
  ({ id, display_name: name, role }) as unknown as RoomAgent;

let posts: Array<{ url: string; body: unknown }>;
let reassignStatus: number;

beforeEach(() => {
  posts = [];
  reassignStatus = 200;
  if (!HTMLDialogElement.prototype.showModal)
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return reassignStatus === 200
          ? respond(200, { ok: true })
          : respond(reassignStatus, { message: "Role assignment changed" });
      }
      if (url === "/api/roles") return respond(200, { roles: [] });
      const member = /members\/([^/]+)\/role-preview/.exec(url)?.[1];
      return respond(200, {
        assignment: {
          revision: member === "claude" ? 4 : 2,
          notes: `${member} notes`,
          assigned: true,
        },
      });
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
    <TeamRoles
      roomId={3}
      agents={[
        agent("claude", "Claude", "Product manager"),
        agent("codex", "Codex", "Developer"),
      ]}
      onApplied={onApplied}
      onClose={onClose}
    />,
  );
  return { user: userEvent.setup(), onApplied, onClose };
};

describe("Team roles dialog", () => {
  it("swaps two roles and applies them with base revisions", async () => {
    const { user, onApplied, onClose } = setup();
    const swapWith = await screen.findAllByLabelText(/Swap with/);
    expect(
      screen.getByRole("button", { name: /Apply 0 changes/ }),
    ).toBeTruthy();
    await user.selectOptions(swapWith[0]!, "codex");
    await user.click(screen.getByRole("button", { name: /Apply 2 changes/ }));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(posts).toEqual([
      {
        url: "/api/rooms/3/roles/reassign",
        body: {
          changes: [
            { agent_id: "claude", base_revision: 4, from_agent_id: "codex" },
            { agent_id: "codex", base_revision: 2, from_agent_id: "claude" },
          ],
        },
      },
    ]);
  });

  it("keeps the dialog open and shows the error when applying fails", async () => {
    reassignStatus = 409;
    const { user, onApplied, onClose } = setup();
    const swapWith = await screen.findAllByLabelText(/Swap with/);
    await user.selectOptions(swapWith[0]!, "codex");
    await user.click(screen.getByRole("button", { name: /Apply 2 changes/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Role assignment changed",
    );
    expect(onApplied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
