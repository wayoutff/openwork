import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { loopbackFetch } from "../server-fetch.js";
import type { WorkspaceInfo } from "../types.js";
import { addRoute, type Route } from "./registry.js";

const querySchema = z.object({
  sessionId: z.string().regex(/^ses_[A-Za-z0-9_-]+$/).max(200).optional(),
  mode: z.enum(["working", "branch"]).default("working"),
  base: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/)
    .refine((value) => !value.includes("..") && !value.includes("//") && !value.endsWith("/")).optional(),
}).strict();
const fileStatusSchema = z.object({
  file: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  status: z.enum(["added", "deleted", "modified"]),
});
const fileDiffSchema = fileStatusSchema.extend({ patch: z.string(), more: z.boolean().optional() });
const infoSchema = z.object({
  provider: z.string().optional(),
  branch: z.object({ current: z.string().optional(), default: z.string().optional() }),
});
const baseSchema = z.object({ name: z.string(), ref: z.string(), source: z.enum(["reflog", "default"]) }).nullable();

type GitChangesOptions = {
  routes: Route[];
  resolveWorkspace: (id: string) => Promise<WorkspaceInfo>;
  resolveSessionDirectory: (workspace: WorkspaceInfo, sessionId: string) => Promise<string | null>;
  connection: () => { url: string; username: string; password: string } | null;
};

/** Only server-owned workspace/session locations can reach the native read APIs. */
export function registerGitChangesRoutes(options: GitChangesOptions) {
  addRoute(options.routes, "GET", "/workspace/:id/git/changes", "client", async (ctx) => {
    if (!ctx.actor) throw new ApiError(401, "unauthorized", "Authentication required");
    const parsed = querySchema.safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!parsed.success || [...ctx.url.searchParams.keys()].some((key) => ctx.url.searchParams.getAll(key).length !== 1)) {
      throw new ApiError(400, "invalid_git_query", "Expected only sessionId, mode and a Git base ref");
    }
    const query = parsed.data;
    const workspace = await options.resolveWorkspace(ctx.params.id);
    const connection = options.connection();
    if (!connection) throw new ApiError(503, "git_engine_unavailable", "The V2 engine is unavailable");
    ctx.request.signal.throwIfAborted();
    const executionDirectory = query.sessionId
      ? await options.resolveSessionDirectory(workspace, query.sessionId)
      : workspace.path;
    if (!executionDirectory || !isAbsolute(executionDirectory)) {
      throw new ApiError(404, "session_not_found", "The conversation directory could not be verified for this workspace");
    }
    const directory = await realpath(executionDirectory).catch(() => {
      throw new ApiError(404, "git_directory_unavailable", "The working directory is unavailable");
    });
    const signal = AbortSignal.any([ctx.request.signal, AbortSignal.timeout(30_000)]);
    const readNative = async <T>(path: string, schema: z.ZodType<T>, params?: Record<string, string>): Promise<T> => {
      signal.throwIfAborted();
      const url = new URL(path, connection.url);
      url.searchParams.set("location[directory]", directory);
      for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
      const response = await loopbackFetch(url, {
        method: "GET",
        headers: { authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` },
        signal,
      });
      if (!response.ok) {
        const error = z.object({ message: z.string() }).safeParse(await response.json().catch(() => null));
        throw new ApiError(response.status >= 500 ? 503 : 502, "git_unavailable",
          error.success ? error.data.message : "Git data could not be read");
      }
      const result = z.object({ location: z.object({ directory: z.string() }), data: schema }).safeParse(await response.json());
      if (!result.success) throw new ApiError(502, "invalid_git_response", "The engine returned invalid Git data");
      if (resolve(result.data.location.directory) !== directory) {
        throw new ApiError(502, "git_directory_mismatch", "The engine returned a different working directory");
      }
      return result.data.data;
    };
    let info = await readNative("/api/vcs", infoSchema);
    if (!info.provider) {
      // V2.2 VCS reads do not await plugin activation and can initially return
      // { branch: {} } for a Git repo. Agent listing joins the engine's bounded
      // awaitPlugins barrier without executing an agent or changing the repo.
      await readNative("/api/agent", z.array(z.unknown()));
      info = await readNative("/api/vcs", infoSchema);
    }
    const branches: string[] = [];
    const files: z.infer<typeof fileDiffSchema>[] = [];
    const workingStatus: z.infer<typeof fileStatusSchema>[] = [];
    const result = {
      directory,
      repository: info.provider === "git",
      branch: info.branch.current ?? null,
      defaultBranch: info.branch.default ?? null,
      mode: query.mode,
      base: query.base ?? null,
      baseRequired: false,
      branches,
      files,
      workingStatus,
      additions: 0,
      deletions: 0,
    };
    if (result.repository) {
      const [branches, status, inferredBase] = await Promise.all([
        readNative("/api/vcs/branch", z.array(z.string()), { limit: "100" }),
        readNative("/api/vcs/status", z.array(fileStatusSchema)),
        query.base ? Promise.resolve(null) : readNative("/api/vcs/base", baseSchema).catch((error: unknown) => {
          // Ambiguous review history must not hide the working copy or guess main.
          if (error instanceof ApiError && error.code === "git_unavailable" && error.status === 503) return null;
          throw error;
        }),
      ]);
      result.branches = branches;
      result.workingStatus = status;
      result.base = query.base ?? inferredBase?.ref ?? null;
      result.baseRequired = query.mode === "branch" && !result.base;
      if (!result.baseRequired) {
        result.files = await readNative("/api/vcs/diff", z.array(fileDiffSchema), {
          mode: query.mode, context: "3", untracked: "files",
          ...(query.mode === "branch" && result.base ? { base: result.base } : {}),
        });
        for (const file of result.files) {
          result.additions += file.additions;
          result.deletions += file.deletions;
        }
      }
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  });
}
