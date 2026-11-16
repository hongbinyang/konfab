// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingFolder } from "../../web/src/LocalImport";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reason = {
  code: "folder_edited" as const,
  folder: "pm",
  detail: "pm was edited after Konfab checked it, so Konfab didn't replace it.",
  target: "dir:1:2:abc",
};

describe("pending folder notice", () => {
  it("offers the fixes for an edited folder and sends the target the lead saw", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ folder: "ready" }),
    }));
    vi.stubGlobal("fetch", fetch);
    const onResolved = vi.fn();
    render(
      <PendingFolder skillId="s1" reason={reason} onResolved={onResolved} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save my edits first" }),
    );
    const [, init] = fetch.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(JSON.parse(init.body)).toEqual({
      action: "save_edits",
      expected_reason: "folder_edited",
      expected_target: "dir:1:2:abc",
    });
    expect(onResolved).toHaveBeenCalledWith({ folder: "ready" });
  });

  it("shows the current state when the folder changed since it was shown", async () => {
    const changed = { ...reason, target: "dir:1:2:def" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          code: "import_changed",
          message: "This changed; review again.",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ folder: "pending", pending_reason: changed }),
      });
    vi.stubGlobal("fetch", fetch);
    const onResolved = vi.fn();
    render(
      <PendingFolder skillId="s1" reason={reason} onResolved={onResolved} />,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Use the import, keep my edits aside",
      }),
    );
    expect(onResolved).toHaveBeenCalledWith({
      folder: "pending",
      pending_reason: changed,
    });
    expect(
      await screen.findByText(/changed since this was shown/),
    ).toBeTruthy();
  });
});
