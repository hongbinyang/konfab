export function decisionReferences(
  body: string,
  decisionIds: readonly number[],
) {
  const known = new Set(decisionIds);
  return body
    .split(/(?<![\w#])#([1-9]\d*)\b/g)
    .map((part, index) =>
      index % 2 === 1
        ? { text: `#${part}`, target: known.has(Number(part)) ? part : null }
        : { text: part, target: null },
    );
}
