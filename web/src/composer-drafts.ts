import { useCallback, useSyncExternalStore } from "react";
import type { Attachment } from "./api";
import type { Draft } from "./message-editor/RichEditor";

/**
 * What is being written in each room. It outlives the message box, so leaving
 * a room, or opening the library, doesn't lose a draft, its files, or one that
 * is being sent and then fails. Kept in memory only.
 */
export type RoomDraft = Draft & {
  attachments: Attachment[];
  uploading: boolean;
  sending: boolean;
};

const EMPTY: RoomDraft = {
  text: "",
  attachments: [],
  uploading: false,
  sending: false,
};
const drafts = new Map<number, RoomDraft>();
const listeners = new Set<() => void>();
/** The message box showing a room now, which puts drafts back itself. */
const boxes = new Map<number, (draft: Draft) => void>();

export const roomDraft = (roomId: number): RoomDraft =>
  drafts.get(roomId) ?? EMPTY;

export function updateDraft(
  roomId: number,
  change: (current: RoomDraft) => Partial<RoomDraft>,
): void {
  const current = roomDraft(roomId);
  const next = { ...current, ...change(current) };
  if (
    !next.text &&
    !next.attachments.length &&
    !next.uploading &&
    !next.sending
  )
    drafts.delete(roomId);
  else drafts.set(roomId, next);
  for (const listener of listeners) listener();
}

export function useRoomDraft(roomId: number): RoomDraft {
  return useSyncExternalStore(
    useCallback((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, []),
    () => roomDraft(roomId),
  );
}

export function showsRoom(
  roomId: number,
  putBack: (draft: Draft) => void,
): () => void {
  boxes.set(roomId, putBack);
  return () => {
    if (boxes.get(roomId) === putBack) boxes.delete(roomId);
  };
}

/** Puts a draft back, before anything written since. */
export function putDraftBack(roomId: number, draft: Draft): void {
  const box = boxes.get(roomId);
  if (box) return box(draft);
  updateDraft(roomId, (current) => {
    if (!current.text) return { text: draft.text, doc: draft.doc };
    return {
      text: `${draft.text}\n${current.text}`,
      doc:
        draft.doc && current.doc
          ? draft.doc.copy(draft.doc.content.append(current.doc.content))
          : undefined,
    };
  });
}

if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    // Closing the page now could lose a message that then fails.
    if ([...drafts.values()].some((draft) => draft.sending))
      event.preventDefault();
  });
