/**
 * Ollama (local) provider adapter tests (Phase 10.16).
 *
 * The HTTP transport (`fetch`) is MOCKED via `vi.stubGlobal("fetch", ...)` —
 * no local Ollama daemon and no network traffic. These tests prove the adapter:
 *
 *   1. POSTs the correct `/api/chat` request (URL, body, `stream: false`)
 *      from the provider-agnostic request, with NO auth header.
 *   2. Translates system / user / prior-tool-result messages in order.
 *   3. Maps tool metadata into the Ollama `tools` array.
 *   4. Maps a text-only response to `AgentResponse { text }`.
 *   5. Maps `tool_calls` (including multiple) into provider-independent
 *      intents, generating ids Ollama does not provide.
 *   6. Validates output and rejects malformed responses as `InvalidResponse`.
 *   7. Maps 401/403, 429, 408, other 4xx, 5xx, timeout, and network /
 *      connection-refused failures into `ProviderError`.
 *   8. Honors a configurable model and base URL.
 *   9. Requires NO credential (no key anywhere in request) and never assumes
 *      a model is installed (missing model fails fast at construction).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOllamaProvider,
  type OllamaFetchInit,
} from "./ollamaProvider.js";
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
import { ToolError } from "../tools/errors.js";

type FetchLike = (
  input: string,
  init: OllamaFetchInit,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL = "qwen3";
/** The default local Ollama endpoint the adapter must reach. */
const DEFAULT_URL = "http://localhost:11434/api/chat";

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
  init: OllamaFetchInit;
};

/** A minimal response-shaped object the adapter consumes. */
function makeResponse(body: unknown, status = 200): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * Install a mocked global `fetch` that records requests and returns `body`
 * with `status`. Returns the recorded requests for assertions.
 */
