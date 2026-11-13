import { vi } from "vitest";

export type Handler = (
  url: string,
  init?: RequestInit,
) => unknown | Promise<unknown>;
export type Call = { url: string; method: string; body: unknown };

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const base64 = (text: string) => Buffer.from(text).toString("base64");

/** A small fake of the library and assignment API used by the skill picker. */
export function stubSkillApi(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const routes: Record<string, Handler> = {
    "/api/library?scope=personal": () => ({
      skills: [
        {
          id: "s-dev",
          current_revision_id: "11111111-1111-4111-8111-000000000002",
          name: "konfab-dev",
          number: 2,
          description: "Developer duties",
          reviewed_at: 1,
          licence: null,
        },
        {
          id: "s-new",
          current_revision_id: "11111111-1111-4111-8111-000000000009",
          name: "fresh",
          number: 1,
          description: "Not reviewed yet",
          reviewed_at: null,
          licence: null,
        },
      ],
    }),
    "/api/library/builtin": () => ({
      skills: [
        {
          id: "builtin:qa",
          current_revision_id: "11111111-1111-4111-8111-0000000000a1",
          name: "qa",
          number: 1,
          description: "Tests changes",
          reviewed_at: 1,
          licence: null,
        },
      ],
    }),
    "/api/library?scope=project&room_id=7": () => ({ skills: [] }),
    "/api/rooms/7/picker-locations": () => ({
      skills: "/home/skills",
      project: null,
      sources: ["example/skills"],
    }),
    "/api/library/live?q=": () => ({
      items: [
        {
          source_id: "22222222-2222-4222-8222-000000000001",
          source: "example/skills",
          badge: "vendor",
          commit: "a".repeat(40),
          path: "skills/web-testing",
          name: "web-testing",
          description: "Test web apps",
          licence: "MIT",
        },
      ],
      sources: [
        {
          source: "example/skills",
          done: 1,
          total: 1,
          complete: true,
          stage: "done",
          error: null,
        },
      ],
    }),
    ...overrides,
  };
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.endsWith("/assignment/size")) {
      const pins = (body as { pins: unknown[]; instructions: string }).pins;
      const big = JSON.stringify(pins).includes("big");
      return json(200, {
        bytes: big ? 70 * 1024 : 1024 * (1 + pins.length),
        limit: 64 * 1024,
      });
    }
    if (url.startsWith("/api/library/skills/") && url.includes("/files?")) {
      const revision = url.split("/revisions/")[1]!.split("/")[0]!;
      return json(200, {
        content_base64: base64(
          `---\nname: x\n---\nline shared\nline from ${revision.slice(-2)}`,
        ),
      });
    }
    if (url.startsWith("/api/library/skills/") && url.includes("/revisions/"))
      return json(200, { files: [{ path: "SKILL.md", size: 40 }] });
    if (url.startsWith("/api/library/live/preview"))
      return json(200, {
        content: "---\nname: web-testing\n---\nTest web apps",
        preview_hash: "f".repeat(64),
        licence: "MIT",
        files: [{ path: "SKILL.md", size: 30 }],
      });
    const handler = routes[url];
    if (!handler) return json(404, { message: `No route ${method} ${url}` });
    const result = await handler(url, init);
    return result instanceof Response ? result : json(200, result);
  });
  return { calls, routes, fetch };
}
