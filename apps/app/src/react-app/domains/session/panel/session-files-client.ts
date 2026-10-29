import { z } from "zod";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";

const entrySchema = z.object({
  name: z.string(), path: z.string(), kind: z.enum(["file", "dir"]),
  size: z.number().nonnegative(), updatedAt: z.number(), hidden: z.boolean(),
});
const rootSchema = z.object({ directory: z.string().min(1), rootId: z.string().min(1), path: z.string() });
const filesSchema = rootSchema.extend({ entries: z.array(entrySchema), truncated: z.boolean() });
const contentSchema = rootSchema.extend({
  content: z.string().nullable(), encoding: z.enum(["utf8", "base64", "unsupported"]),
  contentType: z.string(), bytes: z.number().nonnegative(), updatedAt: z.number(),
});

export type SessionFileEntry = z.infer<typeof entrySchema>;
export type SessionFiles = z.infer<typeof filesSchema>;
export type SessionFileContent = z.infer<typeof contentSchema>;

export async function fetchSessionFiles(input: {
  serverClient: Pick<OpenworkServerClient, "getSessionFiles">;
  workspaceId: string; sessionId?: string; path?: string; query?: string; signal?: AbortSignal;
}): Promise<SessionFiles> {
  input.signal?.throwIfAborted();
  const data = await input.serverClient.getSessionFiles(input.workspaceId, {
    sessionId: input.sessionId, path: input.path, query: input.query, signal: input.signal,
  }).catch((error: unknown) => {
    input.signal?.throwIfAborted();
    throw error;
  });
  input.signal?.throwIfAborted();
  return filesSchema.parse(data);
}

export async function fetchSessionFileContent(input: {
  serverClient: Pick<OpenworkServerClient, "getSessionFileContent">;
  workspaceId: string; sessionId?: string; path: string; rootId?: string; signal?: AbortSignal;
}): Promise<SessionFileContent> {
  input.signal?.throwIfAborted();
  const data = await input.serverClient.getSessionFileContent(input.workspaceId, {
    sessionId: input.sessionId, path: input.path, rootId: input.rootId, signal: input.signal,
  }).catch((error: unknown) => {
    input.signal?.throwIfAborted();
    throw error;
  });
  input.signal?.throwIfAborted();
  const parsed = contentSchema.parse(data);
  if (input.rootId && parsed.rootId !== input.rootId) throw new Error("The conversation folder changed. Refresh the file browser.");
  if (parsed.path !== input.path) throw new Error("The server returned a different file");
  return parsed;
}
