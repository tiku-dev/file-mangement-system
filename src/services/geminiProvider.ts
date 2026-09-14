/**
 * Gemini (Google AI) provider adapter (Phase 10.14).
 *
 * A production HTTP adapter that sits behind the provider-agnostic
 * `AgentProvider` boundary (`src/services/provider.ts`). It translates the
 * provider-independent request/context into Gemini's `generateContent` REST
 * shape, POSTs it to
 * `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,
 * and maps the response back into `AgentResponse` (`text` and/or `AgentToolCall`
 * intents in the exact Phase 10.1 shape).
 *
 * Design rules (mirroring the boundary's contract and the Grok adapter):
 *
 *   - SERVER-SIDE ONLY: the Gemini API key is supplied exclusively through
 *     the composition/build boundary (e.g. the `ProviderFactory` hook that
 *     `createProviderRegistry` registers), never by the agent. No key ever
 *     reaches client code, logs, errors, or serialized responses.
 *   - TOOLS ARE NEVER EXECUTED HERE: the adapter only declares tools to the
 *     model and returns intents. Execution belongs exclusively to the agent
 *     layer via `runAgentTurn` / `invokeTool` — never here.
 *   - NO GEMINI BUILT-IN TOOLS: only the registered tools from the request are
 *     offered; Google search / code execution are never enabled.
 *   - ALL OUTPUT IS VALIDATED: every response is runtime-checked before it
 *     becomes an `AgentResponse`. Malformed output is rejected with a
 *     permanent `ProviderError` (never propagated client-side as trust).
 *     "Thought" parts from Gemini's reasoning models are discarded so internal
 *     reasoning never leaks into agent context.
 *   - STATELESS ROUND-TRIPS: the previous assistant turn is not tracked here.
 *     Results from earlier rounds (`request.toolResults`) carry a correlation
 *     `callId` but no reconstructed function name or arguments, so they are
 *     embedded as structured user context text instead of fabricated
 *     `functionResponse` parts (which Gemini requires to match a declared
 *     function name).
 *   - NO RETRIES / NO AUTONOMOUS EXECUTION: transient failures surface as
 *     typed, retryable `ProviderError`s and are left to the caller (the
 *     fallback orchestrator owns rotation, not this adapter).
 *
 * Every failure is mapped into the typed `ProviderError` contract:
 *   - HTTP 401/403 authentication problems  → Authentication (permanent)
 *   - HTTP 429 rate limiting                → RateLimited (transient)
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

/** Server-side Gemini (Google AI) settings. Environment-driven via `config`. */
export interface GeminiProviderOptions {
  /** Gemini API key. Must NOT be undefined when the adapter is used. */
  apiKey: string;
  /** Model sent to the Gemini generateContent API. */
  model: string;
  /** Google AI Studio API base URL (default the official v1beta endpoint). */
  baseUrl?: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * The HTTP transport. Defaults to the global `fetch`. Injectable so tests
   * can mock the network without a real key or outbound traffic.
   */
  fetch?: GeminiFetch;
}

/**
 * Minimal fetch surface the adapter relies on. Matches the global `fetch`
 * used by Node 22 so the default injection is a plain `fetch` reference.
 */
export type GeminiFetch = (
  input: string,
  init: GeminiFetchInit,
) => Promise<GeminiFetchResponse>;

/** Request init the adapter sends to Gemini. JSON body, API-key header. */
export interface GeminiFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** The HTTP response interface the adapter consumes from the transport. */
export interface GeminiFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Gemini wire shapes (v1beta generateContent REST contract)
// ---------------------------------------------------------------------------

/** A single content message sent to the API. `role` allows "user" only here. */
type GeminiContentWire = {
  role: "user";
  parts: GeminiPartWire[];
};

/** A part: text or a function call. Other media part types are never sent. */
type GeminiPartWire = {
  text?: string;
  thought?: boolean;
};

type GeminiFunctionCallWire = {
  name: string;
  args?: unknown;
};

/** `generateContent` request body: contents + system instruction + tools. */
type GeminiRequestWire = {
  contents: GeminiContentWire[];
  systemInstruction: { parts: { text: string }[] };
  tools?: GeminiToolWire[];
};

/** A Gemini `Tool` — one functionDeclarations array (function calling only). */
type GeminiToolWire = {
  functionDeclarations: {
    name: string;
    description: string;
    parameters: {
      type: "OBJECT";
      properties?: ToolDefinition["inputSchema"]["properties"];
      required?: string[];
    };
  }[];
};

