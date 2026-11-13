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

  const choosePublic = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText("Display name"), "Webber");
    await user.click(screen.getByRole("button", { name: "Choose skills…" }));
    await user.click(
      await screen.findByRole("button", { name: /web-testing/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Add to selection" }),
    );
    await user.click(screen.getByRole("button", { name: "Use these 1 skill" }));
    await user.click(screen.getByRole("button", { name: "Add agent" }));
  };
  const posts = () => api.calls.filter((call) => call.url === "/api/agents");

  it("on a changed public skill, reopens the picker to review my saved version, then adds the agent with it", async () => {
    agentResponse = () =>
      posts().length === 1
        ? json(409, {
            code: "local_changes",
            message:
              "web-testing has local changes. Keep your version, or add the upstream skill as a separate skill.",
            pin: 0,
            local: {
              skill_id: "s-web",
              revision_id: "11111111-1111-4111-8111-0000000000c2",
              name: "web-testing",
              number: 2,
              reviewed: true,
              draft: false,
            },
          })
        : json(201, { ok: true });
    const { user, onAdded } = setup();
    await choosePublic(user);
    // No agent was added; the picker opens with the choice.
    const choice = await screen.findByRole("alertdialog");
    expect(onAdded).not.toHaveBeenCalled();
    await user.click(
      within(choice).getByRole("button", { name: "Keep my version" }),
    );
    expect(
      (await screen.findByLabelText("web-testing rev 2")).textContent,
    ).toContain("line from c2");
    await user.click(screen.getByRole("button", { name: "Use these 1 skill" }));
    expect(
      screen.getByText(/web-testing · full text · your saved version, rev 2/),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(posts()[1]!.body).toMatchObject({
      assignment: {
        pins: [
          {
            skill_id: "s-web",
            revision_id: "11111111-1111-4111-8111-0000000000c2",
            delivery: "full",
          },
        ],
        review: [],
      },
    });
  });

  it("cannot use or add the selection until my saved version has loaded", async () => {
    agentResponse = () =>
      posts().length === 1
        ? json(409, {
            code: "local_changes",
            message: "web-testing has local changes.",
            pin: 0,
            local: {
              skill_id: "s-web",
              revision_id: "11111111-1111-4111-8111-0000000000c2",
              name: "web-testing",
              number: 2,
              reviewed: true,
              draft: false,
            },
          })
        : json(201, { ok: true });
    let attempts = 0;
    let release: () => void = () => undefined;
    api.routes.files = (url) => {
      if (!url.includes("11111111-1111-4111-8111-0000000000c2"))
        return undefined;
      attempts += 1;
      if (attempts === 1) return json(500, { message: "Disk unavailable" });
      return new Promise((resolve) => {
        release = () => resolve(undefined);
      });
    };
    const { user, onAdded } = setup();
    await choosePublic(user);
    const choice = await screen.findByRole("alertdialog");
    const use = () =>
      screen.getByRole("button", {
        name: "Use these 1 skill",
      }) as HTMLButtonElement;
    await user.click(
      within(choice).getByRole("button", { name: "Keep my version" }),
    );
    expect((await within(choice).findByRole("alert")).textContent).toContain(
      "Disk unavailable",
    );
    expect(use().disabled).toBe(true);
    await user.click(within(choice).getByRole("button", { name: "Try again" }));
    expect(
      await within(choice).findByText("Loading your saved version…"),
    ).toBeTruthy();
    expect(use().disabled).toBe(true);
    release();
    await screen.findByLabelText("web-testing rev 2");
    expect(use().disabled).toBe(false);
    await user.click(use());
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(2);
  });

  it("keeps Add agent disabled when the picker is closed without a choice", async () => {
    agentResponse = () =>
      json(409, {
        code: "name_conflict",
        message: "A different skill named web-testing already exists.",
        pin: 0,
      });
    const { user, onAdded } = setup();
    await choosePublic(user);
    await screen.findByRole("alertdialog");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "needs a choice",
    );
    expect(
      (screen.getByRole("button", { name: "Add agent" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("offers only a separate copy when a different skill has the name, then adds the agent", async () => {
    agentResponse = () =>
      posts().length === 1
        ? json(409, {
            code: "name_conflict",
            message:
              "A different skill named web-testing already exists. Choose another name for this copy.",
            pin: 0,
          })
        : json(201, { ok: true });
    const { user, onAdded } = setup();
    await choosePublic(user);
    const choice = await screen.findByRole("alertdialog");
    expect(
      within(choice).queryByRole("button", { name: "Keep my version" }),
    ).toBeNull();
    await user.click(
      within(choice).getByRole("button", { name: "Add as web-testing-2" }),
    );
    await user.click(screen.getByRole("button", { name: "Use these 1 skill" }));
    expect(screen.getByText(/added as web-testing-2/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    const pin = (
      posts()[1]!.body as {
        assignment: { pins: Array<{ public: Record<string, unknown> }> };
      }
    ).assignment.pins[0]!;
    expect(pin.public).toMatchObject({ copy_name: "web-testing-2" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
