// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContactNotice, UnreachableNotice } from "../../web/src/ContactNotice";

const at = new Date(2026, 10, 12, 17, 0).getTime();
const time = new Date(at).toLocaleTimeString([], {
  hour: "numeric",
  minute: "2-digit",
});
const agent = (
  overrides: Partial<Parameters<typeof ContactNotice>[0]["agent"]>,
) => ({
  state: "not_responding" as const,
  working: null,
  stats: { last_contact_at: at } as never,
  join_prompt: "Join Konfab room konfab",
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("contact notice on agent cards", () => {
  it("renders nothing while the agent is in contact", () => {
    const { container } = render(
      <ContactNotice agent={agent({ state: "waiting" })} />,
    );
    expect(container.textContent).toBe("");
  });

  it("describes last contact for a waiting agent without guessing a cause", () => {
    render(<ContactNotice agent={agent({})} />);
    expect(screen.getByText(`No contact since ${time}`)).toBeTruthy();
    expect(screen.queryByText(/allowance/i)).toBeNull();
    expect(screen.getByText(/conversation may have stopped/)).toBeTruthy();
  });

  it("describes a working agent that stopped checking in", () => {
    render(
      <ContactNotice
        agent={agent({
          working: {
            detail: "Refactoring",
            updated_at: at,
            stale_after_ms: 1,
            stale: false,
          },
        })}
      />,
    );
    expect(screen.getByText(`Working · no update since ${time}`)).toBeTruthy();
  });

  it("warns about a quiet active turn without saying it stopped", () => {
    render(
      <ContactNotice
        agent={agent({ state: "working", turn_quiet_since: at })}
      />,
    );
    expect(screen.getByText(`Working · no contact since ${time}`)).toBeTruthy();
    expect(
      screen.getByText(/A long command may still be running/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy rejoin prompt" }),
    ).toBeTruthy();
  });

  it("shows nothing for a working agent that is checking in", () => {
    const { container } = render(
      <ContactNotice
        agent={agent({ state: "working", turn_quiet_since: null })}
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("copies the rejoin prompt", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ContactNotice agent={agent({})} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy rejoin prompt" }),
    );
    expect(writeText).toHaveBeenCalledWith("Join Konfab room konfab");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
});

describe("notice after mentioning agents that can't hear", () => {
  const agents = [
    { id: "claude", display_name: "Claude", join_prompt: "claude prompt" },
    { id: "qa", display_name: "QA", join_prompt: "qa prompt" },
  ];

  it("explains each unreachable agent and can be dismissed", async () => {
    const onDismiss = vi.fn();
    render(
      <UnreachableNotice
        agents={agents}
        onDismiss={onDismiss}
        items={[
          { agent_id: "claude", state: "not_responding", last_contact_at: at },
          { agent_id: "qa", state: "not_joined", last_contact_at: null },
        ]}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain(
      `Claude has had no contact since ${time}, so your mention is waiting.`,
    );
    expect(notice.textContent).toContain(
      "QA hasn't joined this room, so your mention is waiting.",
    );
    expect(
      screen.getByRole("button", { name: "Copy rejoin prompt" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy join prompt" }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("renders nothing when everyone can hear", () => {
    const { container } = render(
      <UnreachableNotice
        agents={agents}
        items={[]}
        onDismiss={() => undefined}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
