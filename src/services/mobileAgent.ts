/**
 * Mobile planning API.
 *
 * The backend generates a narrowly-scoped plan, while the mobile app performs
 * every filesystem operation through its own OS permission and allow-list
 * layer. The backend never accepts device paths as authority and never opens
 * a phone filesystem.
 */
import { AppError } from "../core/errors.js";
import {
  readToolDefinitions,
} from "../tools/definitions/readTools.js";
import { writeToolDefinitions } from "../tools/definitions/writeTools.js";
import { requiresToolApproval, type ToolDefinition } from "../tools/types.js";
import { ToolError, ToolErrorCode } from "../tools/errors.js";
import type { AgentToolResult } from "./agent.js";
import { composeDefaultProviderStack } from "./providerComposition.js";
import type { AgentProvider } from "./provider.js";
import { isProviderError } from "./provider.js";
import type { AiRuntimeStatus } from "./aiStatus.js";

export const MOBILE_PROTOCOL_VERSION = "1";
export const MAX_MOBILE_INSTRUCTION_LENGTH = 4096;
export const MAX_MOBILE_TOOL_RESULTS = 16;
export const MAX_MOBILE_TOOL_RESULT_BYTES = 65_536;

// Do not offer raw-content reads to the mobile planner. File content may only
// be shared in a separate, explicit feature with its own privacy consent.
const MOBILE_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  ...readToolDefinitions.filter((tool) => tool.name !== "read_file"),
  ...writeToolDefinitions,
]);

const MOBILE_BODY_FIELDS = new Set(["instruction", "toolResults"]);

export interface MobilePlanOperation {
  id: string;
  name: string;
  input: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface MobilePlanResponse {
  protocolVersion: typeof MOBILE_PROTOCOL_VERSION;
  execution: "client-side";
  reply: string | null;
  operations: readonly MobilePlanOperation[];
}

interface MobilePlanInput {
  instruction: string;
  toolResults?: AgentToolResult[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw AppError.badRequest(`${field} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw AppError.badRequest("toolResults must contain JSON-safe values.");
  }
}

function parseToolResults(value: unknown): AgentToolResult[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MOBILE_TOOL_RESULTS) {
    throw AppError.badRequest(`toolResults must be an array with at most ${MAX_MOBILE_TOOL_RESULTS} entries.`);
  }

  return value.map((entry): AgentToolResult => {
    if (!isPlainObject(entry)) throw AppError.badRequest("Each tool result must be a JSON object.");
    const allowed = new Set(["callId", "ok", "data"]);
    if (Object.keys(entry).some((key) => !allowed.has(key))) {
      throw AppError.badRequest("Each tool result accepts only callId, ok, and data.");
    }
    const callId = boundedString(entry.callId, "toolResults.callId", 128);
    if (typeof entry.ok !== "boolean") {
      throw AppError.badRequest("toolResults.ok must be a boolean.");
    }
    if (jsonSize(entry.data) > MAX_MOBILE_TOOL_RESULT_BYTES) {
      throw AppError.badRequest("A tool result is too large. Send metadata or a short summary, not file contents.");
    }
    if (entry.ok) return { ok: true, callId, data: entry.data };
    // The client may report failure, but never gets to inject error text into
    // provider context or API logs.
    return {
      ok: false,
      callId,
      error: new ToolError(
        "internal",
        ToolErrorCode.Internal,
        "The mobile app could not complete this filesystem operation.",
      ),
    };
  });
}

export function parseMobilePlanInput(raw: unknown): MobilePlanInput {
  if (!isPlainObject(raw)) throw AppError.badRequest("Request body must be a JSON object.");
  if (Object.keys(raw).some((key) => !MOBILE_BODY_FIELDS.has(key))) {
    throw AppError.badRequest("Only instruction and toolResults are accepted.");
  }
  return {
    instruction: boundedString(raw.instruction, "instruction", MAX_MOBILE_INSTRUCTION_LENGTH),
    ...(raw.toolResults === undefined ? {} : { toolResults: parseToolResults(raw.toolResults) }),
  };
}

function toOperations(calls: readonly { id: string; toolName: string; input: Record<string, unknown> }[] | undefined): MobilePlanOperation[] {
  if (!calls) return [];
  const tools = new Map(MOBILE_TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  return calls.flatMap((call) => {
    const tool = tools.get(call.toolName);
    if (!tool) return [];
    return [{
      id: call.id,
      name: tool.name,
      input: call.input,
      requiresApproval: requiresToolApproval(tool),
    }];
  });
}

export async function planMobileAgentWithProvider(
  provider: AgentProvider,
  raw: unknown,
): Promise<MobilePlanResponse> {
  const input = parseMobilePlanInput(raw);
  let response;
  try {
    response = await provider.generate({
      message: input.instruction,
      tools: MOBILE_TOOL_DEFINITIONS,
      ...(input.toolResults === undefined ? {} : { toolResults: input.toolResults }),
    });
  } catch (error) {
    if (isProviderError(error)) {
      throw new AppError(503, "ai/provider-unavailable", "The AI provider is temporarily unavailable. Please try again later.");
    }
    throw error;
  }

  return {
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    execution: "client-side",
    reply: response.text ?? null,
    operations: toOperations(response.toolCalls),
  };
}

let defaultProvider: AgentProvider | undefined;

export async function planMobileAgent(raw: unknown): Promise<MobilePlanResponse> {
  try {
    defaultProvider ??= composeDefaultProviderStack().provider;
  } catch {
    throw AppError.notConfigured("The AI provider");
  }
  return planMobileAgentWithProvider(defaultProvider, raw);
}

export function getMobileCapabilities() {
  return {
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    execution: "client-side" as const,
    serverFilesystemAccess: false,
    operations: MOBILE_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      permission: tool.permission,
      requiresApproval: requiresToolApproval(tool),
      inputSchema: tool.inputSchema,
    })),
  };
}

/**
 * Safe, authenticated configuration used to bootstrap the mobile UI.
 *
 * File browsing, search, storage totals, and destructive actions remain
 * client-side because the backend must never access a phone filesystem. This
 * payload tells a frontend which shared capabilities are available and makes
 * that privacy boundary explicit to the UI.
 */
export function getMobileBootstrap(user: {
  id: string;
  email: string;
  displayName: string;
  status: string;
}, ai: AiRuntimeStatus) {
  return {
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    user,
    privacy: {
      mode: "on-device" as const,
      serverFilesystemAccess: false,
      rawFileUpload: false,
      destructiveActionsRequireApproval: true,
    },
    features: {
      home: true,
      browse: true,
      search: true,
      settings: true,
      assistant: true,
      activity: true,
      darkMode: true,
    },
    ai,
    capabilities: getMobileCapabilities(),
  };
}
