/** @jsxImportSource react */
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactCodeView } from "../artifacts/artifact-code-view";
import { fetchSessionFileContent } from "./session-files-client";
import { sessionFilesClientScope } from "./session-files-panel";

export type SessionFilePreviewProps = {
  client: OpenworkServerClient | null;
  workspaceId: string;
  sessionId?: string;
  path: string;
  rootId: string;
};

const MAX_TEXT_CHARACTERS = 200_000;
const MAX_IMAGE_BASE64_CHARACTERS = 7_000_000;
const SAFE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function SessionFilePreview(props: SessionFilePreviewProps) {
  if (!props.client) return <p role="status" className="p-4 text-sm text-muted-foreground">Connect to this workspace to preview the file.</p>;
  const scope = sessionFilesClientScope(props.client);
  return <SessionFileContent key={JSON.stringify([scope, props.workspaceId, props.sessionId, props.rootId, props.path])} {...props} client={props.client} scope={scope} />;
}

function SessionFileContent({ client, workspaceId, sessionId, path, rootId, scope }: SessionFilePreviewProps & { client: OpenworkServerClient; scope: number }) {
  const query = useQuery({
    queryKey: ["session-file-preview", scope, workspaceId, sessionId ?? null, rootId, path],
    queryFn: ({ signal }) => fetchSessionFileContent({ serverClient: client, workspaceId, sessionId, path, rootId, signal }),
    retry: false, gcTime: 0, staleTime: 0,
  });
  const data = query.data;
  const content = data?.content;
  const text = data?.encoding === "utf8" && typeof content === "string";
  const image = data?.encoding === "base64" && typeof content === "string" && content.length <= MAX_IMAGE_BASE64_CHARACTERS && SAFE_IMAGE_TYPES.has(data.contentType) && /^[A-Za-z0-9+/]*={0,2}$/.test(content);
  const identityMatches = data && data.path === path && data.rootId === rootId;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-testid="session-file-preview">
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={data ? `${data.directory}/${path}` : path}>{path}</span>
      <span className="shrink-0 text-xs text-muted-foreground">Read only</span>
      <Button variant="ghost" size="icon-sm" aria-label="Refresh file" title="Refresh file" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw className={`size-4 ${query.isFetching ? "motion-safe:animate-spin" : ""}`} strokeWidth={1.5} /></Button>
    </div>
    {query.isError ? <div role="alert" className="space-y-2 p-3 text-sm"><p>Could not read this file. Retry, or reopen it from Files if the folder changed.</p>{data ? <p className="text-xs text-muted-foreground">Last checked {new Date(query.dataUpdatedAt).toLocaleTimeString()}</p> : null}<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button></div> : null}
    {!data && query.isPending ? <div role="status" aria-label="Loading file preview" className="space-y-3 p-3"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-6 w-full" /><Skeleton className="h-6 w-3/4" /></div> : null}
    {data && !identityMatches ? <p role="status" className="p-4 text-sm">The file location changed. Reopen the file from Files.</p> : data && text ? <>
      {content.length > MAX_TEXT_CHARACTERS ? <p role="status" className="shrink-0 px-3 py-2 text-xs text-muted-foreground">Preview limited to the first {MAX_TEXT_CHARACTERS.toLocaleString()} characters.</p> : null}
      <div className="min-h-0 flex-1"><ArtifactCodeView key={query.dataUpdatedAt} name={path.split("/").pop() ?? path} path={JSON.stringify([scope, data.rootId, path, query.dataUpdatedAt])} content={content.slice(0, MAX_TEXT_CHARACTERS)} editable={false} /></div>
    </> : data && image ? <div className="min-h-0 flex-1 overflow-auto p-3"><img className="h-auto max-w-full" src={`data:${data.contentType};base64,${content}`} alt={path} /></div> : data ? <p role="status" className="p-4 text-sm text-muted-foreground">Preview unavailable for this file type. Choose a text file or a PNG, JPEG, GIF, or WebP image.</p> : null}
  </div>;
}
