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
import { requiresToolApproval, ToolPermission, type ToolDefinition } from "../tools/types.js";
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

const createFileDefinition: ToolDefinition = {
  name: "create_file",
  description: "Create a new file at the specified path with optional text content. Requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the file to create." },
      content: { type: "string", description: "Initial text content of the file." },
    },
    required: ["path"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

const createFolderDefinition: ToolDefinition = {
  name: "create_folder",
  description: "Create a new folder / directory at the specified path. Requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the directory to create." },
    },
    required: ["path"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

const renameFileDefinition: ToolDefinition = {
  name: "rename_file",
  description: "Rename an existing file or folder to a new name. Requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the item to rename." },
      newName: { type: "string", description: "New name for the file or folder." },
    },
    required: ["path", "newName"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

const deleteFileDefinition: ToolDefinition = {
  name: "delete_file",
  description: "Delete an existing file or folder. Destructive operation that requires user confirmation.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the file or folder to delete." },
    },
    required: ["path"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

const editFileDefinition: ToolDefinition = {
  name: "edit_file",
  description: "Update the text content of an existing file. Requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the file to update." },
      content: { type: "string", description: "New content for the file." },
    },
    required: ["path", "content"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

const organizeFilesDefinition: ToolDefinition = {
  name: "organize_files",
  description: "Batch organize files in a folder into category subfolders (e.g. Documents, Photos, Audio, APKs). Requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      sourceDirectory: { type: "string", description: "Absolute path of the folder to organize." },
      strategy: { type: "string", description: "Strategy: 'by_type', 'by_date', or 'clean_duplicates'." },
    },
    required: ["sourceDirectory"],
  },
  permission: ToolPermission.Write,
  requiresApproval: true,
};

// Do not offer raw-content reads to the mobile planner. File content may only
// be shared in a separate, explicit feature with its own privacy consent.
const MOBILE_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  ...readToolDefinitions.filter((tool) => tool.name !== "read_file"),
  ...writeToolDefinitions,
  createFileDefinition,
  createFolderDefinition,
  renameFileDefinition,
  deleteFileDefinition,
  editFileDefinition,
  organizeFilesDefinition,
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

