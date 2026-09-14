/**
 * Ollama (local) provider adapter (Phase 10.16).
 *
 * A production HTTP adapter that sits behind the provider-agnostic
 * `AgentProvider` boundary (`src/services/provider.ts`). It translates the
 * provider-independent request/context into Ollama's `/api/chat` shape, POSTs
 * it to `http://localhost:11434/api/chat` (configurable), and maps the
 * non-streaming response back into `AgentResponse` (`text` and/or
 * `AgentToolCall` intents in the exact Phase 10.1 shape).
 *
 * Architectural boundary:
 *
 *   - Ollama is ONE provider from our application's perspective. The adapter
 *     adds NO provider-selection, credential, or fallback logic: provider
 *     selection (Phase 10.10), credential pooling/rotation (Phase 10.11 /
 *     10.12), and fallback between Grok/Gemini/OpenRouter/Ollama (Phase
 *     10.13) all live in OUR services, untouched here.
 *   - LOCAL OLLAMA NEEDS NO CREDENTIAL: the default
 *     `http://localhost:11434/api` endpoint is unauthenticated. The adapter
 *     has no credential field at all, so it is never forced through
 *     `CredentialPool`. When a connection to the local service cannot be made
 *     (ECONNREFUSED / service down), the failure is a transient `Unavailable`
 *     `ProviderError` so the existing fallback layer moves to the next
 *     provider — the same classification as any other unavailable provider.
 *   - NO MODEL ASSUMPTIONS: the adapter never assumes a specific Ollama model
 *     is installed/pulled. The model is operator-configured (`OLLAMA_MODEL`)
 *     and required at construction; a missing model fails fast without ever
 *     attempting to install or start anything.
 *
 * Wire contract (current official Ollama API):
 *
 *   - Endpoint:      POST /api/chat (base URL defaults to
 *                    `http://localhost:11434/api`).
 *   - Auth:          none — local only. No `Authorization` header is sent.
 *   - Request body:  { model, messages, tools?, stream: false }.
 *   - Messages:      `{ role: "system"|"user"|"assistant"|"tool", content }`
 *                    with `assistant` carrying `tool_calls` and `tool`
 *                    carrying each executed result.
 *   - Tools:         `[{ type: "function", function: { name, description,
 *                    parameters } }]` (JSON-Schema parameters).
 *   - Tool calls:    `message.tool_calls[].function.name` with
 *                    `.function.arguments` as a JSON OBJECT (not a string),
 *                    and no call id — the adapter generates one.
 *
 * Design rules:
 *
 *   - TOOLS ARE NEVER EXECUTED HERE: the adapter only declares tools and
 *     returns intents. Execution belongs exclusively to the agent layer via
 *     `runAgentTurn` / `invokeTool` — never here.
 *   - ALL OUTPUT IS VALIDATED: every response is runtime-checked and every
 *     tool-call batch re-validated through the shared `validateToolCalls`
 *     contract before it becomes an `AgentResponse`. Malformed output is
 *     rejected with a permanent `ProviderError`.
 *   - NO RAW RESPONSES / NO SECRETS IN ERRORS: failures surface as typed
 *     `ProviderError`s with generic messages — raw provider bodies are never
 *     echoed, and there is no credential to leak.
 *   - NO RETRIES: transient failures surface as retryable `ProviderError`s
 *     and are left to the caller.
 *
 * Failure mapping:
 *   - HTTP 401/403 (proxy/remote auth)    → Authentication (permanent)
 *   - HTTP 429                            → RateLimited (transient)
 *   - HTTP 408                            → Timeout (transient)
 *   - HTTP 400/404 (bad request / model)  → InvalidResponse (permanent)
 *   - other 4xx                           → InvalidResponse (permanent)
 *   - connection refused / service down   → Unavailable (transient)
 *   - network / DNS failures              → Unavailable (transient)
 *   - aborted / timed-out requests        → Timeout (transient)
 *   - 5xx / unexpected HTTP status        → Unavailable (transient)
 *   - malformed body / tool calls         → InvalidResponse (permanent)
 *
 * `fetch` is injected (from `globalThis` by default) so tests can stub it
 * with `vi.stubGlobal("fetch", ...)` — no local Ollama daemon and no network.
 */
import type { ToolDefinition } from "../tools/types.js";
import type {
  AgentProvider,
  AgentProviderRequest,
  AgentResponse,
} from "./provider.js";
import {
  ProviderError,
  ProviderErrorCode,
} from "./provider.js";
import type { AgentToolCall } from "./agent.js";
import { validateToolCalls } from "./conversation.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Server-side Ollama (local) settings. Environment-driven via `config`. */
export interface OllamaProviderOptions {
  /**
   * Model sent to the local Ollama API (e.g. "qwen3"). No default exists —
   * we never assume a specific model is installed.
   */
  model: string;
  /**
   * Local Ollama API base URL (default `http://localhost:11434/api`). The
   * endpoint is unauthenticated locally, so no credential is required.
   */
  baseUrl?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * The HTTP transport. Defaults to the global `fetch`. Injectable so tests
   * can mock the network without a local Ollama daemon.
   */
  fetch?: OllamaFetch;
}

