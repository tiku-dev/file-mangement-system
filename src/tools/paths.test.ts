/**
 * Tool path-scope guard tests (Phase 10.35).
 *
 * `validateToolPath` is the tool layer's deterministic FIRST gate: relative,
 * control-character, and root-escaping (`..`) paths are rejected as typed
 * `ToolError`s before any executor call. These tests pin the guard's behavior
 * in isolation — `noUncheckedIndexedAccess`-proof, platform-aware, and
 * message-safe (never echoing the raw path).
 */
import { describe, expect, it } from "vitest";
import {
  escapesToolScope,
  hasControlCharacters,
  isAbsoluteToolPath,
  validateToolPath,
} from "./paths.js";
import { ToolErrorCode } from "./errors.js";

describe("validateToolPath", () => {
  it("accepts a POSIX absolute path unchanged (verbatim pass-through)", () => {
    const result = validateToolPath("/Users/alice/Documents");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe("/Users/alice/Documents");
  });

  it("accepts a root path unchanged", () => {
    const result = validateToolPath("/");
    expect(result.ok).toBe(true);
  });

  it("accepts a Windows drive-absolute path", () => {
    const result = validateToolPath("C:\\Users\\alice\\Docs");
    expect(result.ok).toBe(true);
  });

  it("accepts a Windows forward-slash drive path", () => {
    const result = validateToolPath("D:/data");
    expect(result.ok).toBe(true);
  });

  it("accepts a UNC absolute path", () => {
    const result = validateToolPath("\\\\server\\share\\folder");
    expect(result.ok).toBe(true);
  });

  it("accepts an in-root traversal that stays within the scope", () => {
    const result = validateToolPath("/a/../b");
    expect(result.ok).toBe(true);
    expect(escapesToolScope("/a/../b")).toBe(false);
  });

  it("accepts a single dot segment as harmless", () => {
    const result = validateToolPath("/a/./b");
    expect(result.ok).toBe(true);
  });

  it("rejects a relative path as invalid input (validation / tools/invalid-path)", () => {
    for (const path of ["relative", "./x", "../x", "..", "a/b", "User/x"]) {
      const result = validateToolPath(path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("validation");
        expect(result.error.code).toBe(ToolErrorCode.InvalidPath);
        // Public-safe: the raw path must never leak into the message.
        expect(result.error.message).not.toContain(path);
      }
    }
  });

  it("rejects NUL and control characters as invalid input", () => {
    for (const path of ["/a\u0000b", "/a\nb", "/a\tb"]) {
      const result = validateToolPath(path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("validation");
        expect(result.error.code).toBe(ToolErrorCode.InvalidPath);
      }
    }
  });

  it("rejects a path that escapes the root (security / tools/path-out-of-scope)", () => {
    const escapeCases = [
      "/..",
      "/../etc",
      "/a/../../etc/passwd",
      "/a/b/../../../x",
      "/..//../x",
      "C:\\..\\Windows",
      "C:/../Windows",
      "\\\\server\\share\\..\\..",
    ];
    for (const path of escapeCases) {
      const result = validateToolPath(path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.category).toBe("security");
        expect(result.error.code).toBe(ToolErrorCode.PathOutOfScope);
        expect(result.error.message).not.toContain(path);
      }
    }
  });
});

describe("isAbsoluteToolPath", () => {
  it("recognizes POSIX, Windows drive, and UNC roots", () => {
    expect(isAbsoluteToolPath("/etc")).toBe(true);
    expect(isAbsoluteToolPath("C:\\x")).toBe(true);
    expect(isAbsoluteToolPath("C:/x")).toBe(true);
    expect(isAbsoluteToolPath("\\\\srv\\share")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isAbsoluteToolPath("etc")).toBe(false);
    expect(isAbsoluteToolPath("./etc")).toBe(false);
    expect(isAbsoluteToolPath("C:etc")).toBe(false);
    expect(isAbsoluteToolPath("")).toBe(false);
  });
});

describe("escapesToolScope", () => {
  it("returns false for in-root paths and in-root dot-dot navigation", () => {
    expect(escapesToolScope("/a")).toBe(false);
    expect(escapesToolScope("/a/b/../c")).toBe(false);
    expect(escapesToolScope("/a/./b")).toBe(false);
    expect(escapesToolScope("C:\\a\\..\\b")).toBe(false);
  });

  it("returns true for root-escaping traversal", () => {
    expect(escapesToolScope("/..")).toBe(true);
    expect(escapesToolScope("/a/../../etc")).toBe(true);
    expect(escapesToolScope("C:\\..\\Windows")).toBe(true);
  });
});

describe("hasControlCharacters", () => {
  it("returns false for ordinary printable strings", () => {
    expect(hasControlCharacters("/Users/alice/notes.txt")).toBe(false);
    expect(hasControlCharacters("report")).toBe(false);
    expect(hasControlCharacters("")).toBe(false);
  });

  it("returns true for NUL and ASCII control characters", () => {
    expect(hasControlCharacters("/a\u0000b")).toBe(true);
    expect(hasControlCharacters("/a\nb")).toBe(true);
    expect(hasControlCharacters("/a\tb")).toBe(true);
    expect(hasControlCharacters("\u001f")).toBe(true);
  });

  it("ignores characters at or above ASCII space", () => {
    expect(hasControlCharacters("/a b\u007f")).toBe(false);
  });
});