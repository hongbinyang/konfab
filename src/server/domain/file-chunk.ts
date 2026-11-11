export function fileChunk(content: Buffer, offset: number, max: number) {
  const end = Math.min(content.length, offset + max);
  let chunk = content.subarray(offset, end);
  let text: string | null = null;
  try {
    if (content.includes(0)) throw new Error("binary");
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    while (chunk.length > 0) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(chunk);
        break;
      } catch {
        chunk = chunk.subarray(0, chunk.length - 1);
      }
    }
    if (!chunk.length && offset === content.length) text = "";
    if (!chunk.length && offset < content.length)
      chunk = content.subarray(offset, end);
  } catch {
    // Binary data is returned without a lossy text conversion.
  }
  const next = offset + chunk.length;
  return {
    ...(text === null
      ? { content_base64: chunk.toString("base64") }
      : { content: text }),
    offset,
    total_size: content.length,
    next_offset: next < content.length ? next : null,
  };
}
