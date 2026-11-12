import { describe, expect, it, vi } from "vitest";
import { resolveGithubToken } from "../../src/server/github-token.js";

describe("GitHub token resolution", () => {
  it("prefers the environment without reading the Keychain", () => {
    const read = vi.fn(() => "keychain-token\n");
    expect(
      resolveGithubToken("environment-token", {
        platform: "darwin",
        username: () => "test",
        read,
      }),
    ).toEqual({ token: "environment-token", source: "environment" });
    expect(read).not.toHaveBeenCalled();
  });
  it("reads once from the named Keychain item", () => {
    const read = vi.fn(() => "fake-token\n");
    expect(
      resolveGithubToken(undefined, {
        platform: "darwin",
        username: () => "test",
        read,
      }),
    ).toEqual({ token: "fake-token", source: "keychain" });
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith([
      "find-generic-password",
      "-a",
      "test",
      "-s",
      "konfab-github-token",
      "-w",
    ]);
  });
  it("handles an inaccessible Keychain without reporting its error", () => {
    const log = vi.spyOn(console, "error");
    expect(
      resolveGithubToken(undefined, {
        platform: "darwin",
        username: () => "test",
        read: () => {
          throw new Error("fake-sensitive-output");
        },
      }),
    ).toEqual({ token: undefined, source: "unavailable" });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it("does not read a Keychain on other platforms", () => {
    const read = vi.fn();
    expect(
      resolveGithubToken(undefined, {
        platform: "linux",
        username: () => "test",
        read,
      }),
    ).toEqual({ token: undefined, source: "unavailable" });
    expect(read).not.toHaveBeenCalled();
  });
});