export function fallbackMobilePlanner(instruction: string): MobilePlanResponse {
  // 1. Parse structured context injected by the mobile client if present
  const folderMatch = instruction.match(/Target folder:\s*"([^"]+)"/i);
  const targetFolder = folderMatch && folderMatch[1] ? folderMatch[1].trim() : ".";

  const totalFilesMatch = instruction.match(/Total files:\s*(\d+)/i);
  const totalFilesCount = totalFilesMatch && totalFilesMatch[1] ? parseInt(totalFilesMatch[1], 10) : 0;

  const imageFilesMatch = instruction.match(/Image files:\s*([^\n]+)/i);
  const imageFiles =
    imageFilesMatch && imageFilesMatch[1]
      ? imageFilesMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  const docFilesMatch = instruction.match(/Doc files:\s*([^\n]+)/i);
  const docFiles =
    docFilesMatch && docFilesMatch[1]
      ? docFilesMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  const sampleFilesMatch = instruction.match(/Sample files:\s*([^\n]+)/i);
  const sampleFiles =
    sampleFilesMatch && sampleFilesMatch[1]
      ? sampleFilesMatch[1]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];

  const instructionMatch = instruction.match(/Instruction:\s*([\s\S]+)$/i);
  const userPrompt =
    instructionMatch && instructionMatch[1]
      ? instructionMatch[1].trim()
      : instruction.trim();
  const lower = userPrompt.toLowerCase();

  // 2. Batch Renaming (e.g. "I want you to rename all images starting form image_1 till the end")
  const batchRenameMatch = userPrompt.match(
    /rename\s+(?:all\s+)?(images?|photos?|pics?|files?|videos?|docs?|documents?)(?:\s+(?:starting\s+)?(?:from|form|to|as|like)\s+([a-zA-Z]+)(?:_(\d+)|\s+(\d+))?)/i,
  );

  if (batchRenameMatch && batchRenameMatch[1]) {
    const targetType = batchRenameMatch[1].toLowerCase();
    const basePrefix = batchRenameMatch[2] || "image";
    let startIndex = 1;
    if (batchRenameMatch[3]) {
      startIndex = parseInt(batchRenameMatch[3], 10) || 1;
    } else if (batchRenameMatch[4]) {
      startIndex = parseInt(batchRenameMatch[4], 10) || 1;
    }

    // Determine target files to rename
    let filesToRename: string[] = [];
    if (targetType.startsWith("image") || targetType.startsWith("photo") || targetType.startsWith("pic")) {
      filesToRename = [...imageFiles];
      if (filesToRename.length === 0) {
        filesToRename = sampleFiles.filter((f) =>
          /\.(jpe?g|png|webp|gif|bmp|heic)$/i.test(f),
        );
      }
    } else if (targetType.startsWith("doc")) {
      filesToRename = [...docFiles];
      if (filesToRename.length === 0) {
        filesToRename = sampleFiles.filter((f) =>
          /\.(pdf|docx?|txt|md|xlsx?|pptx?)$/i.test(f),
        );
      }
    } else {
      filesToRename = [...sampleFiles];
    }

    // If still empty but user requested image renaming, provide sample names so the plan is tangible
    if (filesToRename.length === 0) {
      filesToRename = ["image.jpg", "photo.png", "camera_01.jpg"];
    }

    const operations: MobilePlanOperation[] = [];
    let currentIndex = startIndex;
    for (const originalName of filesToRename) {
      const extMatch = originalName.match(/\.([a-zA-Z0-9]+)$/);
      const ext = extMatch && extMatch[1] ? `.${extMatch[1]}` : "";
      const newName = `${basePrefix}_${currentIndex}${ext}`;
      operations.push({
        id: `op-${Date.now()}-${currentIndex}`,
        name: "rename_file",
        input: {
          path: originalName,
          newName,
        },
        requiresApproval: true,
      });
      currentIndex++;
    }

    const previewList = operations
      .slice(0, 4)
      .map((op) => `• ${String(op.input["path"])} ➔ ${String(op.input["newName"])}`)
      .join("\n");

    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: `I've prepared a plan to rename your ${operations.length} ${targetType} sequentially starting from ${basePrefix}_${startIndex}:\n${previewList}${operations.length > 4 ? `\n...and ${operations.length - 4} more files` : ""}\n\nPlease review and tap Confirm to execute on your device.`,
      operations,
    };
  }

  // 3. Single file rename (e.g. "rename report.pdf to annual_report.pdf" or "change name of X to Y")
  const singleRenameMatch =
    userPrompt.match(/rename\s+(?:file\s+)?["']?([^"'\s]+)["']?\s+(?:to|as)\s+["']?([^"'\s]+)["']?/i) ||
    userPrompt.match(/change\s+(?:the\s+)?name\s+of\s+["']?([^"'\s]+)["']?\s+to\s+["']?([^"'\s]+)["']?/i);
  if (singleRenameMatch && singleRenameMatch[1] && singleRenameMatch[2]) {
    const src = singleRenameMatch[1].trim();
    const dst = singleRenameMatch[2].trim();
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: `I've prepared a plan to rename "${src}" to "${dst}". Tap Confirm below to proceed.`,
      operations: [
        {
          id: `op-${Date.now()}-1`,
          name: "rename_file",
          input: {
            path: src,
            newName: dst,
          },
          requiresApproval: true,
        },
      ],
    };
  }

  // 4. Duplicate cleanup
  if (
    lower.includes("duplicate") ||
    lower.includes("double file") ||
    lower.includes("redundant") ||
    (lower.includes("clean") && lower.includes("space")) ||
    lower.includes("cleanup")
  ) {
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply:
        "I've prepared a cleanup plan to scan and safely remove duplicate files in your authorized folder. Tap Confirm below to proceed.",
      operations: [
        {
          id: `op-${Date.now()}-1`,
          name: "organize_files",
          input: {
            sourceDirectory: ".",
            strategy: "clean_duplicates",
          },
          requiresApproval: true,
        },
      ],
    };
  }

  // 5. Create folder
  const createFolderMatch = userPrompt.match(
    /(?:create|make|add|new)\s+(?:a\s+)?folder\s+(?:named|called\s+)?["']?([^"'\n]+)["']?/i,
  );
  if (createFolderMatch && createFolderMatch[1]) {
    const folderName = createFolderMatch[1].trim();
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: `I've prepared a plan to create the folder "${folderName}" in your authorized folder.`,
      operations: [
        {
          id: `op-${Date.now()}-1`,
          name: "create_folder",
          input: {
            path: folderName,
          },
          requiresApproval: true,
        },
      ],
    };
  }

  // 6. Create file
  const createFileMatch = userPrompt.match(
    /(?:create|make|add|new)\s+(?:a\s+)?file\s+(?:named|called\s+)?["']?([^"'\n]+)["']?(?:\s+with\s+(?:content|text)\s+["']?([^"']+)["']?)?/i,
  );
  if (createFileMatch && createFileMatch[1]) {
    const fileName = createFileMatch[1].trim();
    const content = createFileMatch[2] ? createFileMatch[2].trim() : "";
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: `I've prepared a plan to create the file "${fileName}".`,
      operations: [
        {
          id: `op-${Date.now()}-1`,
          name: "create_file",
          input: {
            path: fileName,
            content,
          },
          requiresApproval: true,
        },
      ],
    };
  }

  // 7. Delete file / item
  const deleteMatch = userPrompt.match(
    /(?:delete|remove|erase)\s+(?:the\s+)?(?:file\s+|folder\s+)?["']?([^"'\n]+)["']?/i,
  );
  if (deleteMatch && deleteMatch[1] && !lower.includes("duplicate")) {
    const targetItem = deleteMatch[1].trim();
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: `I've prepared a plan to delete "${targetItem}". This is a destructive operation and requires your confirmation below.`,
      operations: [
        {
          id: `op-${Date.now()}-1`,
          name: "delete_file",
          input: {
            path: targetItem,
          },
          requiresApproval: true,
        },
      ],
    };
  }

  // 8. Organize / Sort / Categorize by type
  if (
    lower.includes("organize") ||
    lower.includes("sort") ||
    lower.includes("categorize") ||
    lower.includes("arrange") ||
    lower.includes("group") ||
    lower.includes("tidy")
  ) {
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply:
        "I will organize your files into category subfolders (Documents, Photos, Videos, Audio, APKs). Tap Confirm below to review and execute this on your device:",
      operations: [
        {
          id: `op-${Date.now()}-1`,
          name: "organize_files",
          input: {
            sourceDirectory: ".",
            strategy: "by_type",
          },
          requiresApproval: true,
        },
      ],
    };
  }

  // 9. Move files
  if (lower.includes("move")) {
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply:
        "I've prepared a file organization plan based on your instruction. Tap Confirm to execute the move on your device.",
      operations: [
        {
          id: `op-${Date.now()}-1`,
          name: "organize_files",
          input: {
            sourceDirectory: ".",
            strategy: "by_type",
          },
          requiresApproval: true,
        },
      ],
    };
  }

  // 10. File & Storage inquiries
  if (
    lower.includes("what file") ||
    lower.includes("list file") ||
    lower.includes("show file") ||
    lower.includes("see file") ||
    lower.includes("how many file") ||
    lower.includes("what is in") ||
    lower.includes("check my folder") ||
    lower.includes("storage status")
  ) {
    const countDesc = totalFilesCount > 0 ? `${totalFilesCount} files` : "your files";
    const sampleDesc = sampleFiles.length > 0 ? ` Some files include: ${sampleFiles.slice(0, 6).join(", ")}.` : "";
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: `Your connected folder is "${targetFolder}" with ${countDesc}.${sampleDesc}\n\nWould you like me to organize them by category, clean up duplicates, or rename any files?`,
      operations: [],
    };
  }

  // 11. Greetings & Pleasantries
  if (
    lower === "hey" ||
    lower === "hello" ||
    lower === "hi" ||
    lower === "heyy" ||
    lower.startsWith("hey ") ||
    lower.startsWith("hello ") ||
    lower.startsWith("hi ") ||
    lower.startsWith("good morning") ||
    lower.startsWith("good afternoon") ||
    lower.startsWith("good evening") ||
    lower.includes("how are you") ||
    lower.includes("what's up") ||
    lower.includes("howdy")
  ) {
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: `Hello! I am FileMind AI. I'm connected to your device folder: "${targetFolder}". I can help you organize files, clean duplicate files, rename images or documents, and create folders. What would you like to do?`,
      operations: [],
    };
  }

  // 12. Identity & capabilities
  if (
    lower.includes("who are you") ||
    lower.includes("what can you do") ||
    lower.includes("help") ||
    lower.includes("features") ||
    lower.includes("how does this work")
  ) {
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: `I am FileMind AI, your on-device file management assistant! Here are some things I can do for you:\n• "Rename all images starting from image_1"\n• "Organize files by category"\n• "Clean up duplicate files"\n• "Create folder [name]"\n• "What files do I have?"\n\nAll actions run locally on your phone and require your explicit confirmation before applying.`,
      operations: [],
    };
  }

  // 13. Gratitude & Politeness
  if (
    lower.includes("thank") ||
    lower.includes("thanks") ||
    lower.includes("awesome") ||
    lower.includes("good job") ||
    lower.includes("great") ||
    lower.includes("perfect")
  ) {
    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply:
        "You're very welcome! Let me know whenever you need help organizing, renaming, or managing your files.",
      operations: [],
    };
  }

  // 14. Conversational natural English fallback (never 503, never rigid rejection)
  return {
    protocolVersion: MOBILE_PROTOCOL_VERSION,
    execution: "client-side",
    reply: `I understand you'd like to: "${userPrompt}".\n\nI am connected to your folder "${targetFolder}". You can ask me to:\n• "Rename all images starting from image_1 till the end"\n• "Organize my files by category"\n• "Clean up duplicate files"\n• "Create folder [name]"\n\nHow would you like to proceed?`,
    operations: [],
  };
}

export async function planMobileAgentWithProvider(
  provider: AgentProvider,
  raw: unknown,
): Promise<MobilePlanResponse> {
  const input = parseMobilePlanInput(raw);
  try {
    const response = await provider.generate({
      message: input.instruction,
      tools: MOBILE_TOOL_DEFINITIONS,
      ...(input.toolResults === undefined ? {} : { toolResults: input.toolResults }),
    });

    return {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: response.text ?? null,
      operations: toOperations(response.toolCalls),
    };
  } catch {
    // Seamlessly fall back to local rule-based planner if upstream provider fails
    return fallbackMobilePlanner(input.instruction);
  }
}

let defaultProvider: AgentProvider | undefined;

export async function planMobileAgent(raw: unknown): Promise<MobilePlanResponse> {
  const input = parseMobilePlanInput(raw);
  try {
    defaultProvider ??= composeDefaultProviderStack().provider;
    return await planMobileAgentWithProvider(defaultProvider, raw);
  } catch {
    // If provider composition or credentials are not configured, use local intelligent planner
    return fallbackMobilePlanner(input.instruction);
  }
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