/** The response's top-level `GenerateContentResponse`. */
type GeminiResponseWire = {
  candidates?: unknown;
};

/** One `Candidate`: the model's content (text and/or function calls). */
type GeminiCandidateWire = {
  content?: unknown;
};

const SYSTEM_INSTRUCTION =
  "You are an assistant that helps the user manage files. You may " +
  "call the provided tools when they help with the task.";

/** Generate the `:generateContent` REST path suffix for a model name. */
function generateContentUrl(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/$/, "")}/models/${model}:generateContent`;
}

/** A process-wide counter for fallback function-call ids the API omits. */
let fallbackCallId = 0;

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
    error instanceof Error ? error.message : "Gemini request failed.",
  );
}

/**
 * Map the provider-agnostic `ToolInputSchema` into a Gemini function
 * declaration schema for the `tools` array. Since the schema is a plain,
 * subset JSON-Schema, its JSON representation is passed through as-is; the
 * object is wrapped (rather than deeply cloned) so repeated calls stay cheap.
 */
function toGeminiTools(
  tools: readonly ToolDefinition[],
): GeminiToolWire[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "OBJECT",
          properties:
            tool.inputSchema.properties !== undefined
              ? tool.inputSchema.properties
              : undefined,
          required:
            tool.inputSchema.required !== undefined
              ? tool.inputSchema.required
              : undefined,
        },
      })),
    },
  ];
}

/**
 * Convert the request into the `contents` array: the user message first, then
 * (from the second provider turn onward) any prior tool results as structured
 * user context. See the module doc for why results are embedded as text rather
 * than `functionResponse` parts.
 */
function toGeminiContents(request: AgentProviderRequest): GeminiContentWire[] {
  const contents: GeminiContentWire[] = [
    { role: "user", parts: [{ text: request.message }] },
  ];
  if (request.toolResults !== undefined && request.toolResults.length > 0) {
    const lines = request.toolResults.map((result) => {
      const payload = result.ok
        ? JSON.stringify(result.data)
        : JSON.stringify({ error: result.error.message });
      return `- ${result.callId}: ${payload}`;
    });
    contents.push({
      role: "user",
      parts: [
        {
          text:
            "Tool results from the previous rounds " +
            "(callId: data, or {error} on failure):\n" +
            lines.join("\n"),
        },
      ],
    });
  }
  return contents;
}

/**
 * Parse a Gemini `Part` object into provider-independent output. Returns the
 * collected `AgentToolCall` intents and any non-thought text produced by the
 * candidate. Throws a permanent `InvalidResponse` on malformed shapes.
 */
function parseGeminiParts(
  parts: unknown[],
): { text?: string; toolCalls: AgentToolCall[] } {
  const textParts: string[] = [];
  const toolCalls: AgentToolCall[] = [];

  for (const part of parts) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) {
      throw invalidResponse("Each Gemini part must be an object.");
    }
    const entry = part as {
      text?: unknown;
      thought?: unknown;
      functionCall?: unknown;
    };

    if (entry.functionCall !== undefined) {
      const call = entry.functionCall;
      if (
        typeof call !== "object" ||
        call === null ||
        Array.isArray(call)
      ) {
        throw invalidResponse("Gemini functionCall must be an object.");
      }
      const wire = call as {
        id?: unknown;
        name?: unknown;
        args?: unknown;
      };
      if (
        typeof wire.name !== "string" ||
        wire.name.trim().length === 0
      ) {
        throw invalidResponse(
          "Gemini functionCall must include a non-empty name.",
        );
      }
      if (wire.id !== undefined && typeof wire.id !== "string") {
        throw invalidResponse("Gemini functionCall id must be a string.");
      }
      const rawArgs = wire.args === undefined ? {} : wire.args;
      if (
        typeof rawArgs !== "object" ||
        rawArgs === null ||
        Array.isArray(rawArgs)
      ) {
        throw invalidResponse(
          "Gemini functionCall args must be a JSON object.",
        );
      }
      toolCalls.push({
        id:
          wire.id !== undefined && wire.id.length > 0
            ? wire.id
            : `gemini-call-${fallbackCallId++}`,
        toolName: wire.name,
        input: rawArgs as Record<string, unknown>,
      });
      continue;
    }

    if (entry.text !== undefined) {
      if (typeof entry.text !== "string") {
        throw invalidResponse("Gemini text parts must be strings.");
      }
      // Reasoning models attach internal "thought" parts with the same `text`
      // field. They are context for the model, never for the agent — drop them.
      if (entry.thought !== true && entry.text.length > 0) {
        textParts.push(entry.text);
      }
      continue;
    }

    // Unknown part types (media, citations, ...) carry no text or intent we
    // can surface; ignore them rather than rejecting forward-compatible
    // payloads.
  }

  const text =
    textParts.length > 0 ? textParts.join("\n") : undefined;

  if (toolCalls.length > 0) {
    try {
      const validated = validateToolCalls(toolCalls);
      return { text, toolCalls: validated === undefined ? [] : [...validated] };
    } catch (error) {
      throw invalidResponse(
        `Gemini tool calls failed validation: ${
          error instanceof Error ? error.message : "unknown reason"
        }`,
      );
    }
  }
  if (textParts.length === 0) {
    throw invalidResponse(
      "Gemini response produced no usable content (no text and no function call).",
    );
  }
  return { text, toolCalls: [] };
}

// ---------------------------------------------------------------------------
// Provider construction
// ---------------------------------------------------------------------------

/**
 * Create a Gemini (Google AI) `AgentProvider` adapter.
 *
 * @throws `ProviderError.permanent(Authentication)` when no API key is
 *   configured — the adapter cannot reach Gemini without a credential. Fails
 *   fast on construction rather than on the first request.
 */
export function createGeminiProvider(
  options: GeminiProviderOptions,
): AgentProvider {
  const apiKey = options.apiKey;
  const model = options.model;
  const baseUrl =
    options.baseUrl ??
    "https://generativelanguage.googleapis.com/v1beta";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const transport: GeminiFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  if (apiKey.length === 0) {
    throw ProviderError.permanent(
      ProviderErrorCode.Authentication,
      "Gemini API key is not configured.",
    );
  }

  const url = generateContentUrl(baseUrl, model);

  async function generate(
    request: AgentProviderRequest,
  ): Promise<AgentResponse> {
    const payload: GeminiRequestWire = {
      contents: toGeminiContents(request),
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      tools: toGeminiTools(request.tools),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: GeminiFetchResponse;
    try {
      response = await transport(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
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
      throw invalidResponse("Gemini returned a non-JSON response body.");
    }

    return parseGeminiResponse(body);
  }

  return { generate };
}

/**
 * Map a non-OK HTTP status from Gemini into a `ProviderError`.
 */
function mapHttpError(status: number): ProviderError {
  if (status === 401 || status === 403) {
    return ProviderError.permanent(
      ProviderErrorCode.Authentication,
      `Gemini rejected the API key (HTTP ${status}).`,
    );
  }
  if (status === 429) {
    return ProviderError.transient(
      ProviderErrorCode.RateLimited,
      `Gemini rate-limited the request (HTTP ${status}).`,
    );
  }
  if (status === 408) {
    return ProviderError.transient(
      ProviderErrorCode.Timeout,
      `Gemini request timed out on the server (HTTP ${status}).`,
    );
  }
  if (status >= 400 && status < 500) {
    return ProviderError.permanent(
      ProviderErrorCode.InvalidResponse,
      `Gemini rejected the request (HTTP ${status}).`,
    );
  }
  return ProviderError.transient(
    ProviderErrorCode.Unavailable,
    `Gemini request failed with HTTP ${status}.`,
  );
}

/**
 * Parse and validate a raw `GenerateContentResponse` body into an
 * `AgentResponse`. Throws a permanent `InvalidResponse` `ProviderError` on any
 * malformed shape.
 */
function parseGeminiResponse(body: unknown): AgentResponse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalidResponse("Gemini response body must be a JSON object.");
  }
  const response = body as GeminiResponseWire;
  if (!Array.isArray(response.candidates)) {
    throw invalidResponse("Gemini response must include a candidates array.");
  }
  if (response.candidates.length === 0) {
    throw invalidResponse("Gemini response candidates array must not be empty.");
  }

  const first = response.candidates[0];
  if (typeof first !== "object" || first === null) {
    throw invalidResponse("Gemini response candidate must be an object.");
  }
  const candidate = first as GeminiCandidateWire;
  if (typeof candidate.content !== "object" || candidate.content === null) {
    throw invalidResponse("Gemini response candidate must include content.");
  }
  const parts = (candidate.content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    throw invalidResponse("Gemini response candidate must include a parts array.");
  }

  const parsed = parseGeminiParts(parts);
  return parsed.toolCalls.length > 0
    ? { text: parsed.text, toolCalls: parsed.toolCalls }
    : { text: parsed.text };
}