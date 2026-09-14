/**
 * OpenRouter provider adapter tests (Phase 10.15).
 *
 * The HTTP transport (`fetch`) is MOCKED via `vi.stubGlobal("fetch", ...)` —
 * no real OpenRouter key and no network traffic. These tests prove the adapter:
 *
 *   1. POSTs the correct OpenAI-compatible chat-completions request (URL,
 *      Authorization header, body) from the provider-agnostic request.
 *   2. Translates system / user / prior-tool-result messages in order.
 *   3. Maps tool metadata into the OpenRouter `tools` array.
 *   4. Maps a text-only response to `AgentResponse { text }`.
 *   5. Maps `tool_calls` (including multiple) into provider-independent
 *      intents.
 *   6. Validates output and rejects malformed responses as `InvalidResponse`.
 *   7. Maps auth / rate-limit / 4xx / 5xx / timeout / network into
 *      `ProviderError`.
 *   8. Honors a configurable model and base URL.
 *   9. Keeps the API key out of errors and serialized messages.
 *  10. Holds the provider-construction contract (key + model required,
 *      never executes tools).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenRouterProvider,
  type OpenRouterFetchInit,
} from "./openrouterProvider.js";
import {
  isProviderError,
  ProviderError,
  ProviderErrorCode,
} from "./provider.js";
import type {
  AgentProviderRequest,
  AgentResponse,
} from "./provider.js";
import { ToolPermission, type ToolDefinition } from "../tools/types.js";
import type { AgentToolResult } from "./agent.js";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = "sk-or-test-key";
const MODEL = "anthropic/claude-sonnet-4";

function tool(
  name: string,
  properties?: Record<string, { type: "string"; description?: string }>,
  required?: string[],
): ToolDefinition {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: {
      type: "object",
      ...(properties !== undefined ? { properties } : {}),
      ...(required !== undefined ? { required } : {}),
    },
    permission: ToolPermission.Read,
  };
}

function baseRequest(): AgentProviderRequest {
  return {
    message: "List my home directory",
    tools: [tool("list_directory", { path: { type: "string" } }, ["path"])],
  };
}

type RequestCapture = {
  url: string;
  init: OpenRouterFetchInit;
};

/** A minimal Response-shaped object the adapter consumes. */
function makeResponse(
  body: unknown,
  status: number,
  jsonImpl?: () => Promise<unknown>,
): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: "mock",
    redirected: false,
    type: "basic",
    url: "mock://",
    body: null,
    bodyUsed: false,
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob([]),
    formData: async () => new FormData(),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: jsonImpl ?? (async () => body),
    clone: function () {
      return this;
    },
  } as unknown as Response;
}

/**
 * Install a mocked global `fetch` that records requests and returns `body`
 * with `status`. Returns the recorded requests for assertions.
 */
function stubFetch(
  body: unknown,
  status = 200,
): { calls: RequestCapture[] } {
  const calls: RequestCapture[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      init: init as unknown as OpenRouterFetchInit,
    });
    return makeResponse(body, status);
  };
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

/** Build the adapter wired to the CURRENTLY-STUBBED global `fetch`. */
function makeProvider(body: unknown, status = 200) {
  const { calls } = stubFetch(body, status);
  const provider = createOpenRouterProvider({
    apiKey: API_KEY,
    model: MODEL,
  });
  return { provider, calls };
}

async function generateProvider(
  body: unknown,
  status = 200,
  request: AgentProviderRequest = baseRequest(),
): Promise<AgentResponse> {
  const { provider } = makeProvider(body, status);
  return provider.generate(request);
}