/**
 * Minimal fetch surface the adapter relies on. Matches the global `fetch`
 * used by Node 22 so the default injection is a plain `fetch` reference.
 */
export type OllamaFetch = (
  input: string,
  init: OllamaFetchInit,
) => Promise<OllamaFetchResponse>;

/** Request init the adapter sends to Ollama. JSON body, no auth header. */
export interface OllamaFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** The HTTP response interface the adapter consumes from the transport. */
export interface OllamaFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Ollama wire shapes (/api/chat)
// ---------------------------------------------------------------------------

type OllamaMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

type OllamaMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: OllamaToolCallWire[] }
  | { role: "tool"; content: string };

/** The model-side tool call shape: function name + object arguments. No id. */
type OllamaToolCallWire = {
  type?: string;
  function?: {
    index?: number;
    name?: string;
    arguments?: unknown;
  };
};

type OllamaRequest = {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaToolWire[];
  stream: false;
};

type OllamaToolWire = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OllamaResponseWire = {
  message?: unknown;
};

type OllamaMessageWire = {
  content?: unknown;
  tool_calls?: unknown;
};

const OLLAMA_CHAT_ENDPOINT = "/chat";

function invalidResponse(message: string): ProviderError {
  return ProviderError.permanent(ProviderErrorCode.InvalidResponse, message);
}

/**
 * Normalize a request error (network / abort / unknown) into a `ProviderError`.
 *
 * A bare `DOMException` named `AbortError` is how fetch signals a timeout or
 * abort — mapped to the transient `Timeout` code. Everything else (including
 * `TypeError: fetch failed` with an `ECONNREFUSED` cause — i.e. the local
 * Ollama service is down) becomes transient `Unavailable`, which the fallback
 * layer rotates away from.
 */
function toProviderError(error: unknown): ProviderError {
  if (
    error instanceof Error &&
    "name" in error &&
    error.name === "AbortError"
  ) {
    return ProviderError.transient(ProviderErrorCode.Timeout, error.message);
  }
  if (error instanceof ProviderError) return error;
  return ProviderError.transient(
    ProviderErrorCode.Unavailable,
    error instanceof Error ? error.message : "Ollama request failed.",
  );
}

/**
 * Map the provider-agnostic `ToolInputSchema` into an Ollama `tools`
 * function-declaration. Since the schema is a plain, subset JSON-Schema, its
 * JSON representation is passed through as-is; the object is wrapped (rather
 * than deeply cloned) so repeated calls stay cheap.
 */
function toOllamaTools(
  tools: readonly ToolDefinition[],
): OllamaToolWire[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties:
          tool.inputSchema.properties !== undefined
            ? tool.inputSchema.properties
            : undefined,
        required:
          tool.inputSchema.required !== undefined
            ? tool.inputSchema.required
            : undefined,
      },
    },
  }));
}

/**
 * Convert the request's messages into the Ollama message array in
 * conversation order. Prior tool results (from earlier loop rounds) are
 * threaded in Ollama's own format: one synthetic `assistant` message with
 * `tool_calls` followed by one `tool` message per result. The original
 * function names are never reconstructed (the stateless loop only knows the
 * correlation `callId`), so the placeholder name "unknown" is used on both
 * sides — exactly as the Grok/OpenRouter adapters do for the same reason.
 */
function toOllamaMessages(request: AgentProviderRequest): OllamaMessage[] {
  const messages: OllamaMessage[] = [
    {
      role: "system",
      content:
        "You are an assistant that helps the user manage files. You may " +
        "call the provided tools when they help with the task.",
    },
    { role: "user", content: request.message },
  ];

  if (request.toolResults !== undefined && request.toolResults.length > 0) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: request.toolResults.map((result, index) => ({
        type: "function",
        function: {
          index,
          name: "unknown",
          arguments: {},
        },
      })),
    });
    for (const result of request.toolResults) {
      messages.push({
        role: "tool",
        content: result.ok
          ? JSON.stringify(result.data)
          : JSON.stringify({ error: result.error.message }),
      });
    }
  }

  return messages;
}

/**
 * Parse a raw `message.tool_calls` array into `AgentToolCall` intents.
 * Rejects any shape that does not conform, then re-validates the batch
 * through the shared `validateToolCalls` contract. Ollama provides no call
 * id, so one is generated per entry (indexed to stay unique within a batch).
 */
