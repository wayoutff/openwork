import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";
import { contentTypeForPath } from "./files.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

const scopeSchema = z.object({
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]+$/).max(200).optional(),
  path: z.string().max(4096).default(""),
});
const browseSchema = scopeSchema.extend({ query: z.string().trim().min(1).max(200).optional() }).strict();
const contentSchema = scopeSchema.extend({ rootId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
const excludedDirectories = new Set([".git", "node_modules"]);
const maxPreviewBytes = 5_000_000;

type Options = {
  routes: Route[];
  resolveWorkspace: (id: string) => Promise<WorkspaceInfo>;
  resolveSessionDirectory: (workspace: WorkspaceInfo, sessionId: string, signal?: AbortSignal) => Promise<string | null>;
};
type Entry = { name: string; path: string; kind: "file" | "dir"; size: number; updatedAt: number; hidden: boolean };

function validatePath(path: string) {
  if (path && (isAbsolute(path) || /[\\\u0000:]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new ApiError(400, "invalid_path", "Expected a relative path without traversal");
  }
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Reject symlinks, including intermediate components, rather than following aliases. */
async function safePath(root: string, path: string, signal: AbortSignal) {
  let candidate = root;
  for (const part of path ? path.split("/") : []) {
    signal.throwIfAborted();
    candidate = join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) throw new ApiError(403, "unsafe_path", "Symbolic links cannot be browsed");
  }
  const canonical = await realpath(candidate);
  if (!inside(root, canonical) || canonical !== candidate) throw new ApiError(403, "unsafe_path", "Path is outside the conversation folder");
  return candidate;
}

function skippable(error: unknown) {
  return error instanceof ApiError && error.code === "unsafe_path"
    || error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM", "ELOOP", "ENOTDIR"].includes(String(error.code));
}

export function registerSessionFileRoutes(options: Options) {
  const handle = async (ctx: RequestContext, content: boolean): Promise<Response> => {
    if (!ctx.actor) throw new ApiError(401, "unauthorized", "Authentication required");
    const parsed = (content ? contentSchema : browseSchema).safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!parsed.success || [...ctx.url.searchParams.keys()].some((key) => ctx.url.searchParams.getAll(key).length !== 1)) {
      throw new ApiError(400, "invalid_files_query", "Invalid file browser query");
    }
    const query = parsed.data;
    validatePath(query.path);
    if (content && !query.path) throw new ApiError(400, "invalid_path", "A file path is required");
    const signal = AbortSignal.any([ctx.request.signal, AbortSignal.timeout(15_000)]);
    signal.throwIfAborted();
    const workspace = await options.resolveWorkspace(ctx.params.id);
    const executionDirectory = query.sessionId
      ? await options.resolveSessionDirectory(workspace, query.sessionId, signal)
      : workspace.path;
    signal.throwIfAborted();
    if (!executionDirectory || !isAbsolute(executionDirectory)) {
      throw new ApiError(404, "session_not_found", "The conversation directory could not be verified for this workspace");
    }
    try {
      const directory = await realpath(executionDirectory);
      const root = await stat(directory);
      if (!root.isDirectory()) throw new ApiError(404, "directory_unavailable", "Conversation folder is unavailable");
      const rootId = createHash("sha256").update(`${directory}\0${root.dev}\0${root.ino}`).digest("hex");
      if ("rootId" in query && query.rootId && query.rootId !== rootId) {
        throw new ApiError(409, "session_directory_changed", "The conversation folder changed. Refresh the file browser.");
      }
      const target = await safePath(directory, query.path, signal);
      const response = (data: unknown) => Response.json(data, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      if (content) {
        // O_NONBLOCK prevents a raced FIFO from blocking; never read special files.
        const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          const checked = await safePath(directory, query.path, signal);
          const current = await lstat(checked);
          if (info.ino !== current.ino || info.dev !== current.dev) throw new ApiError(409, "file_changed", "File changed while opening");
          if (!info.isFile()) throw new ApiError(400, "invalid_path", "Path must name a regular file");
          if (info.size > maxPreviewBytes) throw new ApiError(413, "file_too_large", "Preview is limited to 5 MB");
          const buffer = Buffer.alloc(Math.min(info.size + 1, maxPreviewBytes + 1));
          let bytes = 0;
          while (bytes < buffer.length) {
            signal.throwIfAborted();
            const chunk = await file.read(buffer, bytes, buffer.length - bytes, bytes);
            if (!chunk.bytesRead) break;
            bytes += chunk.bytesRead;
          }
          signal.throwIfAborted();
          if (bytes > info.size) throw new ApiError(409, "file_changed", "File changed while opening");
          const data = buffer.subarray(0, bytes);
          let encoding: "utf8" | "base64" | "unsupported" = "unsupported";
          let text: string | null = null;
          const contentType = contentTypeForPath(query.path);
          if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(contentType)) {
            encoding = "base64";
            text = data.toString("base64");
          } else if (bytes <= 2_000_000 && !data.includes(0)) {
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(data);
              encoding = "utf8";
            } catch { /* Binary files have metadata, not a lossy text preview. */ }
          }
          return response({ directory, rootId, path: query.path, content: text, encoding, contentType, bytes, updatedAt: info.mtimeMs });
        } finally { await file.close(); }
      }

      const search = "query" in query && typeof query.query === "string" ? query.query.toLocaleLowerCase() : null;
      const limit = search ? 200 : 500;
      const entries: Entry[] = [];
      const pending = [{ path: query.path, depth: 0 }];
      const deadline = Date.now() + 5_000;
      let visited = 0;
      let truncated = false;
      while (pending.length) {
        signal.throwIfAborted();
        const next = pending.shift();
        if (!next) break;
        try {
          const dir = await opendir(await safePath(directory, next.path, signal));
          for await (const entry of dir) {
            signal.throwIfAborted();
            if (++visited > 10_000 || Date.now() > deadline || entries.length >= limit) { truncated = true; break; }
            if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
            if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
            const path = next.path ? `${next.path}/${entry.name}` : entry.name;
            try {
              validatePath(path);
              const info = await lstat(await safePath(directory, path, signal));
              if (!info.isDirectory() && !info.isFile()) continue;
              const kind = info.isDirectory() ? "dir" : "file";
              if (!search || path.toLocaleLowerCase().includes(search)) {
                entries.push({ name: entry.name, path, kind, size: kind === "dir" ? 0 : info.size, updatedAt: info.mtimeMs, hidden: path.split("/").some((part) => part.startsWith(".")) });
              }
              if (search && kind === "dir") {
                if (next.depth < 20) pending.push({ path, depth: next.depth + 1 });
                else truncated = true;
              }
            } catch (error) {
              if (!skippable(error) && !(error instanceof ApiError && error.code === "invalid_path")) throw error;
              truncated = true;
            }
          }
        } catch (error) {
          if (next.path === query.path || !skippable(error)) throw error;
          truncated = true;
        }
        if (entries.length >= limit || visited > 10_000 || Date.now() > deadline) { truncated = true; break; }
      }
      signal.throwIfAborted();
      entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) || a.path.localeCompare(b.path));
      return response({ directory, rootId, path: query.path, entries, truncated });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && "code" in error) {
        if (["ENOENT", "ENOTDIR"].includes(String(error.code))) throw new ApiError(404, "file_not_found", "File or folder no longer exists");
        if (["EACCES", "EPERM", "ELOOP"].includes(String(error.code))) throw new ApiError(403, "file_permission_denied", "File or folder cannot be read");
      }
      throw error;
    }
  };
  addRoute(options.routes, "GET", "/workspace/:id/files/browser", "client", (ctx) => handle(ctx, false));
  addRoute(options.routes, "GET", "/workspace/:id/files/browser/content", "client", (ctx) => handle(ctx, true));
}
