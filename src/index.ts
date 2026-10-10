import {
  buildDiagnosisPrompt,
  findSignals,
  formatDiagnosisResponse,
  type LogSignal,
  validateLog,
  validateMessage
} from "./analyzer";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const SYSTEM_PROMPT =
  "You are BuildLens, a careful CI failure investigator. Base conclusions on supplied evidence, state uncertainty, and never invent files, commands, or results.";

interface AiBinding {
  run(
    model: string,
    input: { messages: ConversationMessage[]; max_tokens: number }
  ): Promise<{ response?: string } | string>;
}

interface Env {
  AI: AiBinding;
  SESSIONS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CreateInvestigationBody {
  log?: unknown;
}

interface ChatBody {
  message?: unknown;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch (error) {
    throw new Error("Request body must be valid JSON.", { cause: error });
  }
}

function getSessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
}

function validSessionId(sessionId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    sessionId
  );
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/investigations") {
    const body = await readJson<CreateInvestigationBody>(request);
    const log = validateLog(body.log);
    const sessionId = crypto.randomUUID();
    const stub = getSessionStub(env, sessionId);
    const response = await stub.fetch("https://session.internal/diagnose", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ log })
    });
    const result = (await response.json()) as { answer?: string; error?: string };

    return json({ sessionId, ...result }, response.status);
  }

  const match = url.pathname.match(
    /^\/api\/investigations\/([^/]+)\/(messages|history)$/
  );
  if (!match) {
    return json({ error: "API route not found." }, 404);
  }

  const sessionId = match[1] ?? "";
  const action = match[2];
  if (!validSessionId(sessionId)) {
    return json({ error: "Invalid investigation ID." }, 400);
  }

  const stub = getSessionStub(env, sessionId);
  if (request.method === "POST" && action === "messages") {
    const body = await readJson<ChatBody>(request);
    const message = validateMessage(body.message);
    return stub.fetch("https://session.internal/chat", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ message })
    });
  }

  if (request.method === "GET" && action === "history") {
    return stub.fetch("https://session.internal/history");
  }

  return json({ error: "Method not allowed." }, 405);
}

export class InvestigationSession {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/history") {
      const messages =
        (await this.state.storage.get<ConversationMessage[]>("messages")) ?? [];
      if (messages.length === 0) {
        return json({ error: "Investigation not found." }, 404);
      }
      return json({ messages });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, 405);
    }

    try {
      if (url.pathname === "/diagnose") {
        const body = await readJson<CreateInvestigationBody>(request);
        const log = validateLog(body.log);
        const prompt = buildDiagnosisPrompt(log);
        return this.reply(prompt, true, findSignals(log));
      }

      if (url.pathname === "/chat") {
        const body = await readJson<ChatBody>(request);
        return this.reply(validateMessage(body.message), false);
      }

      return json({ error: "Session route not found." }, 404);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "The investigation failed.";
      return json({ error: message }, 400);
    }
  }

  private async reply(
    userMessage: string,
    reset: boolean,
    diagnosisSignals: readonly LogSignal[] = []
  ): Promise<Response> {
    const previous = reset
      ? []
      : ((await this.state.storage.get<ConversationMessage[]>("messages")) ?? []);
    const messages: ConversationMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...previous.slice(-8),
      { role: "user", content: userMessage }
    ];

    let result: { response?: string } | string;
    try {
      result = await this.env.AI.run(MODEL, {
        messages,
        max_tokens: 700
      });
    } catch (error) {
      throw new Error("Workers AI could not complete the investigation.", {
        cause: error
      });
    }

    const modelAnswer = typeof result === "string" ? result : result.response;
    if (!modelAnswer) {
      throw new Error("Workers AI returned an empty investigation.");
    }
    const answer = reset
      ? formatDiagnosisResponse(modelAnswer, diagnosisSignals)
      : modelAnswer;

    const updated: ConversationMessage[] = [
      ...previous,
      { role: "user", content: userMessage },
      { role: "assistant", content: answer }
    ];
    await this.state.storage.put("messages", updated.slice(-10));

    return json({ answer });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env);
      }
      return await env.ASSETS.fetch(request);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected request failure.";
      return json({ error: message }, 400);
    }
  }
};
