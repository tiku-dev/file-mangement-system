/**
 * Gemini (Google AI) provider adapter tests (Phase 10.14).
 *
 * The HTTP transport (`fetch`) is MOCKED via `vi.stubGlobal("fetch", ...)` —
 * no real Gemini key and no network traffic. These tests prove the adapter:
 *
 *   1. POSTs the correct generateContent request (URL, `x-goog-api-key`
 *      header, body) from the provider-agnostic request.
 *   2. Maps tool metadata into Gemini `functionDeclarations`.
 *   3. Maps a text-only response to `AgentResponse { text }`.
 *   4. Maps `functionCall` parts into provider-independent intents.
 *   5. Embeds prior tool results as structured user context.
 *   6. Drops "thought" parts so internal reasoning never reaches the agent.
 *   7. Validates output and rejects malformed responses as `InvalidResponse`.
 *   8. Maps auth / rate-limit / 5xx / timeout / network into `ProviderError`.
 *   9. Keeps the API key out of errors and serialized messages.
 *  10. Honors a configurable model and base URL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGeminiProvider,
  type GeminiFetchInit,
} from "./geminiProvider.js";
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
import type { AgentToolCall } from "./agent.js";
import type { AgentToolResult } from "./agent.js";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const API_KEY = "gemini-test-key";
const MODEL = "gemini-3.5-flash";

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

/** A Gemini response with a single candidate whose parts are given. */
function candidateResponse(parts: unknown[]): unknown {
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: { totalTokenCount: 1 },
  };
}

type RequestCapture = {
  url: string;
  init: GeminiFetchInit;
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
      init: init as unknown as GeminiFetchInit,
    });
    return makeResponse(body, status);
  };
  vi.stubGlobal("fetch", fetch);
  return { calls };
}

