// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAgentForm } from "../../web/src/AddAgentForm";
import { json, stubSkillApi } from "./skill-fetch";

const overview = {
  agents: [
    {
      id: "claude",
      display_name: "Claude",
      app_id: "claude",
      app_name: "Claude",
      is_default: 1,
    },
    {
      id: "codex",
      display_name: "Codex",
      app_id: "codex",
      app_name: "Codex",
      is_default: 1,
    },
    {
      id: "codex-dev",
      display_name: "Codex dev",
      app_id: "codex",
      app_name: "Codex",
      is_default: 0,
    },
  ],
  apps: [
    { id: "claude", display_name: "Claude", default_agent_id: "claude" },
    { id: "codex", display_name: "Codex", default_agent_id: "codex" },
  ],
  max_agents_per_app: 2,
};

let api: ReturnType<typeof stubSkillApi>;
let agentResponse: () => Response;

beforeEach(() => {
  agentResponse = () => json(201, { ok: true });
  if (!HTMLDialogElement.prototype.showModal)
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  if (!HTMLDialogElement.prototype.close)
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
  api = stubSkillApi({ "/api/agents": () => agentResponse() });
  vi.stubGlobal("fetch", api.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const setup = () => {
  const onAdded = vi.fn(async () => undefined);
  const onCancel = vi.fn();
  render(
    <AddAgentForm
      overview={overview}
      roomId={7}
      onAdded={onAdded}
      onCancel={onCancel}
    />,
  );
  return { user: userEvent.setup(), onAdded, onCancel };
};

describe("Add agent form", () => {
  it("suggests an ID, disables full apps and adds a plain agent", async () => {
    const { user, onAdded } = setup();
    await user.type(screen.getByLabelText("Display name"), "Claude");
    expect((screen.getByLabelText(/Agent ID/) as HTMLInputElement).value).toBe(
      "claude-2",
    );
    const codex = screen.getByRole("option", {
      name: "Codex (2/2)",
    }) as HTMLOptionElement;
    expect(codex.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const post = api.calls.find((call) => call.url === "/api/agents")!;
    expect(post.body).toEqual({
      id: "claude-2",
      display_name: "Claude",
      app_id: "claude",
      room_id: 7,
    });
  });

  it("chooses skills and instructions in the picker and sends them with the new agent", async () => {
    const { user, onAdded } = setup();
    await user.type(screen.getByLabelText("Display name"), "Tester");
    await user.click(screen.getByRole("button", { name: "Choose skills…" }));
    await user.click(await screen.findByRole("button", { name: "Add qa" }));
    await user.click(screen.getByRole("button", { name: "Add fresh" }));
    await user.type(screen.getByLabelText(/Room instructions/), "Be brief");
    // In this mode nothing is saved yet; the selection returns to the form.
    await user.click(
      screen.getByRole("button", { name: "Use these 2 skills" }),
    );
    expect(api.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(screen.getByText("qa · full text")).toBeTruthy();
    expect(screen.getByText("Instructions: Be brief")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const post = api.calls.find((call) => call.url === "/api/agents")!;
    expect(post.body).toEqual({
      id: "tester",
      display_name: "Tester",
      app_id: "claude",
      room_id: 7,
      assignment: {
        instructions: "Be brief",
        pins: [
          {
            skill_id: "builtin:qa",
            revision_id: "11111111-1111-4111-8111-0000000000a1",
            delivery: "full",
          },
          {
            skill_id: "s-new",
            revision_id: "11111111-1111-4111-8111-000000000009",
            delivery: "full",
          },
        ],
        review: ["11111111-1111-4111-8111-000000000009"],
        confirmed: true,
      },
    });
  });

  it("does not send skills for an agent not added to this room, and shows server errors", async () => {
    agentResponse = () =>
      json(409, { message: "That agent ID is already in use." });
    const { user, onAdded } = setup();
    await user.type(screen.getByLabelText("Display name"), "Helper");
    await user.click(screen.getByLabelText("Add to this room"));
    expect(screen.queryByRole("button", { name: "Choose skills…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "already in use",
    );
    expect(onAdded).not.toHaveBeenCalled();
    const post = api.calls.find((call) => call.url === "/api/agents")!;
    expect(post.body).toEqual({
      id: "helper",
      display_name: "Helper",
      app_id: "claude",
    });
  });
});
