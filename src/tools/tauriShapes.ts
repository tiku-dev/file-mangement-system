/**
 * Tauri IPC shape types (Phase 9.3).
 *
 * Mirrors the camelCase JSON contracts the Rust `fs_service` returns over
 * the Tauri command boundary. The shapes are the SAME ones the web app
 * receives through `DesktopFilesystemProvider` — the bridge in this
 * module is intentionally shape-compatible so a single Rust surface
 * serves both consumers.
 *
 * Anything we read from Rust is considered untrusted until we trust it:
 * the bridge delegates to the Rust AllowList, but the shapes themselves
 * are still untrusted at the boundary. The fields here are the minimum
 * needed by the tool layer; tools do not invent additional fields.
 */

/** A single entry in a directory listing. */
export interface FileEntry {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  sizeBytes: number;
  /** Number of children (directories only). May be null per Rust shape. */
  itemCount: number | null;
  fileType: string;
  size: string;
  created: string;
  modified: string;
  modifiedTs: number;
  createdTs: number;
}

/** Result of listing a directory. */
export interface DirectoryListing {
  path: string;
  parentPath: string | null;
  isHome: boolean;
  items: FileEntry[];
}

/** Metadata for a single file or directory (contents never read). */
export interface FileMetadata {
  name: string;
  path: string;
  isFile: boolean;
  isFolder: boolean;
  sizeBytes: number;
  extension: string | null;
  isHidden: boolean;
  modified: string;
  modifiedTs: number;
  created: string;
  createdTs: number;
  accessed: string | null;
  accessedTs: number | null;
}