function expectOpenRouterBody(init: OpenRouterFetchInit): Record<string, unknown> {
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Request construction
// ---------------------------------------------------------------------------

describe("createOpenRouterProvider — request construction", () => {
  it("POSTs to the OpenRouter chat completions endpoint with the auth header", async () => {
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "ok" } }],
    });
    await provider.generate(baseRequest());

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) return;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.init.headers["Content-Type"]).toBe("application/json");
  });

  it("honors a configured model and base URL", async () => {
    const { calls } = stubFetch({
      choices: [{ message: { content: "ok" } }],
    });
    const provider = createOpenRouterProvider({
      apiKey: API_KEY,
      model: "openai/gpt-5.2",
      baseUrl: "https://gateway.example/v1",
    });
    await provider.generate({ message: "hi", tools: [] });

    expect(calls[0]?.url).toBe("https://gateway.example/v1/chat/completions");
    const body = calls[0] ? expectOpenRouterBody(calls[0].init) : {};
    expect(body.model).toBe("openai/gpt-5.2");
  });

  it("translates system and user messages in order", async () => {
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "ok" } }],
    });
    await provider.generate({ message: "Hello there", tools: [] });

    const call = calls[0];
    if (!call) return;
    const body = expectOpenRouterBody(call.init);
    expect(body.model).toBe(MODEL);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect((messages[0]?.content as string).length).toBeGreaterThan(0);
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toBe("Hello there");
  });

  it("threads prior tool results as assistant tool_calls + tool messages", async () => {
    const results: AgentToolResult[] = [
      { ok: true, callId: "a", data: { items: [] } },
      { ok: false, callId: "b", error: new Error("denied") as never },
    ];
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "done" } }],
    });
    await provider.generate({ ...baseRequest(), toolResults: results });

    const call = calls[0];
    if (!call) return;
    const messages = expectOpenRouterBody(call.init)
      .messages as Array<Record<string, unknown>>;
    // system, user, assistant (synthetic tool_calls), then tool messages
    expect(messages).toHaveLength(5);
    expect(messages[2]?.role).toBe("assistant");
    expect(messages[2]?.tool_calls).toHaveLength(2);
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "a" });
    expect(messages[4]).toMatchObject({ role: "tool", tool_call_id: "b" });
  });

  it("maps tool metadata into the OpenRouter tools array", async () => {
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "ok" } }],
    });
    await provider.generate(baseRequest());

    const call = calls[0];
    if (!call) return;
    const body = expectOpenRouterBody(call.init);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    const fn = (tools[0] as Record<string, unknown>).function as Record<
      string,
      unknown
    >;
    expect(fn.name).toBe("list_directory");
    expect(fn.description).toContain("list_directory");
    expect(fn.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  it("omits the tools array when no tools are offered", async () => {
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "hi" } }],
    });
    await provider.generate({ message: "hi", tools: [] });

    const call = calls[0];
    if (!call) return;
    const body = expectOpenRouterBody(call.init);
    expect(body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Response mapping
// ---------------------------------------------------------------------------

describe("createOpenRouterProvider — response mapping", () => {
  it("returns provider text for a text-only response", async () => {
    const response = await generateProvider({
      choices: [{ message: { content: "Here is your answer." } }],
    });
    expect(response.text).toBe("Here is your answer.");
    expect(response.toolCalls).toBeUndefined();
  });

  it("maps a single tool call into a provider-independent intent", async () => {
    const response = await generateProvider({
      choices: [
        {
          message: {
            content: "Opening it.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "list_directory",
                  arguments: JSON.stringify({ path: "/home" }),
                },
              },
            ],
          },
        },
      ],
    });
    expect(response.text).toBe("Opening it.");
    expect(response.toolCalls).toEqual([
      { id: "call_1", toolName: "list_directory", input: { path: "/home" } },
    ]);
  });

  it("maps multiple tool calls into ordered intents", async () => {
    const response = await generateProvider({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "list_directory",
                  arguments: JSON.stringify({ path: "/home" }),
                },
              },
              {
                id: "call_2",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "/home/notes.md" }),
                },
              },
            ],
          },
        },
      ],
    });
    expect(response.text).toBeUndefined();
    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls?.[0]).toEqual({
      id: "call_1",
      toolName: "list_directory",
      input: { path: "/home" },
    });
    expect(response.toolCalls?.[1]).toEqual({
      id: "call_2",
      toolName: "read_file",
      input: { path: "/home/notes.md" },
    });
  });

  it("parses a tool-only turn (content null) as textless", async () => {
    const response = await generateProvider({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "c",
                type: "function",
                function: {
                  name: "search_files",
                  arguments: JSON.stringify({ query: "notes" }),
                },
              },
            ],
          },
        },
      ],
    });
    expect(response.text).toBeUndefined();
    expect(response.toolCalls).toHaveLength(1);
  });

  it("assigns a fallback id when OpenRouter omits a tool call id", async () => {
    const response = await generateProvider({
      choices: [
        {
          message: {
            content: "ok",
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "list_directory",
                  arguments: JSON.stringify({}),
                },
              },
            ],
          },
        },
      ],
    });
    expect(response.toolCalls?.[0]?.id).toBeTruthy();
    expect(response.toolCalls?.[0]?.toolName).toBe("list_directory");
  });
});

