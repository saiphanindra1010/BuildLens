const logInput = document.querySelector("#log-input");
const messageInput = document.querySelector("#message-input");
const investigateButton = document.querySelector("#investigate-button");
const sampleButton = document.querySelector("#sample-button");
const characterCount = document.querySelector("#character-count");
const conversation = document.querySelector("#conversation");
const chatForm = document.querySelector("#chat-form");
const status = document.querySelector("#status");

const sampleLog = `$ npm test

FAIL src/api/user.test.ts
  POST /api/users
    ✕ creates a user (42 ms)

AssertionError: expected response.status to equal 201
Expected: 201
Received: 500

  27 | const response = await request(app).post('/api/users').send(input)
> 28 | expect(response.status).toBe(201)

Caused by: TypeError: Cannot read properties of undefined (reading 'id')
    at createUser (src/api/user.ts:44:31)

Tests: 1 failed, 18 passed, 19 total
Process completed with exit code 1.`;

let sessionId;

function setStatus(label, state) {
  status.textContent = label;
  status.className = `status ${state}`;
}

function addMessage(content, role) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  message.textContent = content;
  conversation.append(message);
  conversation.scrollTop = conversation.scrollHeight;
}

async function requestJson(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options?.headers
    }
  });
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "The request failed.");
  }

  return result;
}

function postJson(path, body) {
  return requestJson(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function setSessionUrl(id) {
  const url = new URL(window.location.href);
  url.searchParams.set("session", id);
  window.history.replaceState({}, "", url);
}

async function resumeSessionFromUrl() {
  const id = new URLSearchParams(window.location.search).get("session");
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!id || !uuidPattern.test(id)) {
    return;
  }

  sessionId = id;
  setStatus("Loading investigation", "running");

  try {
    const result = await requestJson(
      `/api/investigations/${sessionId}/history`
    );
    conversation.replaceChildren();
    result.messages.slice(1).forEach((message) => {
      if (message.role === "user" || message.role === "assistant") {
        addMessage(message.content, message.role);
      }
    });
    chatForm.hidden = false;
    setStatus("Investigation active", "done");
  } catch (error) {
    sessionId = undefined;
    conversation.replaceChildren();
    addMessage(error.message || "Unable to resume this investigation.", "error");
    setStatus("Investigation unavailable", "idle");
  }
}

logInput.addEventListener("input", () => {
  characterCount.textContent = `${logInput.value.length.toLocaleString()} / 20,000`;
});

sampleButton.addEventListener("click", () => {
  logInput.value = sampleLog;
  logInput.dispatchEvent(new Event("input"));
  logInput.focus();
});

investigateButton.addEventListener("click", async () => {
  const log = logInput.value.trim();
  if (!log) {
    logInput.focus();
    return;
  }

  investigateButton.disabled = true;
  conversation.replaceChildren();
  setStatus("Analyzing", "running");

  try {
    const result = await postJson("/api/investigations", { log });
    sessionId = result.sessionId;
    setSessionUrl(sessionId);
    addMessage(result.answer, "assistant");
    chatForm.hidden = false;
    setStatus("Investigation active", "done");
  } catch (error) {
    addMessage(error.message || "Unable to investigate this log.", "error");
    setStatus("Investigation failed", "idle");
  } finally {
    investigateButton.disabled = false;
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || !sessionId) {
    return;
  }

  addMessage(message, "user");
  messageInput.value = "";
  messageInput.disabled = true;
  setStatus("Thinking", "running");

  try {
    const result = await postJson(
      `/api/investigations/${sessionId}/messages`,
      { message }
    );
    addMessage(result.answer, "assistant");
    setStatus("Investigation active", "done");
  } catch (error) {
    addMessage(error.message || "Unable to answer that question.", "error");
    setStatus("Follow-up failed", "idle");
  } finally {
    messageInput.disabled = false;
    messageInput.focus();
  }
});

void resumeSessionFromUrl();
