/**
 * Grok (xAI) provider adapter (Phase 10.9).
 *
 * A production HTTP adapter that sits behind the provider-agnostic
 * `AgentProvider` boundary (`src/services/provider.ts`). It translates the
 * provider-independent request/context into xAI's OpenAI-compatible chat
 * completions shape, POSTs it to `https://api.x.ai/v1/chat/completions`, and
 * maps the response back into `AgentResponse` (`text` and/or `AgentToolCall`
 * intents in the exact Phase 10.1 shape).
 *
 * Design rules (mirroring the boundary's contract):
 *
 *   - SERVER-SIDE ONLY: the xAI API key is read from server configuration
 *     (`config.grok`), which is environment-driven. No key ever reaches the
 *     client, and the adapter performs no authentication of its own.
 *   - TOOLS ARE NEVER EXECUTED HERE: the adapter only describes tools to the
 *     model and returns intents. Execution belongs exclusively to the agent
 *     layer via `runAgentTurn` / `invokeTool` — never here.
 *   - NO xAI BUILT-IN TOOLS: only the registered tools from the request are
 *     offered; web search / code execution / file-system access are never
 *     enabled.
 *   - ALL OUTPUT IS VALIDATED: every response is runtime-checked before it
 *     becomes an `AgentResponse`. Malformed output is rejected with a
 *     permanent `ProviderError` (never propagated client-side as trust).
 *   - NO RETRIES / NO AUTONOMOUS EXECUTION: transient failures surface as
 *     typed, retryable `ProviderError`s and are left to the caller.
 *
 * Every failure is mapped into the typed `ProviderError` contract:
 *   - HTTP 4xx authentication problems      → Authentication (permanent)
 *   - HTTP 429 rate limiting                → RateLimited (transient)
 *   - other 4xx client errors               → InvalidResponse (permanent)
 *   - network / DNS failures                → Unavailable (transient)
 *   - aborted / timed-out requests          → Timeout (transient)
 *   - 5xx / unexpected HTTP status          → Internal (transient)
 *   - malformed body / tool calls           → InvalidResponse (permanent)
 *
 * `fetch` is injected (from `globalThis` by default) so tests can stub it
 * with `vi.stubGlobal("fetch", ...)` — no real key and no network needed.
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

/** Server-side Grok (xAI) settings. Read from environment-driven config. */
export interface GrokProviderOptions {
  /** xAI API key. Must NOT be undefined when the adapter is used. */
  apiKey: string;
  /** Model sent to the xAI API. */
  model: string;
  /** xAI API base URL (default `https://api.x.ai/v1`). */
  baseUrl?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * The HTTP transport. Defaults to the global `fetch`. Injectable so tests
   * can mock the network without a real key or outbound traffic.
   */
  fetch?: GrokFetch;
}

/**
 * Minimal fetch surface the adapter relies on. Matches the global `fetch`
 * used by Node 22 so the default injection is a plain `fetch` reference.
 */
export type GrokFetch = (
  input: string,
  init: GrokFetchInit,
) => Promise<GrokFetchResponse>;

/** Request init the adapter sends to xAI. JSON body, auth header. */
export interface GrokFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** The HTTP response interface the adapter consumes from the transport. */
export interface GrokFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// xAI wire shapes
// ---------------------------------------------------------------------------

type GrokMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

type GrokMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: GrokToolCallWire[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type GrokToolCallWire = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type GrokRequest = {
  model: string;
  messages: GrokMessage[];
  tools?: GrokToolWire[];
};

type GrokToolWire = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type GrokChoice = {
  message?: {
    content?: unknown;
    tool_calls?: unknown;
  };
};

type GrokResponse = {
  choices?: unknown;
};

const XAI_CHAT_COMPLETIONS_ENDPOINT = "/chat/completions";

function invalidResponse(message: string): ProviderError {
  return ProviderError.permanent(ProviderErrorCode.InvalidResponse, message);
}

/**
 * Normalize a request error (network / abort / unknown) into a `ProviderError`.
 * A bare `DOMException` named `AbortError` is how fetch signals a timeout or
 * abort — mapped to the transient `Timeout` code.
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
    error instanceof Error ? error.message : "Grok request failed.",
  );
}

/**
 * Map the provider-agnostic `ToolInputSchema` into an OpenAI-compatible JSON
 * Schema object for the xAI `tools` array. Since the schema is a plain,
 * subset JSON-Schema, its JSON representation is passed through as-is; the
 * object is wrapped (rather than deeply cloned) so repeated calls stay cheap.
 */
function toGrokTools(tools: readonly ToolDefinition[]): GrokToolWire[] | undefined {
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
 * Convert the request's messages (system context, user prompt, and any prior
 * tool results) into the xAI message array in conversation order.
 */
function toGrokMessages(request: AgentProviderRequest): GrokMessage[] {
  const messages: GrokMessage[] = [
    {
      role: "system",
      content:
        "You are an assistant that helps the user manage files. You may " +
        "call the provided tools when they help with the task.",
    },
    { role: "user", content: request.message },
  ];

  if (request.toolResults !== undefined && request.toolResults.length > 0) {
    const asAssistant: GrokMessage = {
      role: "assistant",
      content: null,
      tool_calls: request.toolResults.map((result) => ({
        id: result.callId,
        type: "function",
        function: {
          name: "unknown",
          arguments: "{}",
        },
      })),
    };
    messages.push(asAssistant);
    for (const result of request.toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.callId,
        content: result.ok
          ? JSON.stringify(result.data)
          : JSON.stringify({ error: result.error.message }),
      });
    }
  }

  return messages;
}