// ---------------------------------------------------------------------------
// 3. Output validation
// ---------------------------------------------------------------------------

describe("createOpenRouterProvider — output validation", () => {
  it("rejects a non-object body", async () => {
    await expect(generateProvider("nope")).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects a missing or empty choices array", async () => {
    await expect(generateProvider({})).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
    });
    await expect(generateProvider({ choices: [] })).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
    });
  });

  it("rejects a malformed message content type", async () => {
    await expect(
      generateProvider({ choices: [{ message: { content: 42 } }] }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });

  it("rejects non-function tool calls", async () => {
    await expect(
      generateProvider({
        choices: [
          {
            message: {
              tool_calls: [{ id: "x", type: "web_search", function: {} }],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });

  it("rejects tool call arguments that are not valid JSON", async () => {
    await expect(
      generateProvider({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "x",
                  type: "function",
                  function: { name: "list_directory", arguments: "{bad" },
                },
              ],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });

  it("rejects tool call arguments that are not a JSON object", async () => {
    await expect(
      generateProvider({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "x",
                  type: "function",
                  function: {
                    name: "list_directory",
                    arguments: JSON.stringify("not-an-object"),
                  },
                },
              ],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });

  it("rejects tool calls with an empty tool name", async () => {
    await expect(
      generateProvider({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "x",
                  type: "function",
                  function: { name: "   ", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });
});

// ---------------------------------------------------------------------------
// 4. Error mapping
// ---------------------------------------------------------------------------

describe("createOpenRouterProvider — HTTP and transport error mapping", () => {
  it("maps HTTP 401 to a permanent Authentication error", async () => {
    await expect(
      generateProvider({ error: { message: "invalid key" } }, 401),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Authentication,
      retryable: false,
    });
  });

  it("maps HTTP 403 to a permanent Authentication error", async () => {
    await expect(generateProvider({}, 403)).rejects.toMatchObject({
      code: ProviderErrorCode.Authentication,
    });
  });

  it("maps HTTP 429 to a transient RateLimited error", async () => {
    await expect(generateProvider({}, 429)).rejects.toMatchObject({
      code: ProviderErrorCode.RateLimited,
      retryable: true,
    });
  });

  it("maps HTTP 402 (insufficient credits) to a transient RateLimited error", async () => {
    await expect(generateProvider({}, 402)).rejects.toMatchObject({
      code: ProviderErrorCode.RateLimited,
      retryable: true,
    });
  });

  it("maps HTTP 408 to a transient Timeout error", async () => {
    await expect(generateProvider({}, 408)).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      retryable: true,
    });
  });

  it("maps other 4xx to a permanent InvalidResponse error", async () => {
    await expect(generateProvider({ error: "bad" }, 400)).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("maps 5xx to a transient Unavailable error", async () => {
    await expect(generateProvider({}, 500)).rejects.toMatchObject({
      code: ProviderErrorCode.Unavailable,
      retryable: true,
    });
    await expect(generateProvider({}, 503)).rejects.toMatchObject({
      code: ProviderErrorCode.Unavailable,
      retryable: true,
    });
  });

  it("maps a timed-out request to a transient Timeout error", async () => {
    const fetchLike: FetchLike = async () => {
      throw new DOMException("timed out", "AbortError");
    };
    vi.stubGlobal("fetch", fetchLike);
    const provider = createOpenRouterProvider({
      apiKey: API_KEY,
      model: MODEL,
      timeoutMs: 5,
    });
    await expect(
      provider.generate({ message: "hi", tools: [] }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      retryable: true,
    });
  });

  it("maps a network failure to a transient Unavailable error", async () => {
    const fetchLike: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    vi.stubGlobal("fetch", fetchLike);
    const provider = createOpenRouterProvider({ apiKey: API_KEY, model: MODEL });
    await expect(
      provider.generate({ message: "hi", tools: [] }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Unavailable,
      retryable: true,
    });

    try {
      await provider.generate({ message: "hi", tools: [] });
      expect.unreachable("network failure must reject");
    } catch (error) {
      expect(isProviderError(error)).toBe(true);
    }
  });

  it("rejects a non-JSON response body", async () => {
    const fetchLike: FetchLike = async () =>
      makeResponse({}, 200, async () => {
        throw new SyntaxError("Unexpected token");
      });
    vi.stubGlobal("fetch", fetchLike);
    const provider = createOpenRouterProvider({ apiKey: API_KEY, model: MODEL });
    await expect(
      provider.generate({ message: "hi", tools: [] }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });
});

// ---------------------------------------------------------------------------
// 5. Credential secrecy
// ---------------------------------------------------------------------------

describe("createOpenRouterProvider — credential secrecy", () => {
  it("never surfaces the API key in provider errors", async () => {
    const { provider } = makeProvider({}, 401);
    try {
      await provider.generate({ message: "hi", tools: [] });
      expect.unreachable("auth failure must reject");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain(API_KEY);
    }
  });

  it("does not place the API key in the request body", async () => {
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "ok" } }],
    });
    await provider.generate({ message: "hi", tools: [] });
    const call = calls[0];
    if (!call) return;
    expect(call.init.body).not.toContain(API_KEY);
  });

  it("returns only validated intents — the key is never part of tool results", async () => {
    const { provider } = makeProvider({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "c",
                type: "function",
                function: {
                  name: "list_directory",
                  arguments: JSON.stringify({ path: "/" }),
                },
              },
            ],
          },
        },
      ],
    });
    const response = await provider.generate({ message: "hi", tools: [] });
    expect(response.toolCalls).toHaveLength(1);
    expect(JSON.stringify(response)).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// 6. Construction / provider contract
// ---------------------------------------------------------------------------

describe("createOpenRouterProvider — construction and contract", () => {
  it("throws Authentication when no API key is configured", () => {
    expect(() =>
      createOpenRouterProvider({ apiKey: "", model: MODEL }),
    ).toThrowError(ProviderError);
    expect(() =>
      createOpenRouterProvider({ apiKey: "", model: MODEL }),
    ).toThrowError(
      expect.objectContaining({
        code: ProviderErrorCode.Authentication,
        retryable: false,
      }),
    );
  });

  it("throws a permanent error when no model is configured (no hard-coded default)", () => {
    expect(() =>
      createOpenRouterProvider({ apiKey: API_KEY, model: "" }),
    ).toThrowError(ProviderError);
    expect(() =>
      createOpenRouterProvider({ apiKey: API_KEY, model: "" }),
    ).toThrowError(
      expect.objectContaining({
        code: ProviderErrorCode.Internal,
        retryable: false,
      }),
    );
  });

  it("never executes tools — only returns intents", async () => {
    // A tool-call response comes back as an intent; nothing is run here.
    const response = await generateProvider({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: "a",
                type: "function",
                function: {
                  name: "create_file",
                  arguments: JSON.stringify({ path: "/evil" }),
                },
              },
            ],
          },
        },
      ],
    });
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0]?.toolName).toBe("create_file");
  });
});