/**
 * OpenRouter provider adapter (Phase 10.15).
 *
 * A production HTTP adapter that sits behind the provider-agnostic
 * `AgentProvider` boundary (`src/services/provider.ts`). It translates the
 * provider-independent request/context into OpenRouter's OpenAI-compatible
 * chat-completions shape, POSTs it to
 * `https://openrouter.ai/api/v1/chat/completions`, and maps the response back
 * into `AgentResponse` (`text` and/or `AgentToolCall` intents in the exact
 * Phase 10.1 shape).
 *
 * Architectural boundary:
 *
 *   - OpenRouter is ONE provider from our application's perspective. It is
 *     the composition point for MANY upstream models, but the adapter does
 *     NOT implement OpenRouter's own selection/fallback mechanism. Provider
 *     selection (Phase 10.10), the credential pool/rotation (Phase 10.11 /
 *     10.12), and fallback between Grok/Gemini/OpenRouter (Phase 10.13) all
 *     live in OUR services, untouched here.
 *
 * Design rules (mirroring the boundary's contract and the Grok adapter):
 *
 *   - SERVER-SIDE ONLY: the OpenRouter API key is supplied exclusively
 *     through the composition/build boundary, never by the agent. No key ever
 *     reaches client code, logs, errors, tool results, or serialized
 *     responses.
 *   - TOOLS ARE NEVER EXECUTED HERE: the adapter only describes tools to the
 *     model and returns intents. Execution belongs exclusively to the agent
 *     layer via `runAgentTurn` / `invokeTool` — never here.
 *   - MODEL IS OPERATOR-CONFIGURED: there is no hard-coded default model.
 *     `OPENROUTER_MODEL` (e.g. "anthropic/claude-sonnet-4") is required at
 *     construction; the adapter fails fast when it is missing.
 *   - ALL OUTPUT IS VALIDATED: every response is runtime-checked before it
 *     becomes an `AgentResponse`. Malformed output is rejected with a
 *     permanent `ProviderError` (never propagated client-side as trust).
 *   - NO RETRIES / NO AUTONOMOUS EXECUTION: transient failures surface as
 *     typed, retryable `ProviderError`s and are left to the caller.
 *
 * Every failure is mapped into the typed `ProviderError` contract:
 *   - HTTP 401/403 authentication problems  → Authentication (permanent)
 *   - HTTP 429 rate limiting / 402 credits  → RateLimited (transient)
 *   - HTTP 408 request timeouts             → Timeout (transient)
 *   - other 4xx client errors               → InvalidResponse (permanent)
 *   - network / DNS failures                → Unavailable (transient)
 *   - aborted / timed-out requests          → Timeout (transient)
 *   - 5xx / unexpected HTTP status          → Unavailable (transient)
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

/** Server-side OpenRouter settings. Environment-driven via `config`. */
export interface OpenRouterProviderOptions {
  /** OpenRouter API key. Must NOT be undefined when the adapter is used. */
  apiKey: string;
  /**
   * Model slug sent to OpenRouter (e.g. "anthropic/claude-sonnet-4"). No
   * default exists — the model is an operator choice and must be configured.
   */
  model: string;
  /** OpenRouter API base URL (default `https://openrouter.ai/api/v1`). */
  baseUrl?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * The HTTP transport. Defaults to the global `fetch`. Injectable so tests
   * can mock the network without a real key or outbound traffic.
   */
  fetch?: OpenRouterFetch;
}

/**
 * Minimal fetch surface the adapter relies on. Matches the global `fetch`
 * used by Node 22 so the default injection is a plain `fetch` reference.
 */
export type OpenRouterFetch = (
  input: string,
  init: OpenRouterFetchInit,
) => Promise<OpenRouterFetchResponse>;

/** Request init the adapter sends to OpenRouter. JSON body, auth header. */
export interface OpenRouterFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** The HTTP response interface the adapter consumes from the transport. */
export interface OpenRouterFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// OpenRouter wire shapes (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

type OpenRouterMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

type OpenRouterMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenRouterToolCallWire[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenRouterToolCallWire = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenRouterRequest = {
  model: string;
  messages: OpenRouterMessage[];
  tools?: OpenRouterToolWire[];
};

type OpenRouterToolWire = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type OpenRouterChoice = {
  message?: {
    content?: unknown;
    tool_calls?: unknown;
  };
};

type OpenRouterResponse = {
  choices?: unknown;
};

const OR_CHAT_COMPLETIONS_ENDPOINT = "/chat/completions";

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
    error instanceof Error ? error.message : "OpenRouter request failed.",
  );
}

/**
 * Map the provider-agnostic `ToolInputSchema` into an OpenAI-compatible JSON
 * Schema object for the OpenRouter `tools` array. Since the schema is a plain,
 * subset JSON-Schema, its JSON representation is passed through as-is; the
 * object is wrapped (rather than deeply cloned) so repeated calls stay cheap.
 */
function toOpenRouterTools(
  tools: readonly ToolDefinition[],
): OpenRouterToolWire[] | undefined {
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
 * tool results) into the OpenRouter message array in conversation order. Prior
 * results are threaded as the OpenAI `tool`-message shape (synthetic assistant
 * `tool_calls` + matching `tool` replies) so multi-turn tool loops stay valid.
 */