/** Build the adapter wired to the CURRENTLY-STUBBED global `fetch`. */
function makeProvider(body: unknown, status = 200) {
  const { calls } = stubFetch(body, status);
  const provider = createGeminiProvider({ apiKey: API_KEY, model: MODEL });
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

function expectGeminiBody(init: GeminiFetchInit): Record<string, unknown> {
  return JSON.parse(init.body) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Request construction
// ---------------------------------------------------------------------------

describe("createGeminiProvider — request construction", () => {
  it("POSTs to the generateContent endpoint with the API-key header", async () => {
    const { provider, calls } = makeProvider(candidateResponse([{ text: "ok" }]));
    await provider.generate(baseRequest());

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) return;
    expect(call.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    );
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["x-goog-api-key"]).toBe(API_KEY);
    expect(call.init.headers["Content-Type"]).toBe("application/json");
  });

  it("honors a configured model and base URL", async () => {
    const { calls } = stubFetch(candidateResponse([{ text: "ok" }]));
    const provider = createGeminiProvider({
      apiKey: API_KEY,
      model: "gemini-2.5-pro",
      baseUrl: "https://proxy.example/v1beta",
    });
    await provider.generate({ message: "hi", tools: [] });

    expect(calls[0]?.url).toBe("https://proxy.example/v1beta/models/gemini-2.5-pro:generateContent");
  });

  it("includes the user message and system instruction in the body", async () => {
    const { provider, calls } = makeProvider(candidateResponse([{ text: "ok" }]));
    await provider.generate({ message: "Hello there", tools: [] });

    const call = calls[0];
    if (!call) return;
    const body = expectGeminiBody(call.init);
    const contents = body.contents as Array<Record<string, unknown>>;
    expect(contents).toHaveLength(1);
    expect(contents[0]?.role).toBe("user");
    const parts = contents[0]?.parts as Array<Record<string, unknown>>;
    expect(parts[0]?.text).toBe("Hello there");
    const systemInstruction = body.systemInstruction as Record<string, unknown>;
    const systemParts = systemInstruction.parts as Array<Record<string, unknown>>;
    expect(systemParts[0]?.text).toContain("assistant");
  });

  it("maps tool metadata into Gemini functionDeclarations", async () => {
    const { provider, calls } = makeProvider(candidateResponse([{ text: "ok" }]));
    await provider.generate(baseRequest());

    const call = calls[0];
    if (!call) return;
    const body = expectGeminiBody(call.init);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    const declarations = tools[0]?.functionDeclarations as Array<
      Record<string, unknown>
    >;
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.name).toBe("list_directory");
    expect(declarations[0]?.description).toContain("list_directory");
    expect(declarations[0]?.parameters).toEqual({
      type: "OBJECT",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  it("omits the tools array when no tools are offered", async () => {
    const { provider, calls } = makeProvider(candidateResponse([{ text: "hi" }]));
    await provider.generate({ message: "hi", tools: [] });

    const call = calls[0];
    if (!call) return;
    const body = expectGeminiBody(call.init);
    expect(body.tools).toBeUndefined();
  });

  it("embeds prior tool results as structured user context in order", async () => {
    const results: AgentToolResult[] = [
      { ok: true, callId: "a", data: { items: [] } },
      { ok: false, callId: "b", error: new Error("denied") as never },
    ];
    const { provider, calls } = makeProvider(candidateResponse([{ text: "done" }]));
    await provider.generate({ ...baseRequest(), toolResults: results });

    const call = calls[0];
    if (!call) return;
    const body = expectGeminiBody(call.init);
    const contents = body.contents as Array<Record<string, unknown>>;
    expect(contents).toHaveLength(2);
    expect(contents[1]?.role).toBe("user");
    const resultText = (
      (contents[1]?.parts as Array<Record<string, unknown>>)[0] as {
        text: string;
      }
    ).text;
    expect(resultText).toContain("- a: {\"items\":[]}");
    expect(resultText).toContain("- b: {\"error\":\"denied\"}");
  });
});

// ---------------------------------------------------------------------------
// 2. Response mapping
// ---------------------------------------------------------------------------

describe("createGeminiProvider — response mapping", () => {
  it("returns provider text for a text-only response", async () => {
    const response = await generateProvider(
      candidateResponse([{ text: "Here is your answer." }]),
    );
    expect(response.text).toBe("Here is your answer.");
    expect(response.toolCalls).toBeUndefined();
  });

  it("joins multiple text parts into a single reply", async () => {
    const response = await generateProvider(
      candidateResponse([{ text: "First." }, { text: "Second." }]),
    );
    expect(response.text).toBe("First.\nSecond.");
  });

  it("drops thought/reasoning parts from the reply", async () => {
    const response = await generateProvider(
      candidateResponse([
        { thought: true, text: "internal chain-of-thought..." },
        { text: "Final answer." },
      ]),
    );
    expect(response.text).toBe("Final answer.");
  });

  it("maps Gemini functionCall parts into provider-independent intents", async () => {
    const response = await generateProvider(
      candidateResponse([
        { text: "Opening it." },
        {
          functionCall: {
            name: "list_directory",
            args: { path: "/home" },
          },
        },
      ]),
    );
    expect(response.text).toBe("Opening it.");
    expect(response.toolCalls).toEqual([
      { id: expect.stringMatching(/^gemini-call-\d+$/), toolName: "list_directory", input: { path: "/home" } },
    ]);
  });

  it("preserves a Gemini-provided function call id", async () => {
    const response = await generateProvider(
      candidateResponse([
        {
          functionCall: {
            id: "8f2b1a3c",
            name: "list_directory",
            args: { path: "/home" },
          },
        },
      ]),
    );
    expect(response.toolCalls?.[0]?.id).toBe("8f2b1a3c");
  });

  it("defaults missing functionCall args to an empty object", async () => {
    const response = await generateProvider(
      candidateResponse([{ functionCall: { name: "refresh" } }]),
    );
    expect(response.toolCalls?.[0]?.input).toEqual({});
  });

  it("supports a tool-only turn with no text", async () => {
    const response = await generateProvider(
      candidateResponse([
        { functionCall: { name: "search_files", args: { query: "notes" } } },
      ]),
    );
    expect(response.text).toBeUndefined();
    expect(response.toolCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Output validation
// ---------------------------------------------------------------------------

describe("createGeminiProvider — output validation", () => {
  it("rejects a non-object body", async () => {
    await expect(generateProvider("nope")).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("rejects a missing or empty candidates array", async () => {
    await expect(generateProvider({})).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
    });
    await expect(generateProvider({ candidates: [] })).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
    });
  });

  it("rejects a candidate without a parts array", async () => {
    await expect(
      generateProvider(candidateResponse(undefined as unknown as unknown[])),
    ).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
    });
    await expect(generateProvider({ candidates: [{}] })).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
    });
  });

  it("rejects a non-string text part", async () => {
    await expect(
      generateProvider(candidateResponse([{ text: 42 }])),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });

  it("rejects a functionCall without a name", async () => {
    await expect(
      generateProvider(candidateResponse([{ functionCall: { args: {} } }])),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });

  it("rejects a functionCall with an empty name", async () => {
    await expect(
      generateProvider(candidateResponse([{ functionCall: { name: "   " } }])),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });

  it("rejects functionCall args that are not a JSON object", async () => {
    await expect(
      generateProvider(
        candidateResponse([{ functionCall: { name: "x", args: [1, 2] } }]),
      ),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });

  it("rejects a candidate with no usable content", async () => {
    await expect(
      generateProvider(candidateResponse([{ thought: true, text: "..." }])),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
    await expect(generateProvider(candidateResponse([]))).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Error mapping
// ---------------------------------------------------------------------------

describe("createGeminiProvider — HTTP and transport error mapping", () => {
  it("maps HTTP 401 to a permanent Authentication error", async () => {
    await expect(
      generateProvider({ error: { status: "UNAUTHENTICATED" } }, 401),
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

  it("maps HTTP 408 to a transient Timeout error", async () => {
    await expect(generateProvider({}, 408)).rejects.toMatchObject({
      code: ProviderErrorCode.Timeout,
      retryable: true,
    });
  });

  it("maps HTTP 400 to a permanent InvalidResponse error", async () => {
    await expect(generateProvider({ error: "bad" }, 400)).rejects.toMatchObject({
      code: ProviderErrorCode.InvalidResponse,
      retryable: false,
    });
  });

  it("maps HTTP 500 and 503 to a transient Unavailable error", async () => {
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
    const provider = createGeminiProvider({
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
    const provider = createGeminiProvider({ apiKey: API_KEY, model: MODEL });
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
    const provider = createGeminiProvider({ apiKey: API_KEY, model: MODEL });
    await expect(
      provider.generate({ message: "hi", tools: [] }),
    ).rejects.toMatchObject({ code: ProviderErrorCode.InvalidResponse });
  });
});

// ---------------------------------------------------------------------------
// 5. Credential secrecy
// ---------------------------------------------------------------------------

describe("createGeminiProvider — credential secrecy", () => {
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
    const { provider, calls } = makeProvider(candidateResponse([{ text: "ok" }]));
    await provider.generate({ message: "hi", tools: [] });
    const call = calls[0];
    if (!call) return;
    expect(call.init.body).not.toContain(API_KEY);
  });

  it("returns only validated intents — the key is never part of tool input", async () => {
    const { provider } = makeProvider(
      candidateResponse([
        { functionCall: { name: "list_directory", args: { path: "/" } } },
      ]),
    );
    const response = await provider.generate({ message: "hi", tools: [] });
    const call = response.toolCalls?.[0] as unknown as AgentToolCall;
    expect(call.toolName).toBe("list_directory");
    expect(JSON.stringify(response)).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// 6. Construction / provider contract
// ---------------------------------------------------------------------------

describe("createGeminiProvider — construction and contract", () => {
  it("throws Authentication when no API key is configured", () => {
    expect(() =>
      createGeminiProvider({ apiKey: "", model: MODEL }),
    ).toThrowError(ProviderError);
    expect(() => createGeminiProvider({ apiKey: "", model: MODEL })).toThrowError(
      expect.objectContaining({
        code: ProviderErrorCode.Authentication,
        retryable: false,
      }),
    );
  });

  it("never executes tools — only returns intents", async () => {
    // A function-call response comes back as an intent; nothing is run here.
    const response = await generateProvider(
      candidateResponse([
        { functionCall: { name: "create_file", args: { path: "/evil" } } },
      ]),
    );
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls?.[0]?.toolName).toBe("create_file");
  });
});