// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomNameForm } from "../../web/src/RoomNameForm";
import { mentionName, withRoomLabels, type RoomAgent } from "../../web/src/api";

const member = {
  id: "claude",
  display_name: "Claude",
  account_name: "Claude",
  room_name: null,
  name_fixed: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const respond = (status: number, body: object) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("room name form", () => {
  it("saves a name for an agent that hasn't joined", async () => {
    const fetchMock = respond(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    render(
      <RoomNameForm
        roomId={7}
        agent={member}
        archived={false}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByText(/Fixed once Claude joins/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Name in this room"), "A");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms/7/members/claude/name",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ name: "A" }),
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("shows the server's reason inline when a name is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      respond(409, {
        code: "name_conflict",
        message:
          "@b would mean both B's name and Codex's agent ID in this room.",
      }),
    );
    render(<RoomNameForm roomId={7} agent={member} archived={false} />);
    await userEvent.type(screen.getByLabelText("Name in this room"), "b");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("would mean both");
    expect(
      screen.getByLabelText("Name in this room").getAttribute("aria-invalid"),
    ).toBe("true");
  });

  it("clears a name before the agent joins", async () => {
    const fetchMock = respond(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <RoomNameForm
        roomId={7}
        agent={{ ...member, room_name: "A" }}
        archived={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/rooms/7/members/claude/name",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows a fixed name read-only once the agent has joined", () => {
    render(
      <RoomNameForm
        roomId={7}
        agent={{ ...member, room_name: "A", name_fixed: true }}
        archived={false}
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("@A")).toBeTruthy();
    expect(screen.getByText("Fixed").getAttribute("title")).toBe(
      "Names are fixed once the agent joins this room.",
    );
    expect(
      screen.getByText("Names are fixed once the agent joins this room."),
    ).toBeTruthy();
  });

  it("explains why a joined agent without a name keeps its agent ID", () => {
    render(
      <RoomNameForm
        roomId={7}
        agent={{ ...member, name_fixed: true }}
        archived={false}
      />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("@claude")).toBeTruthy();
    expect(
      screen.getByText(/joined without a room name, so it keeps its agent ID/),
    ).toBeTruthy();
  });

  it("is read-only in an archived room", () => {
    render(<RoomNameForm roomId={7} agent={member} archived />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/This room is archived/)).toBeTruthy();
  });
});

describe("room labels", () => {
  it("uses the room name as label and mention, keeping the account name", () => {
    const state = withRoomLabels({
      agents: [
        { ...member, room_name: "A" },
        { ...member, id: "codex", display_name: "Codex", room_name: null },
      ] as RoomAgent[],
    });
    expect(state.agents.map((agent) => agent.display_name)).toEqual([
      "A",
      "Codex",
    ]);
    expect(state.agents[0]?.account_name).toBe("Claude");
    expect(state.agents.map(mentionName)).toEqual(["A", "codex"]);
  });
});
