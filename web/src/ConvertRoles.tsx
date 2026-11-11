import { useEffect, useState } from "react";
import { request } from "./api";
import { NameField } from "./NameField";
import { suggestName, validName } from "./name-validation";

type Assignment = {
  room_id: number;
  room: string;
  agent_id: string;
  display_name: string;
  text: string;
  revision: number;
};
type Group = {
  name: string;
  title: string;
  nameEdited: boolean;
  description: string;
  text: string;
  assign: boolean;
  members: Array<Assignment & { selected: boolean }>;
  selected: boolean;
};

export function ConvertRoles({
  roomId,
  agentId,
  onClose,
}: {
  roomId?: number;
  agentId?: string;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  useEffect(() => {
    void request<{ assignments: Assignment[] }>("/api/roles/custom-assignments")
      .then(({ assignments }) => {
        const grouped = new Map<string, Assignment[]>();
        for (const item of assignments) {
          if (
            roomId !== undefined &&
            (item.room_id !== roomId || item.agent_id !== agentId)
          )
            continue;
          grouped.set(item.text, [...(grouped.get(item.text) ?? []), item]);
        }
        setGroups(
          [...grouped.entries()].map(([text, members], index) => {
            const first =
              text
                .split(/\r?\n/)
                .find((line) => line.trim())
                ?.trim() ?? "Converted custom role";
            const slug = [...(suggestName(first) || "custom-role")]
              .slice(0, 60)
              .join("")
              .replace(/-+$/g, "");
            return {
              name: `${slug}-${index + 1}`,
              nameEdited: false,
              title: [...first].slice(0, 100).join(""),
              description: [...first].slice(0, 1024).join(""),
              text,
              assign: true,
              members: members.map((member) => ({ ...member, selected: true })),
              selected: true,
            };
          }),
        );
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Unable to load assignments"),
      );
  }, [roomId, agentId]);
  const update = (index: number, patch: Partial<Group>) =>
    setGroups((current) =>
      current.map((group, i) => (i === index ? { ...group, ...patch } : group)),
    );
  async function convert() {
    try {
      const chosen = groups
        .filter((group) => group.selected)
        .map((group) => ({
          name: group.name,
          title: group.title,
          description: group.description,
          text: group.text,
          assign: group.assign,
          members: group.members
            .filter((member) => member.selected)
            .map((member) => ({
              room_id: member.room_id,
              agent_id: member.agent_id,
              revision: member.revision,
            })),
        }));
      const result = await request<{ pending: string[] }>(
        "/api/roles/convert-custom",
        { method: "POST", body: { groups: chosen } },
      );
      setDone(
        result.pending.length
          ? "Saved, but some role folders need recovery."
          : "Saved successfully.",
      );
      setGroups([]);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed");
    }
  }
  return (
    <section className="stack">
      <h3>Convert custom roles</h3>
      <p>
        Review each role and its assignments before saving. Identical text is
        grouped together.
      </p>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {done && <p role="status">{done}</p>}
      {groups.map((group, index) => (
        <article key={index}>
          <label>
            <input
              type="checkbox"
              checked={group.selected}
              onChange={(e) => update(index, { selected: e.target.checked })}
            />{" "}
            Convert this role
          </label>
          {group.members.map((member, memberIndex) => (
            <label key={`${member.room_id}:${member.agent_id}`}>
              <input
                type="checkbox"
                checked={member.selected}
                onChange={(event) =>
                  update(index, {
                    members: group.members.map((item, i) =>
                      i === memberIndex
                        ? { ...item, selected: event.target.checked }
                        : item,
                    ),
                  })
                }
              />
              {member.display_name} in #{member.room}
            </label>
          ))}
          <NameField
            label="Name"
            value={group.name}
            onChange={(name) => update(index, { name, nameEdited: true })}
          />
          <label>
            Title
            <input
              value={group.title}
              onChange={(e) =>
                update(index, {
                  title: e.target.value,
                  ...(!group.nameEdited
                    ? { name: suggestName(e.target.value) }
                    : {}),
                })
              }
            />
          </label>
          <label>
            Description
            <input
              value={group.description}
              onChange={(e) => update(index, { description: e.target.value })}
            />
          </label>
          <h4>Original responsibilities</h4>
          <pre>{group.text}</pre>
          <label>
            <input
              type="checkbox"
              checked={group.assign}
              onChange={(e) => update(index, { assign: e.target.checked })}
            />{" "}
            Assign to selected members now
          </label>
        </article>
      ))}
      {!groups.length && !done && <p>No custom roles found.</p>}
      {groups.length > 0 && (
        <button
          type="button"
          disabled={
            !groups.some(
              (group) =>
                group.selected &&
                group.members.some((member) => member.selected),
            ) ||
            groups.some(
              (group) =>
                group.selected &&
                (!validName(group.name) ||
                  !group.members.some((member) => member.selected)),
            )
          }
          onClick={() => void convert()}
        >
          Save selected roles
        </button>
      )}
      <button type="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}
