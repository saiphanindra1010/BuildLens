import { describe, expect, it, vi } from "vitest";
import worker, { InvestigationSession } from "../src/index";

function createState(): DurableObjectState {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      }
    }
  } as unknown as DurableObjectState;
}

describe("InvestigationSession", () => {
  it("stores the diagnosis and uses it for a follow-up", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ response: "## Likely cause\nA failed assertion." })
      .mockResolvedValueOnce({ response: "Inspect the returned status." });
    const session = new InvestigationSession(createState(), {
      AI: { run }
    } as never);

    const diagnosis = await session.fetch(
      new Request("https://session.internal/diagnose", {
        method: "POST",
        body: JSON.stringify({ log: "AssertionError: expected 201, got 500" })
      })
    );
    const followUp = await session.fetch(
      new Request("https://session.internal/chat", {
        method: "POST",
        body: JSON.stringify({ message: "What should I inspect first?" })
      })
    );
    const history = await session.fetch(
      new Request("https://session.internal/history")
    );

    expect(diagnosis.status).toBe(200);
    expect(followUp.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await diagnosis.json()).toMatchObject({
      answer: expect.stringContaining(
        "## Evidence\n- Test failure: AssertionError: expected 201, got 500"
      )
    });
    expect(await history.json()).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant" },
        { role: "user", content: "What should I inspect first?" },
        { role: "assistant", content: "Inspect the returned status." }
      ]
    });
  });

  it("rejects unsupported methods", async () => {
    const session = new InvestigationSession(createState(), {
      AI: { run: vi.fn() }
    } as never);
    const response = await session.fetch(
      new Request("https://session.internal/chat", { method: "DELETE" })
    );

    expect(response.status).toBe(405);
  });

  it("returns not found for a session without history", async () => {
    const session = new InvestigationSession(createState(), {
      AI: { run: vi.fn() }
    } as never);
    const response = await session.fetch(
      new Request("https://session.internal/history")
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Investigation not found."
    });
  });
});

describe("worker", () => {
  it("validates API input before creating a session", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/api/investigations", {
        method: "POST",
        body: JSON.stringify({ log: "" })
      }),
      {} as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A non-empty CI log is required."
    });
  });

  it("delegates non-API requests to static assets", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("BuildLens"));
    const response = await worker.fetch(new Request("https://example.com/"), {
      ASSETS: { fetch }
    } as never);

    expect(await response.text()).toBe("BuildLens");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
