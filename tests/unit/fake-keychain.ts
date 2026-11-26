import {
  itemOf,
  type Removed,
  type TokenRead,
  type TokenSlot,
} from "../../src/server/telegram/token.js";

/** Stands in for macOS's Keychain, which no test uses. */
export class FakeKeychain {
  items = new Map<string, string>();
  removed: string[] = [];
  reads: string[] = [];
  usable = true;
  fromEnvironment = false;
  kept: "keychain" | "file" | null = "keychain";
  /** What it does with the next calls. */
  refuses = false;
  breaks = false;
  unknown = false;
  keeps = false;
  /** Held back until it is let go. */
  hold: Promise<void> | null = null;

  constructor(readonly token: string) {}

  async read(place: { slot: TokenSlot; item?: string }): Promise<TokenRead> {
    const item = itemOf(place) ?? "env";
    this.reads.push(item);
    await this.hold;
    if (this.unknown) return { state: "unknown" };
    const token =
      item === "env"
        ? this.fromEnvironment
          ? this.token
          : undefined
        : this.items.get(item);
    return token ? { state: "found", token } : { state: "none" };
  }

  async remove(item: string): Promise<Removed> {
    await this.hold;
    if (this.keeps) return "unknown";
    this.removed.push(item);
    return this.items.delete(item) ? "deleted" : "none";
  }

  async storeByHand(item: string): Promise<boolean> {
    if (this.breaks) throw new Error("broken");
    if (this.refuses || this.items.has(item)) return false;
    this.items.set(item, this.token);
    return true;
  }
}
