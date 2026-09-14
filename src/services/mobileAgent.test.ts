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
});
