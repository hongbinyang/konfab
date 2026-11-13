// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddAgentForm } from "../../web/src/AddAgentForm";

type Handler = (url: string, init?: RequestInit) => unknown | Promise<unknown>;

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

const roleList = {
  roles: [
    { id: "builtin:qa", revision_id: "rev-qa", name: "qa", title: "QA" },
    {
      id: "builtin:reviewer",
      revision_id: "rev-reviewer-1",
      name: "reviewer",
      title: "Reviewer",
    },
    {
      id: "personal:risky",
      revision_id: "rev-risky",
      name: "risky",
      title: "Risky",
    },
  ],
};

const preview = (id: string, revision: string, number: number) => ({
  id,
  revision_id: revision,
  number,
  title: id === "builtin:qa" ? "QA" : "Reviewer",
  role_md: `Instructions for ${id} rev ${number}`,
  skills: [],
});

let routes: Record<string, Handler>;
let posts: Array<{ url: string; body: unknown }>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  posts = [];
  routes = {
    "/api/roles": () => roleList,
    "/api/roles/builtin%3Aqa": () => preview("builtin:qa", "rev-qa", 3),
    "/api/roles/builtin%3Areviewer": () =>
      preview("builtin:reviewer", "rev-reviewer-1", 1),
    "/api/roles/personal%3Arisky": () => ({
      id: "personal:risky",
      revision_id: "rev-risky",
      number: 2,
      title: "Risky",
      role_md: "Risky role",
      skills: [{ name: "deploy-prod", reviewed: 0 }],
    }),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json(201, { ok: true });
      }
      const handler = routes[url];
      if (!handler) return json(404, { message: `No route ${url}` });
      return json(200, await handler(url, init));
    }),
  );
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

const submit = () => screen.getByRole("button", { name: "Add agent" });

describe("Add agent form", () => {
  it("suggests a unique ID from the name and disables full apps", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Display name"), "Codex dev");
    expect(screen.getByLabelText(/Agent ID/)).toHaveProperty(
      "value",
      "codex-dev-2",
    );
    const app = screen.getByLabelText(/^App/) as HTMLSelectElement;
    expect(app.value).toBe("claude");
    const codex = [...app.options].find((option) => option.value === "codex");
    expect(codex?.disabled).toBe(true);
    expect(codex?.textContent).toBe("Codex (2/2)");
  });

  it("adds an agent without a role", async () => {
    const { user, onAdded } = setup();
    await user.type(screen.getByLabelText("Display name"), "Helper");
    await user.click(submit());
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(posts).toEqual([
      {
        url: "/api/agents",
        body: {
          id: "helper",
          display_name: "Helper",
          app_id: "claude",
          room_id: 7,
        },
      },
    ]);
  });

  it("requires a preview and confirmation of the exact revision", async () => {
    const { user, onAdded } = setup();
    await user.type(screen.getByLabelText("Display name"), "Reviewer");
    await screen.findByRole("option", { name: "Reviewer" });
    await user.selectOptions(
      screen.getByLabelText(/^Role in this room/),
      "builtin:reviewer",
    );
    await screen.findByText("Preview: Reviewer · rev 1");
    expect(
      screen.getByText("Instructions for builtin:reviewer rev 1"),
    ).toBeTruthy();
    expect(submit()).toHaveProperty("disabled", true);
    await user.click(screen.getByLabelText(/I reviewed this role \(rev 1\)/));
    expect(submit()).toHaveProperty("disabled", false);
    await user.click(submit());
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(posts[0]?.body).toMatchObject({
      role: {
        role_id: "builtin:reviewer",
        role_revision_id: "rev-reviewer-1",
        confirmed: true,
      },
    });
  });

  it("clears the confirmation when the role changes", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Display name"), "Reviewer");
    await screen.findByRole("option", { name: "Reviewer" });
    const role = screen.getByLabelText(/^Role in this room/);
    await user.selectOptions(role, "builtin:reviewer");
    await user.click(
      await screen.findByLabelText(/I reviewed this role \(rev 1\)/),
    );
    await user.selectOptions(role, "builtin:qa");
    await screen.findByText("Preview: QA · rev 3");
    expect(
      (screen.getByLabelText(/I reviewed this role/) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(submit()).toHaveProperty("disabled", true);
  });

  it("ignores a late preview for an earlier choice", async () => {
    let releaseStale: () => void = () => undefined;
    let reviewerCalls = 0;
    routes["/api/roles/builtin%3Areviewer"] = async () => {
      reviewerCalls += 1;
      if (reviewerCalls === 1) {
        await new Promise<void>((resolve) => (releaseStale = resolve));
        return preview("builtin:reviewer", "rev-stale", 99);
      }
      return preview("builtin:reviewer", "rev-reviewer-1", 1);
    };
    const { user, onAdded } = setup();
    await user.type(screen.getByLabelText("Display name"), "Reviewer");
    await screen.findByRole("option", { name: "Reviewer" });
    const role = screen.getByLabelText(/^Role in this room/);
    await user.selectOptions(role, "builtin:reviewer");
    await user.selectOptions(role, "builtin:qa");
    await user.selectOptions(role, "builtin:reviewer");
    await user.click(
      await screen.findByLabelText(/I reviewed this role \(rev 1\)/),
    );
    releaseStale();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("Preview: Reviewer · rev 1")).toBeTruthy();
    expect(screen.queryByText(/rev 99/)).toBeNull();
    await user.click(submit());
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(posts[0]?.body).toMatchObject({
      role: { role_revision_id: "rev-reviewer-1", confirmed: true },
    });
  });

  it("blocks roles with unreviewed skills", async () => {
    const { user } = setup();
    await user.type(screen.getByLabelText("Display name"), "Ops");
    await screen.findByRole("option", { name: "Risky" });
    await user.selectOptions(
      screen.getByLabelText(/^Role in this room/),
      "personal:risky",
    );
    await screen.findByText(/Review deploy-prod in Manage library/);
    expect(screen.queryByLabelText(/I reviewed this role/)).toBeNull();
    expect(submit()).toHaveProperty("disabled", true);
  });

  it("shows server errors and calls cancel", async () => {
    const { user, onAdded, onCancel } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(409, { message: "That agent ID is already in use." }),
      ),
    );
    await user.type(screen.getByLabelText("Display name"), "Codex");
    await user.clear(screen.getByLabelText(/Agent ID/));
    await user.type(screen.getByLabelText(/Agent ID/), "codex");
    await user.click(submit());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That agent ID is already in use.",
    );
    expect(onAdded).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