function stubFetch(body: unknown, status = 200): { calls: RequestCapture[] } {
  const calls: RequestCapture[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    return makeResponse(body, status);
  };
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

/** Build the adapter wired to the CURRENTLY-STUBBED global `fetch`. */
function makeProvider(body: unknown, status = 200) {
  const { calls } = stubFetch(body, status);
  const provider = createOllamaProvider({ model: MODEL });
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

function expectOllamaBody(init: OllamaFetchInit): Record<string, unknown> {
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Request construction
// ---------------------------------------------------------------------------

describe("createOllamaProvider — request construction", () => {
  it("POSTs to the local /api/chat endpoint with no auth header and stream:false", async () => {
    const { provider, calls } = makeProvider({
      message: { role: "assistant", content: "ok" },
    });
    await provider.generate(baseRequest());

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) return;
    expect(call.url).toBe(DEFAULT_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    // Local Ollama needs no credential — no Authorization header, ever.
    expect(call.init.headers.Authorization).toBeUndefined();
    const body = expectOllamaBody(call.init);
    expect(body.stream).toBe(false);
    expect(body.model).toBe(MODEL);
  });

  it("honors a configured model and base URL", async () => {
    const { calls } = stubFetch({
      message: { role: "assistant", content: "ok" },
    });
    const provider = createOllamaProvider({
      model: "gpt-oss:20b",
      baseUrl: "http://127.0.0.1:11435/api",
    });
    await provider.generate({ message: "hi", tools: [] });

    expect(calls[0]?.url).toBe("http://127.0.0.1:11435/api/chat");
    const body = calls[0] ? expectOllamaBody(calls[0].init) : {};
    expect(body.model).toBe("gpt-oss:20b");
  });

  it("translates system and user messages in order", async () => {
    const { provider, calls } = makeProvider({
      message: { role: "assistant", content: "ok" },
    });
    await provider.generate(baseRequest());

    const call = calls[0];
    if (!call) return;
    const body = expectOllamaBody(call.init);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(typeof messages[0]?.content).toBe("string");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toBe("List my home directory");
  });

  it("threads prior tool results as assistant tool_calls + tool role messages", async () => {
    const { provider, calls } = makeProvider({
      message: { role: "assistant", content: "done" },
    });
    const results: AgentToolResult[] = [
      { ok: true, callId: "tool-1", data: { entries: ["a.txt"] } },
      {
        ok: false,
        callId: "tool-2",
        error: ToolError.internal("boom"),
      },
    ];
    await provider.generate({ ...baseRequest(), toolResults: results });

    const call = calls[0];
    if (!call) return;
    const body = expectOllamaBody(call.init);
    const messages = body.messages as Array<
      Record<string, unknown> & { role: string; content?: string }
    >;
    expect(messages).toHaveLength(5);
    const assistant = messages[2];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toBe("");
    const toolCalls = assistant?.tool_calls as Array<{
      type: string;
      function: { index: number; name: string; arguments: object };
    }>;
    expect(toolCalls).toHaveLength(2);
    // The stateless loop only knows correlation ids — no original function
    // names travel through, so the placeholder is used on both sides.
    expect(toolCalls[0]?.type).toBe("function");
    expect(toolCalls[0]?.function).toMatchObject({
      index: 0,
      name: "unknown",
      arguments: {},
    });
    expect(toolCalls[1]?.function.index).toBe(1);

    const toolResult1 = messages[3];
    expect(toolResult1?.role).toBe("tool");
    expect(JSON.parse(String(toolResult1?.content))).toEqual({
      entries: ["a.txt"],
    });
  });

  it("threads a failing tool result into the tool role message", async () => {
    const { provider, calls } = makeProvider({
      message: { role: "assistant", content: "done" },
    });
    const results: AgentToolResult[] = [
      { ok: false, callId: "tool-1", error: ToolError.internal("boom") },
    ];
    await provider.generate({ ...baseRequest(), toolResults: results });

    const call = calls[0];
    if (!call) return;
    const body = expectOllamaBody(call.init);
    const messages = body.messages as Array<{ role: string; content?: string }>;
    expect(messages[3]?.role).toBe("tool");
    expect(JSON.parse(String(messages[3]?.content))).toEqual({
      error: "boom",
    });
  });

  it("maps tool metadata into the Ollama tools array", async () => {
    const { provider, calls } = makeProvider({
      message: { role: "assistant", content: "ok" },
    });
    await provider.generate(baseRequest());

    const call = calls[0];
    if (!call) return;
    const body = expectOllamaBody(call.init);
    const tools = body.tools as Array<{
      type: string;
      function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
      };
    }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.function).toMatchObject({
      name: "list_directory",
      description: "The list_directory tool.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    });
  });

  it("omits the tools array when no tools are offered", async () => {
    const { provider, calls } = makeProvider({
      message: { role: "assistant", content: "ok" },
    });
    await provider.generate({ message: "hi", tools: [] });

    const call = calls[0];
    if (!call) return;
    const body = expectOllamaBody(call.init);
    expect(body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Response mapping
// ---------------------------------------------------------------------------

describe("createOllamaProvider — response mapping", () => {
  it("returns provider text for a text-only response", async () => {
    const response = await generateProvider({
      message: { role: "assistant", content: "Here is a summary." },
    });

    expect(response).toEqual({ text: "Here is a summary." });
  });

  it("maps a single tool call into a provider-independent intent", async () => {
    const response = await generateProvider({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "list_directory",
              arguments: { path: "/" },
            },
          },
        ],
      },
    });

    expect(response.toolCalls).toHaveLength(1);
    const intent = response.toolCalls?.[0];
    expect(intent?.toolName).toBe("list_directory");
    expect(intent?.input).toEqual({ path: "/" });
    // Ollama provides no id — the adapter generates one per call.
    expect(intent?.id).toMatch(/^ollama-\d+-\d+$/);
  });

  it("maps multiple tool calls into ordered intents with unique ids", async () => {
    const response = await generateProvider({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a.txt" } } },
          { function: { name: "read_file", arguments: { path: "b.txt" } } },
        ],
      },
    });

    expect(response.toolCalls?.map((c) => c.toolName)).toEqual([
      "read_file",
      "read_file",
    ]);
    expect(response.toolCalls?.map((c) => c.input)).toEqual([
      { path: "a.txt" },
      { path: "b.txt" },
    ]);
    const ids = response.toolCalls?.map((c) => c.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parses a tool-only turn (empty content) as textless", async () => {
    const response = await generateProvider({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "list_directory", arguments: {} } },
        ],
      },
    });

    expect(response.text).toBeUndefined();
    expect(response.toolCalls).toHaveLength(1);
  });

  it("carries both text and tool calls in one response", async () => {
    const response = await generateProvider({
      message: {
        role: "assistant",
        content: "Reading it.",
        tool_calls: [
          { function: { name: "read_file", arguments: { path: "a.txt" } } },
        ],
      },
    });

    expect(response.text).toBe("Reading it.");
    expect(response.toolCalls).toHaveLength(1);
  });

  it("defaults missing arguments to an empty object", async () => {
    const response = await generateProvider({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "list_directory" } }],
      },
    });

    expect(response.toolCalls?.[0]?.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3. Output validation
// ---------------------------------------------------------------------------

describe("createOllamaProvider — output validation", () => {
  it("rejects a non-object body", async () => {
    await expect(generateProvider([1, 2, 3])).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects a response without a message object", async () => {
    await expect(generateProvider({ done: true })).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects a malformed message content type", async () => {
    await expect(
      generateProvider({ message: { role: "assistant", content: 42 } }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects a response with no text and no tool calls", async () => {
    await expect(
      generateProvider({ message: { role: "assistant", content: "" } }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects tool_calls that are not an array", async () => {
    await expect(
      generateProvider({
        message: { role: "assistant", content: "", tool_calls: {} },
      }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects a tool call entry that is not an object", async () => {
    await expect(
      generateProvider({
        message: {
          role: "assistant",
          content: "",
          tool_calls: ["list_directory"],
        },
      }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects a tool call without a function object", async () => {
    await expect(
      generateProvider({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function" }],
        },
      }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects tool calls with a missing or empty name", async () => {
    await expect(
      generateProvider({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { arguments: {} } }],
        },
      }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
    await expect(
      generateProvider({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "", arguments: {} } }],
        },
      }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects tool call arguments that are not a JSON object", async () => {
    await expect(
      generateProvider({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "list_directory", arguments: "path" } },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("passes a valid tool-call batch through the shared validation contract", async () => {
    await expect(
      generateProvider({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "list_directory", arguments: { path: "/" } } },
          ],
        },
      }),
    ).resolves.toMatchObject({ toolCalls: [{ toolName: "list_directory" }] });
  });

  it("rejects a non-JSON response body", async () => {
    const { provider } = makeProvider(null);
    await expect(provider.generate(baseRequest())).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. HTTP failures
// ---------------------------------------------------------------------------

describe("createOllamaProvider — HTTP failures", () => {
  it("maps HTTP 401 to a permanent Authentication error", async () => {
    await expect(generateProvider({}, 401)).rejects.toMatchObject({
      code: ProviderErrorCode.Authentication,
      retryable: false,
    });
  });

  it("maps HTTP 403 to a permanent Authentication error", async () => {
    await expect(generateProvider({}, 403)).rejects.toMatchObject({
      code: ProviderErrorCode.Authentication,
      retryable: false,
    });
  });

  it("maps HTTP 429 to a transient RateLimited error", async () => {
    await expect(generateProvider({}, 429)).rejects.toMatchObject({
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

  it("maps other 4xx (400) to a permanent InvalidResponse error", async () => {
    await expect(generateProvider({}, 400)).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("maps HTTP 404 (unknown model) to a permanent InvalidResponse error", async () => {
    await expect(generateProvider({}, 404)).rejects.toMatchObject({
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

  it("maps a timed-out / aborted request to a transient Timeout error", async () => {
    const fetchLike: FetchLike = async () => {
      throw new DOMException("timed out", "AbortError");
    };
    vi.stubGlobal("fetch", fetchLike);
    const provider = createOllamaProvider({ model: MODEL, timeoutMs: 5 });
    await expect(
      provider.generate({ message: "hi", tools: [] }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      retryable: true,
    });
  });

  it("maps a connection-refused / network failure to a transient Unavailable error", async () => {
    // What Node's fetch surfaces when nothing is listening locally.
    const fetchLike: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    vi.stubGlobal("fetch", fetchLike);
    const provider = createOllamaProvider({ model: MODEL });
    await expect(
      provider.generate({ message: "hi", tools: [] }),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.Unavailable,
      retryable: true,
    });

    try {
      await provider.generate({ message: "hi", tools: [] });
      expect.unreachable("connection failure must reject");
    } catch (error) {
      expect(isProviderError(error)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Construction contract
// ---------------------------------------------------------------------------

describe("createOllamaProvider — construction contract", () => {
  it("requires no credential and never sends an Authorization header", async () => {
    const { provider, calls } = makeProvider({
      message: { role: "assistant", content: "ok" },
    });
    await provider.generate({ message: "hi", tools: [] });

    const call = calls[0];
    if (!call) return;
    expect(Object.keys(call.init.headers).join(",")).not.toMatch(/authorization/i);
    const body = expectOllamaBody(call.init);
    expect(JSON.stringify(body)).not.toMatch(/key|secret|token/i);
  });

  it("throws a permanent error when no model is configured (no default)", () => {
    expect(() => createOllamaProvider({ model: "" })).toThrow(ProviderError);
    expect(() => createOllamaProvider({ model: "" })).toThrowError(
      expect.objectContaining({
        code: ProviderErrorCode.Internal,
        retryable: false,
      }),
    );
  });

  it("never executes tools — only returns intents", async () => {
    const response = await generateProvider({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "list_directory", arguments: { path: "/" } } },
        ],
      },
    });

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0]?.toolName).toBe("list_directory");
  });
});