function toOpenRouterMessages(request: AgentProviderRequest): OpenRouterMessage[] {
  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content:
        "You are an assistant that helps the user manage files. You may " +
        "call the provided tools when they help with the task.",
    },
    { role: "user", content: request.message },
  ];

  if (request.toolResults !== undefined && request.toolResults.length > 0) {
    const asAssistant: OpenRouterMessage = {
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
 * Parse a raw `choices[0].message` into provider-independent `text`.
 * `content` may be `null` (tool-only turns) — treated as no text.
 */
function parseOpenRouterText(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content !== "string") {
    throw invalidResponse("OpenRouter message content must be a string or null.");
  }
  if (content.length === 0) return undefined;
  return content;
}

/**
 * Parse a raw `choices[0].message.tool_calls` array into `AgentToolCall`
 * intents. Rejects any shape that does not conform, then re-validates the
 * batch through the shared `validateToolCalls` contract.
 */
function parseOpenRouterToolCalls(rawToolCalls: unknown): AgentToolCall[] {
  if (rawToolCalls === undefined) return [];
  if (!Array.isArray(rawToolCalls)) {
    throw invalidResponse("OpenRouter tool_calls must be an array.");
  }

  const candidates: AgentToolCall[] = rawToolCalls.map((entry) => {
    const call = entry as OpenRouterToolCallWire;
    if (typeof call !== "object" || call === null || Array.isArray(call)) {
      throw invalidResponse("Each OpenRouter tool call must be an object.");
    }
    if (call.type !== "function") {
      throw invalidResponse(
        `OpenRouter returned a non-function tool call (type "${String(call.type)}").`,
      );
    }
    const functionName = call.function?.name;
    const argumentsText = call.function?.arguments;
    if (
      typeof functionName !== "string" ||
      functionName.trim().length === 0
    ) {
      throw invalidResponse(
        "OpenRouter tool call function must include a non-empty name.",
      );
    }
    if (typeof argumentsText !== "string") {
      throw invalidResponse(
        "OpenRouter tool call function arguments must be a JSON string.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(argumentsText);
    } catch {
      throw invalidResponse(
        "OpenRouter tool call function arguments are not valid JSON.",
      );
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw invalidResponse(
        "OpenRouter tool call function arguments must be a JSON object.",
      );
    }
    return {
      id: call.id === undefined ? `openrouter-${Date.now()}` : call.id,
      toolName: functionName,
      input: input as Record<string, unknown>,
    };
  });

  try {
    const validated = validateToolCalls(candidates);
    return validated === undefined ? [] : [...validated];
  } catch (error) {
    throw invalidResponse(
      `OpenRouter tool calls failed validation: ${
        error instanceof Error ? error.message : "unknown reason"
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/**
 * Create an OpenRouter `AgentProvider` adapter.
 *
 * @throws `ProviderError.permanent(Authentication)` when no API key is
 *   configured — the adapter cannot reach OpenRouter without a credential.
 * @throws `ProviderError.permanent(Internal)` when no model slug is
 *   configured — OpenRouter forwards any model and we never guess one here.
 *   Both fail fast on construction rather than on the first request.
 */
export function createOpenRouterProvider(
  options: OpenRouterProviderOptions,
): AgentProvider {
  const apiKey = options.apiKey;
  const model = options.model;
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const transport: OpenRouterFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  if (apiKey.length === 0) {
    throw ProviderError.permanent(
      ProviderErrorCode.Authentication,
      "OpenRouter API key is not configured.",
    );
  }
  if (model.length === 0) {
    throw ProviderError.permanent(
      ProviderErrorCode.Internal,
      "OpenRouter model is not configured.",
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}${OR_CHAT_COMPLETIONS_ENDPOINT}`;

  async function generate(
    request: AgentProviderRequest,
  ): Promise<AgentResponse> {
    const payload: OpenRouterRequest = {
      model,
      messages: toOpenRouterMessages(request),
      tools: toOpenRouterTools(request.tools),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: OpenRouterFetchResponse;
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
      throw invalidResponse("OpenRouter returned a non-JSON response body.");
    }

    return parseOpenRouterResponse(body);
  }

  return { generate };
}

/**
 * Map a non-OK HTTP status from OpenRouter into a `ProviderError`.
 */
function mapHttpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return ProviderError.permanent(
      ProviderErrorCode.Authentication,
      `OpenRouter rejected the API key (HTTP ${status}).`,
    );
  }
  // 402 = insufficient credits and 429 = rate limited: both are transient and
  // may recover after top-up / cooldown (or via another pooled credential).
  if (status === 402 || status === 429) {
    return ProviderError.transient(
      ProviderErrorCode.RateLimited,
      `OpenRouter rate-limited the request (HTTP ${status}).`,
    );
  }
  if (status === 408) {
    return ProviderError.transient(
      ProviderErrorCode.Timeout,
      `OpenRouter request timed out on the server (HTTP ${status}).`,
    );
  }
  if (status >= 400 && status < 500) {
    return ProviderError.permanent(
      ProviderErrorCode.InvalidResponse,
      `OpenRouter rejected the request (HTTP ${status}).`,
    );
  }
  return ProviderError.transient(
    ProviderErrorCode.Unavailable,
    `OpenRouter request failed with HTTP ${status}.`,
  );
}

/**
 * Parse and validate a raw OpenRouter chat-completions body into an
 * `AgentResponse`. Throws a permanent `InvalidResponse` `ProviderError` on any
 * malformed shape.
 */
function parseOpenRouterResponse(body: unknown): AgentResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidResponse("OpenRouter response body must be a JSON object.");
  }
  const response = body as OpenRouterResponse;
  if (!Array.isArray(response.choices)) {
    throw invalidResponse("OpenRouter response must include a choices array.");
  }
  if (response.choices.length === 0) {
    throw invalidResponse(
      "OpenRouter response choices array must not be empty.",
    );
  }

  const first = response.choices[0];
  if (typeof first !== "object" || first === null) {
    throw invalidResponse("OpenRouter response choice must be an object.");
  }
  const choice = first as OpenRouterChoice;
  if (typeof choice.message !== "object" || choice.message === null) {
    throw invalidResponse("OpenRouter response choice must include a message.");
  }

  const text = parseOpenRouterText(choice.message.content);
  const toolCalls = parseOpenRouterToolCalls(choice.message.tool_calls);

  return toolCalls.length > 0 ? { text, toolCalls } : { text };
}