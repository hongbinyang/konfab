/** Room names for agents: the lead-given name is also the agent's mention. */

export const ROOM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
export const RESERVED_MENTIONS = ["lead", "all"] as const;

export type NameProblem =
  | { code: "name_invalid"; message: string }
  | { code: "name_reserved"; message: string };

/** Syntax and reserved-word check for a proposed room name. */
export function roomNameProblem(name: string): NameProblem | null {
  if (!ROOM_NAME_PATTERN.test(name))
    return {
      code: "name_invalid",
      message:
        "Names start with a letter and use letters, digits, - or _ (32 at most), so they can be typed after @.",
    };
  if ((RESERVED_MENTIONS as readonly string[]).includes(name.toLowerCase()))
    return {
      code: "name_reserved",
      message: `@${name} is reserved. Choose another name.`,
    };
  return null;
}

export interface NamedMember {
  id: string;
  /** Room name, if the lead set one. */
  name: string | null;
  /** Shown in conflict messages. */
  label: string;
}

/**
 * The first pair of members that one mention would match, or null.
 * Each member is reachable by its ID and, if set, its room name (any case).
 */
export function mentionConflict(
  members: readonly NamedMember[],
): { token: string; holder: NamedMember; other: NamedMember } | null {
  const owners = new Map<string, NamedMember>();
  const claim = (token: string, member: NamedMember) => {
    const holder = owners.get(token);
    if (holder && holder.id !== member.id)
      return { token, holder, other: member };
    owners.set(token, member);
    return null;
  };
  for (const member of members) {
    const clash = claim(member.id.toLowerCase(), member);
    if (clash) return clash;
  }
  for (const member of members) {
    if (!member.name) continue;
    const clash = claim(member.name.toLowerCase(), member);
    if (clash) return clash;
  }
  return null;
}

/**
 * Map parsed mention tokens to agent IDs: `lead` and `all` stay as they are,
 * then member room names, then member IDs. Unmatched tokens are kept.
 */
export function normalizeMentionTokens(
  tokens: readonly string[],
  members: readonly { id: string; name: string | null }[],
): string[] {
  const byName = new Map<string, string>();
  for (const member of members)
    if (member.name) byName.set(member.name.toLowerCase(), member.id);
  const out: string[] = [];
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    // Agent IDs are lowercase, so an unmatched token is already its ID form.
    const value = (RESERVED_MENTIONS as readonly string[]).includes(token)
      ? token
      : (byName.get(token) ?? token);
    if (!out.includes(value)) out.push(value);
  }
  return out;
}