/**
 * Parse a raw xAI `choices[0].message` into provider-independent `text`.
 * `content` may be `null` (tool-only turns) — treated as no text.
 */
function parseGrokText(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content !== "string") {
    throw invalidResponse("Grok message content must be a string or null.");
  }
  if (content.length === 0) return undefined;
  return content;
}

/**
 * Parse a raw xAI `choices[0].message.tool_calls` array into `AgentToolCall`
 * intents. Rejects any shape that does not conform, then re-validates the
 * batch through the shared `validateToolCalls` contract.
 */
function parseGrokToolCalls(rawToolCalls: unknown): AgentToolCall[] {
  if (rawToolCalls === undefined) return [];
  if (!Array.isArray(rawToolCalls)) {
    throw invalidResponse("Grok tool_calls must be an array.");
  }

  const candidates: AgentToolCall[] = rawToolCalls.map((entry) => {
    const call = entry as GrokToolCallWire;
    if (typeof call !== "object" || call === null || Array.isArray(call)) {
      throw invalidResponse("Each Grok tool call must be an object.");
    }
    if (call.type !== "function") {
      throw invalidResponse(
        `Grok returned a non-function tool call (type "${String(call.type)}").`,
      );
    }
    const functionName = call.function?.name;
    const argumentsText = call.function?.arguments;
    if (
      typeof functionName !== "string" ||
      functionName.trim().length === 0
    ) {
      throw invalidResponse(
        "Grok tool call function must include a non-empty name.",
      );
    }
    if (typeof argumentsText !== "string") {
      throw invalidResponse(
        "Grok tool call function arguments must be a JSON string.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(argumentsText);
    } catch {
      throw invalidResponse(
        "Grok tool call function arguments are not valid JSON.",
      );
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw invalidResponse(
        "Grok tool call function arguments must be a JSON object.",
      );
    }
    return {
      id: call.id === undefined ? `grok-${Date.now()}` : call.id,
      toolName: functionName,
      input: input as Record<string, unknown>,
    };
  });

  try {
    const validated = validateToolCalls(candidates);
    return validated === undefined ? [] : [...validated];
  } catch (error) {
    throw invalidResponse(
      `Grok tool calls failed validation: ${
        error instanceof Error ? error.message : "unknown reason"
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/**
 * Create a Grok (xAI) `AgentProvider` adapter.
 *
 * @throws `ProviderError.permanent(Authentication)` when no API key is
 *   configured — the adapter cannot reach xAI without a credential. Fails
 *   fast on construction rather than on the first request.
 */
export function createGrokProvider(
  options: GrokProviderOptions,
): AgentProvider {
  const apiKey = options.apiKey;
  const model = options.model;
  const baseUrl = options.baseUrl ?? "https://api.x.ai/v1";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const transport: GrokFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  if (apiKey.length === 0) {
    throw ProviderError.permanent(
      ProviderErrorCode.Authentication,
      "Grok API key is not configured.",
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}${XAI_CHAT_COMPLETIONS_ENDPOINT}`;

  async function generate(
    request: AgentProviderRequest,
  ): Promise<AgentResponse> {
    const payload: GrokRequest = {
      model,
      messages: toGrokMessages(request),
      tools: toGrokTools(request.tools),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: GrokFetchResponse;
    try {
      response = await transport(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      // Includes network failures, DNS errors, and aborted / timed-out
      // requests. Normalized into the typed ProviderError contract.
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
      throw invalidResponse("Grok returned a non-JSON response body.");
    }

    return parseGrokResponse(body);
  }

  return { generate };
}

/**
 * Map a non-OK HTTP status from xAI into a `ProviderError`.
 */
function mapHttpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return ProviderError.permanent(
      ProviderErrorCode.Authentication,
      `Grok rejected the API key (HTTP ${status}).`,
    );
  }
  if (status === 429) {
    return ProviderError.transient(
      ProviderErrorCode.RateLimited,
      `Grok rate-limited the request (HTTP ${status}).`,
    );
  }
  if (status >= 400 && status < 500) {
    return ProviderError.permanent(
      ProviderErrorCode.InvalidResponse,
      `Grok rejected the request (HTTP ${status}).`,
    );
  }
  return ProviderError.transient(
    ProviderErrorCode.Internal,
    `Grok request failed with HTTP ${status}.`,
  );
}

/**
 * Parse and validate a raw xAI chat-completions body into an `AgentResponse`.
 * Throws a permanent `InvalidResponse` `ProviderError` on any malformed shape.
 */
function parseGrokResponse(body: unknown): AgentResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidResponse("Grok response body must be a JSON object.");
  }
  const response = body as GrokResponse;
  if (!Array.isArray(response.choices)) {
    throw invalidResponse("Grok response must include a choices array.");
  }
  if (response.choices.length === 0) {
    throw invalidResponse("Grok response choices array must not be empty.");
  }

  const first = response.choices[0];
  if (typeof first !== "object" || first === null) {
    throw invalidResponse("Grok response choice must be an object.");
  }
  const choice = first as GrokChoice;
  if (typeof choice.message !== "object" || choice.message === null) {
    throw invalidResponse("Grok response choice must include a message.");
  }

  const text = parseGrokText(choice.message.content);
  const toolCalls = parseGrokToolCalls(choice.message.tool_calls);

  return toolCalls.length > 0 ? { text, toolCalls } : { text };
}
