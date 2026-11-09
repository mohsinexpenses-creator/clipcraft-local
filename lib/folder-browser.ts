import fs from "fs";
import os from "os";
import path from "path";
import { AppError, toErrorMessage } from "./errors";

/** A deliberately small, directory-only response for the Settings picker. */
export interface FolderBrowserEntry {
  name: string;
  path: string;
  isSymlink: boolean;
}

export interface FolderBrowserListing {
  path: string;
  parent: string | null;
  entries: FolderBrowserEntry[];
  roots: string[];
}

const MAX_PATH_LENGTH = 1_024;
const MAX_FOLDER_NAME_LENGTH = 120;
const MAX_DIRECTORY_ENTRIES = 500;

function folderError(message: string, details?: string): AppError {
  return new AppError(message, {
    status: 400,
    ...(details ? { details } : {}),
    resolution: "Choose an existing writable folder, or create one from the folder picker.",
  });
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f]/.test(value);
}

/** `~` is convenient in a local picker but never reaches the filesystem verbatim. */
function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Normalize a user-selected directory without requiring it to exist. This is
 * shared by the picker and Settings validation: path traversal is resolved before
 * any filesystem call, control characters are never accepted, and relative paths
 * have one unambiguous meaning (relative to this local app installation).
 */
export function normalizeFolderPath(value: unknown): string {
  if (typeof value !== "string") throw folderError("Folder path must be text.");
  const trimmed = value.trim();
  if (!trimmed) throw folderError("Choose a folder first.");
  if (trimmed.length > MAX_PATH_LENGTH) throw folderError("Folder path is too long.");
  if (hasControlCharacters(trimmed)) throw folderError("Folder path contains control characters.");
  return path.resolve(expandHome(trimmed));
}

function existingDirectory(value: unknown): string {
  const resolved = normalizeFolderPath(value);
  try {
    const real = fs.realpathSync(resolved);
    if (!fs.statSync(real).isDirectory()) throw folderError("That path is not a folder.", real);
    return real;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw folderError("That folder does not exist or cannot be opened.", `${resolved}: ${toErrorMessage(error)}`);
  }
}

/**
 * Validate that an explicit Settings destination can be created and written now.
 * The probe is atomic (`wx`) and removed synchronously, so a saved path cannot
 * fail only after a long upload/render has already started.
 */
export function validateWritableFolder(value: unknown): string {
  const resolved = normalizeFolderPath(value);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    const real = fs.realpathSync(resolved);
    if (!fs.statSync(real).isDirectory()) throw folderError("That path is not a folder.", real);
    const probe = path.join(real, `.clipcraft-write-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const descriptor = fs.openSync(probe, "wx", 0o600);
    fs.closeSync(descriptor);
    fs.rmSync(probe, { force: true });
    return real;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw folderError("That folder cannot be created or written.", `${resolved}: ${toErrorMessage(error)}`);
  }
}

function isDirectoryEntry(parent: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function uniqueRoots(current: string): string[] {
  return [...new Set([
    path.resolve(process.cwd()),
    path.resolve(os.homedir()),
    path.resolve(os.tmpdir()),
    path.parse(current).root,
  ])];
}

/** List only directories; files are never exposed or selectable by this API. */
export function listFolders(value?: string): FolderBrowserListing {
  const current = existingDirectory(value || process.cwd());
  try {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .filter((entry) => isDirectoryEntry(current, entry))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        path: path.join(current, entry.name),
        isSymlink: entry.isSymbolicLink(),
      }));
    const parent = path.dirname(current);
    return {
      path: current,
      parent: parent === current ? null : parent,
      entries,
      roots: uniqueRoots(current),
    };
  } catch (error) {
    throw folderError("Could not read that folder.", `${current}: ${toErrorMessage(error)}`);
  }
}

/** Create one validated child folder; recursive arbitrary paths are intentionally not accepted. */
export function createFolder(parent: unknown, name: unknown): FolderBrowserListing {
  const parentDirectory = existingDirectory(parent);
  if (typeof name !== "string") throw folderError("Folder name must be text.");
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") throw folderError("Enter a folder name.");
  if (trimmed.length > MAX_FOLDER_NAME_LENGTH || hasControlCharacters(trimmed)) {
    throw folderError("Folder name is invalid.");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || path.basename(trimmed) !== trimmed) {
    throw folderError("Folder name cannot contain a path separator.");
  }

  const target = path.join(parentDirectory, trimmed);
  try {
    fs.mkdirSync(target, { recursive: false });
  } catch (error) {
    const exists = (error as NodeJS.ErrnoException).code === "EEXIST";
    if (!exists) {
      throw folderError("Could not create that folder.", `${target}: ${toErrorMessage(error)}`);
    }
    try {
      if (!fs.statSync(target).isDirectory()) throw error;
    } catch {
      throw folderError("A file already uses that folder name.", target);
    }
  }
  return listFolders(target);
}

/** True only for a direct loopback browser request; proxy headers are not trusted. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

/**
 * Folder browsing changes what a local worker can read/write. It is deliberately
 * unavailable through a LAN/Internet deployment, even if that deployment has an
 * authenticated UI: a route cannot safely infer a client IP from spoofable proxy
 * headers, so the direct URL/Host authority and any supplied Origin must both
 * be loopback. (Next dev's 0.0.0.0 bind target is accepted only with a loopback
 * Host header.)
 */
function hostnameFromHostHeader(host: string | null): string | null {
  if (!host?.trim()) return null;
  try {
    return new URL(`http://${host.trim()}`).hostname;
  } catch {
    return null;
  }
}

export function assertLocalFolderBrowserRequest(request: Pick<Request, "url" | "headers">): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new AppError("Folder browsing requires a localhost URL.", { status: 403 });
  }
  const headerHostname = hostnameFromHostHeader(request.headers.get("host"));
  const requestHostname = headerHostname ?? url.hostname;
  const origin = request.headers.get("origin");
  let originIsLoopback = true;
  if (origin) {
    try {
      originIsLoopback = isLoopbackHostname(new URL(origin).hostname);
    } catch {
      originIsLoopback = false;
    }
  }
  // Next dev can report its bind target (0.0.0.0) in Request.url even for a
  // `localhost` browser request. The non-forwarded Host header preserves the
  // browser's direct authority; never use X-Forwarded-Host/IP for this check.
  const urlIsLocalOrDevBind = isLoopbackHostname(url.hostname) || url.hostname === "0.0.0.0";
  if (!urlIsLocalOrDevBind || !isLoopbackHostname(requestHostname) || !originIsLoopback) {
    throw new AppError("Folder browsing is available only from localhost.", {
      status: 403,
      resolution: "Open ClipCraft directly at http://localhost before choosing a local folder.",
    });
  }
}
