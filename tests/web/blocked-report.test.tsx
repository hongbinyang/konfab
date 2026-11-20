// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockedReport } from "../../web/src/App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("an agent's report that its app refused a call", () => {
  it("says where to answer, labels the wording as a suggestion, and can be dismissed", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const onDismiss = vi.fn();
    render(
      <BlockedReport
        agentName="pm"
        roomName="afterslip"
        detail="post_message: approval review rejected the post"
        onDismiss={onDismiss}
      />,
    );
    expect(
      screen.getByText(
        /pm reports that its app refused a Konfab action: post_message/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Answer in pm's own conversation in its app/),
    ).toBeTruthy();
    expect(screen.getByText(/Suggested wording/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(
      'I approve you posting your reply to the Konfab room "afterslip".',
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
