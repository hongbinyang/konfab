import { Fragment } from "react";
import { decisionReferences } from "./decision-references";

export function DecisionReferences({
  body,
  decisionIds,
}: {
  body: string;
  decisionIds: readonly number[];
}) {
  return (
    <>
      {decisionReferences(body, decisionIds).map((part, index) =>
        part.target ? (
          <a key={index} href={`#decision-${part.target}`}>
            {part.text}
          </a>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
