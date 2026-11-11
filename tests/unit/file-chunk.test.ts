import { describe, expect, it } from "vitest";
import { fileChunk } from "../../src/server/domain/file-chunk.js";

describe("role file chunks", () => {
  it("returns text on UTF-8 boundaries and base64 for binary bytes", () => {
    const text = Buffer.from("a🙂z");
    const first = fileChunk(text, 0, 4);
    expect(first).toEqual({
      content: "a",
      offset: 0,
      total_size: 6,
      next_offset: 1,
    });
    expect(fileChunk(text, 1, 4)).toEqual({
      content: "🙂",
      offset: 1,
      total_size: 6,
      next_offset: 5,
    });
    expect(fileChunk(Buffer.from([0, 255]), 0, 2)).toEqual({
      content_base64: "AP8=",
      offset: 0,
      total_size: 2,
      next_offset: null,
    });
  });
});
