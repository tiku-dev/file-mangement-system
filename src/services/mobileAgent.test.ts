import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors.js";
import type { AgentProvider } from "./provider.js";
import {
  MOBILE_PROTOCOL_VERSION,
  parseMobilePlanInput,
  planMobileAgentWithProvider,
} from "./mobileAgent.js";

const provider: AgentProvider = {
  async generate(request) {
    expect(request.tools.map((tool) => tool.name)).toEqual([
      "list_directory",
      "search_files",
      "get_file_metadata",
      "move_file",
      "create_file",
      "create_folder",
      "rename_file",
      "delete_file",
      "edit_file",
      "organize_files",
    ]);
    return {
      text: "I found a file that can be organized.",
      toolCalls: [
        {
          id: "move-1",
          toolName: "move_file",
          input: {
            sourcePath: "/storage/emulated/0/Download/report.pdf",
            destinationPath: "/storage/emulated/0/Documents/report.pdf",
          },
        },
      ],
    };
  },
};

describe("mobile agent planning", () => {
  it("returns client-executed operations and marks writes for approval", async () => {
    await expect(planMobileAgentWithProvider(provider, {
      instruction: "Organize my downloaded reports.",
    })).resolves.toEqual({
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      execution: "client-side",
      reply: "I found a file that can be organized.",
      operations: [
        {
          id: "move-1",
          name: "move_file",
          input: {
            sourcePath: "/storage/emulated/0/Download/report.pdf",
            destinationPath: "/storage/emulated/0/Documents/report.pdf",
          },
          requiresApproval: true,
        },
      ],
    });
  });

  it("rejects identity fields and oversized result payloads", () => {
    expect(() => parseMobilePlanInput({ instruction: "List files", userId: "other-user" }))
      .toThrow(AppError);
    expect(() => parseMobilePlanInput({
      instruction: "List files",
      toolResults: [{ callId: "call-1", ok: true, data: "x".repeat(70_000) }],
    })).toThrow(AppError);
  });

  it("handles batch image renaming in natural English using device files context", async () => {
    const failingProvider: AgentProvider = {
      async generate() {
        throw new Error("Provider unavailable");
      },
    };

    const instruction = [
      'Target folder: "/storage/emulated/0/VidMate/download"',
      'Total files: 3',
      'Image files: photo1.jpg, photo2.png, vacation.jpeg',
      'Instruction: I want you to rename all images starting form image_1 till the end',
    ].join("\n");

    const plan = await planMobileAgentWithProvider(failingProvider, { instruction });
    expect(plan.execution).toBe("client-side");
    expect(plan.operations).toHaveLength(3);
    expect(plan.operations[0]!.input).toEqual({
      path: "photo1.jpg",
      newName: "image_1.jpg",
    });
    expect(plan.operations[1]!.input).toEqual({
      path: "photo2.png",
      newName: "image_2.png",
    });
    expect(plan.operations[2]!.input).toEqual({
      path: "vacation.jpeg",
      newName: "image_3.jpeg",
    });
    expect(plan.reply).toContain("rename your 3 images sequentially");
  });
});