function parseOllamaToolCalls(rawToolCalls: unknown): AgentToolCall[] {
  if (rawToolCalls === undefined) return [];
  if (!Array.isArray(rawToolCalls)) {
    throw invalidResponse("Ollama tool_calls must be an array.");
  }

  const now = Date.now();
  const candidates: AgentToolCall[] = rawToolCalls.map((entry, index) => {
    const call = entry as OllamaToolCallWire;
    if (typeof call !== "object" || call === null || Array.isArray(call)) {
      throw invalidResponse("Each Ollama tool call must be an object.");
    }
    if (typeof call.function !== "object" || call.function === null) {
      throw invalidResponse("Each Ollama tool call must include a function.");
    }
    const functionName = call.function.name;
    if (
      typeof functionName !== "string" ||
      functionName.trim().length === 0
    ) {
      throw invalidResponse(
        "Ollama tool call function must include a non-empty name.",
      );
    }
    const rawArgs = call.function.arguments === undefined ? {} : call.function.arguments;
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      throw invalidResponse(
        "Ollama tool call function arguments must be a JSON object.",
      );
    }
    return {
      id: `ollama-${now}-${index}`,
      toolName: functionName,
      input: rawArgs as Record<string, unknown>,
    };
  });

  try {
    const validated = validateToolCalls(candidates);
    return validated === undefined ? [] : [...validated];
  } catch (error) {
    throw invalidResponse(
      `Ollama tool calls failed validation: ${
        error instanceof Error ? error.message : "unknown reason"
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/**
 * Create an Ollama `AgentProvider` adapter.
 *
 * Local Ollama requires NO credential — no key is accepted or required, and
 * the adapter exists purely to translate the boundary contract. Ollama Cloud
 * authentication is intentionally NOT added here.
 *
 * @throws `ProviderError.permanent(Internal)` when no model is configured —
 *   the adapter never assumes a model is installed and never tries to install
 *   or start one. Fails fast on construction rather than on the first request.
 */
export function createOllamaProvider(
  options: OllamaProviderOptions,
): AgentProvider {
  const model = options.model;
  const baseUrl = options.baseUrl ?? "http://localhost:11434/api";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const transport: OllamaFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  if (model.length === 0) {
    throw ProviderError.permanent(
      ProviderErrorCode.Internal,
      "Ollama model is not configured.",
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}${OLLAMA_CHAT_ENDPOINT}`;

  async function generate(
    request: AgentProviderRequest,
  ): Promise<AgentResponse> {
    const payload: OllamaRequest = {
      model,
      messages: toOllamaMessages(request),
      tools: toOllamaTools(request.tools),
      stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: OllamaFetchResponse;
    try {
      response = await transport(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      // Includes connection refused (local daemon down), network failures,
      // DNS errors, and aborted / timed-out requests. Normalized into the
      // typed ProviderError contract.
      throw toProviderError(error);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw mapHttpError(response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw invalidResponse("Ollama returned a non-JSON response body.");
    }

    return parseOllamaResponse(body);
  }

  return { generate };
}

/**
 * Map a non-OK HTTP status from Ollama into a `ProviderError`.
 */
function mapHttpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return ProviderError.permanent(
      ProviderErrorCode.Authentication,
      `Ollama rejected the request credentials (HTTP ${status}).`,
    );
  }
  if (status === 429) {
    return ProviderError.transient(
      ProviderErrorCode.RateLimited,
      `Ollama rate-limited the request (HTTP ${status}).`,
    );
  }
  if (status === 408) {
    return ProviderError.transient(
      ProviderErrorCode.Timeout,
      `Ollama request timed out on the server (HTTP ${status}).`,
    );
  }
  if (status >= 400 && status < 500) {
    return ProviderError.permanent(
      ProviderErrorCode.InvalidResponse,
      `Ollama rejected the request (HTTP ${status}).`,
    );
  }
  return ProviderError.transient(
    ProviderErrorCode.Unavailable,
    `Ollama request failed with HTTP ${status}.`,
  );
}

/**
 * Parse and validate a raw `/api/chat` response body into an `AgentResponse`.
 * Throws a permanent `InvalidResponse` `ProviderError` on any malformed shape.
 */
function parseOllamaResponse(body: unknown): AgentResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidResponse("Ollama response body must be a JSON object.");
  }
  const message = (body as OllamaResponseWire).message;
  if (typeof message !== "object" || message === null) {
    throw invalidResponse("Ollama response must include a message object.");
  }

  const wire = message as OllamaMessageWire;
  let text: string | undefined;
  if (wire.content !== undefined) {
    if (typeof wire.content !== "string") {
      throw invalidResponse("Ollama message content must be a string.");
    }
    if (wire.content.length > 0) {
      text = wire.content;
    }
  }

  const toolCalls = parseOllamaToolCalls(wire.tool_calls);

  if (text === undefined && toolCalls.length === 0) {
    throw invalidResponse(
      "Ollama response produced no usable content (no text and no tool call).",
    );
  }

  return toolCalls.length > 0 ? { text, toolCalls } : { text };
}