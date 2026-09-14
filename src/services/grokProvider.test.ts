/**
 * Grok (xAI) provider adapter tests (Phase 10.9).
 *
 * The HTTP transport (`fetch`) is MOCKED via `vi.stubGlobal("fetch", ...)` —
 * no real xAI key and no network traffic. These tests prove the adapter:
 *
 *   1. POSTs the correct xAI chat-completions request (URL, auth header,
 *      body) from the provider-agnostic request.
 *   2. Maps tool metadata into the xAI `tools` array.
 *   3. Maps a text-only response to `AgentResponse { text }`.
 *   4. Maps tool_calls into provider-independent `AgentToolCall` intents.
 *   5. Supplies prior tool results as xAI `tool` messages for the next round.
 *   6. Parses tool-only turns (`content: null`) as textless.
 *   7. Validates output and rejects malformed responses as `InvalidResponse`.
 *   8. Maps auth / rate-limit / network / timeout / 5xx into `ProviderError`.
 *   9. Requires a configured API key at construction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGrokProvider,
  type GrokFetchInit,
} from "./grokProvider.js";
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

const API_KEY = "xai-test-key";
const MODEL = "grok-3";

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
  init: GrokFetchInit;
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
      init: init as unknown as GrokFetchInit,
    });
    return makeResponse(body, status);
  };
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

/** Build the adapter wired to the CURRENTLY-STUBBED global `fetch`. */
function makeProvider(body: unknown, status = 200) {
  const { calls } = stubFetch(body, status);
  const provider = createGrokProvider({ apiKey: API_KEY, model: MODEL });
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

function expectGrokBody(init: GrokFetchInit): Record<string, unknown> {
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Request construction
// ---------------------------------------------------------------------------

describe("createGrokProvider — request construction", () => {
  it("POSTs to the xAI chat completions endpoint with the auth header", async () => {
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "ok" } }],
    });
    await provider.generate(baseRequest());

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) return;
    expect(call.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.init.headers["Content-Type"]).toBe("application/json");
  });

  it("includes the configured model and the user message in the body", async () => {
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "ok" } }],
    });
    await provider.generate({ message: "Hello there", tools: [] });

    const call = calls[0];
    if (!call) return;
    const body = expectGrokBody(call.init);
    expect(body.model).toBe(MODEL);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(2);
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toBe("Hello there");
  });

  it("maps tool metadata into the xAI tools array", async () => {
    const { provider, calls } = makeProvider({
      choices: [{ message: { content: "ok" } }],
    });
    await provider.generate(baseRequest());

    const call = calls[0];
    if (!call) return;
    const body = expectGrokBody(call.init);
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
    const body = expectGrokBody(call.init);
    expect(body.tools).toBeUndefined();
  });

  it("supplies prior tool results as xAI tool messages in order", async () => {
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
    const messages = expectGrokBody(call.init)
      .messages as Array<Record<string, unknown>>;
    // system, user, assistant (synthetic tool_calls), then tool messages
    expect(messages).toHaveLength(5);
    expect(messages[2]?.role).toBe("assistant");
    expect(messages[2]?.tool_calls).toHaveLength(2);
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "a" });
    expect(messages[4]).toMatchObject({ role: "tool", tool_call_id: "b" });
  });
});

// ---------------------------------------------------------------------------
// 2. Response mapping
// ---------------------------------------------------------------------------

describe("createGrokProvider — response mapping", () => {
  it("returns provider text for a text-only response", async () => {
    const response = await generateProvider({
      choices: [{ message: { content: "Here is your answer." } }],
    });
    expect(response.text).toBe("Here is your answer.");
    expect(response.toolCalls).toBeUndefined();
  });

  it("maps xAI tool_calls into provider-independent intents", async () => {
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

  it("assigns a fallback id when xAI omits a tool call id", async () => {
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

describe("createGrokProvider — output validation", () => {
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

describe("createGrokProvider — HTTP and transport error mapping", () => {
  it("maps HTTP 401 to a permanent Authentication error", async () => {
    await expect(
      generateProvider({ error: "bad key" }, 401),
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

  it("maps HTTP 400 to a permanent InvalidResponse error", async () => {
    await expect(generateProvider({ error: "bad" }, 400)).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("maps HTTP 500 to a transient Internal error", async () => {
    await expect(generateProvider({}, 500)).rejects.toMatchObject({
      code: ProviderErrorCode.Internal,
      retryable: true,
    });
  });

  it("maps a timed-out request to a transient Timeout error", async () => {
    const fetchLike: FetchLike = async () => {
      throw new DOMException("timed out", "AbortError");
    };
    vi.stubGlobal("fetch", fetchLike);
    const provider = createGrokProvider({
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
    const provider = createGrokProvider({ apiKey: API_KEY, model: MODEL });
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
    const provider = createGrokProvider({ apiKey: API_KEY, model: MODEL });
    await expect(
      provider.generate({ message: "hi", tools: [] }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });
});

// ---------------------------------------------------------------------------
// 5. Construction / provider contract
// ---------------------------------------------------------------------------

describe("createGrokProvider — construction and contract", () => {
  it("throws Authentication when no API key is configured", () => {
    expect(() =>
      createGrokProvider({ apiKey: "", model: MODEL }),
    ).toThrowError(ProviderError);
    expect(() => createGrokProvider({ apiKey: "", model: MODEL })).toThrowError(
      expect.objectContaining({
        code: ProviderErrorCode.Authentication,
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