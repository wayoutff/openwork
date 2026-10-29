import { z } from "zod";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";

const gitFileStatusSchema = z.object({
  file: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  status: z.enum(["added", "deleted", "modified"]),
});
const gitFileSchema = gitFileStatusSchema.extend({ patch: z.string(), more: z.boolean().optional() });
const gitChangesSchema = z.object({
  directory: z.string().min(1),
  repository: z.boolean(),
  branch: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  mode: z.enum(["working", "branch"]),
  base: z.string().nullable(),
  baseRequired: z.boolean(),
  branches: z.array(z.string()),
  files: z.array(gitFileSchema),
  workingStatus: z.array(gitFileStatusSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

export type GitChanges = z.infer<typeof gitChangesSchema>;
export type GitFile = z.infer<typeof gitFileSchema>;
export type GitChangesMode = GitChanges["mode"];

export async function fetchGitChanges(input: {
  serverClient: Pick<OpenworkServerClient, "getGitChanges">;
  workspaceId: string;
  sessionId?: string;
  mode: GitChangesMode;
  base?: string;
  signal?: AbortSignal;
}): Promise<GitChanges> {
  input.signal?.throwIfAborted();
  const data = await input.serverClient.getGitChanges(input.workspaceId, {
    sessionId: input.sessionId, mode: input.mode, base: input.base, signal: input.signal,
  }).catch((error: unknown) => {
    // The shared transport labels fetch aborts as timeouts; preserve cancellation for queries.
    input.signal?.throwIfAborted();
    throw error;
  });
  input.signal?.throwIfAborted();
  return gitChangesSchema.parse(data);
}
