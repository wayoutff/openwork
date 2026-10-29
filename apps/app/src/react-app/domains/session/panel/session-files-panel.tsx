/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, File, FileCode, FileImage, Folder, FolderOpen, RefreshCw, Search } from "lucide-react";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchSessionFiles, type SessionFileEntry } from "./session-files-client";

const clientScopes = new WeakMap<OpenworkServerClient, number>();
let nextClientScope = 0;
export function sessionFilesClientScope(client: OpenworkServerClient) {
  let scope = clientScopes.get(client);
  if (scope === undefined) { scope = ++nextClientScope; clientScopes.set(client, scope); }
  return scope;
}

export type SessionFilesPanelProps = {
  client: OpenworkServerClient | null;
  workspaceId: string;
  sessionId?: string;
  onOpenFile: (path: string, rootId: string, directory: string) => void;
};

type ConnectedProps = SessionFilesPanelProps & { client: OpenworkServerClient; scope: number };

function FilesLoading() {
  return <div role="status" aria-label="Loading files" className="space-y-2 p-3"><Skeleton className="h-8 w-3/4" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-2/3" /></div>;
}

function FileIcon({ path }: { path: string }) {
  const Icon = /\.(png|jpe?g|gif|webp|svg)$/i.test(path) ? FileImage : /\.(tsx?|jsx?|jsonc?|html?|css|py|rs|go|sh|ya?ml|toml|xml)$/i.test(path) ? FileCode : File;
  return <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />;
}

export function SessionFilesPanel(props: SessionFilesPanelProps) {
  if (!props.client) return <p role="status" className="p-4 text-sm text-muted-foreground">Connect to this workspace to browse files.</p>;
  const scope = sessionFilesClientScope(props.client);
  return <SessionFilesContent key={JSON.stringify([scope, props.workspaceId, props.sessionId])} {...props} client={props.client} scope={scope} />;
}

function SessionFilesContent(props: ConnectedProps) {
  const { client, workspaceId, sessionId, scope } = props;
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const key = ["session-files", scope, workspaceId, sessionId ?? null];
  const root = useQuery({
    queryKey: [...key, "root"],
    queryFn: ({ signal }) => fetchSessionFiles({ serverClient: client, workspaceId, sessionId, signal }),
    retry: false, gcTime: 0, staleTime: 0,
  });
  const refresh = () => { void cache.invalidateQueries({ queryKey: key }); };
  const directory = root.data?.directory;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-testid="session-files-panel">
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <FolderOpen className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={directory} aria-label={directory ? `File root: ${directory}` : "File root"}>{directory ?? "Files"}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Refresh files" title="Refresh files" disabled={root.isFetching} onClick={refresh}><RefreshCw className={`size-4 ${root.isFetching ? "motion-safe:animate-spin" : ""}`} strokeWidth={1.5} /></Button>
    </div>
    <div className="flex shrink-0 items-center gap-2 px-3 py-2">
      <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
      <Input type="search" aria-label="Search files" placeholder="Search files" value={search} onChange={(event) => setSearch(event.target.value)} />
    </div>
    {root.isError ? <div role="alert" className="px-3 py-2 text-sm"><p>Could not refresh files. Try again.</p>{root.data ? <p className="text-xs text-muted-foreground">Last checked {new Date(root.dataUpdatedAt).toLocaleTimeString()}</p> : null}<Button variant="outline" size="sm" onClick={refresh}>Retry</Button></div> : null}
    <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
      {!root.data && root.isPending ? <FilesLoading /> : root.data ? <div key={root.data.rootId}>
        {search.trim() !== query ? <FilesLoading /> : query ? <SearchResults {...props} query={query} rootId={root.data.rootId} directory={root.data.directory} /> : <FileEntries {...props} entries={root.data.entries} rootId={root.data.rootId} directory={root.data.directory} depth={0} />}
        {!query && search.trim() === query && root.data.entries.length === 0 ? <p role="status" className="py-4 text-sm text-muted-foreground">This folder is empty. Refresh after adding files.</p> : null}
        {!query && root.data.truncated ? <p role="status" className="py-2 text-xs text-muted-foreground">Some files are not shown. Search to narrow the list.</p> : null}
      </div> : null}
    </div>
  </div>;
}

function SearchResults(props: ConnectedProps & { query: string; rootId: string; directory: string }) {
  const { client, workspaceId, sessionId, scope, query, rootId } = props;
  const result = useQuery({
    queryKey: ["session-files", scope, workspaceId, sessionId ?? null, rootId, "search", query],
    queryFn: ({ signal }) => fetchSessionFiles({ serverClient: client, workspaceId, sessionId, query, signal }),
    retry: false, gcTime: 0,
  });
  if (result.isPending) return <FilesLoading />;
  if (result.isError) return <div role="alert" className="py-3 text-sm">Could not search files. <Button variant="outline" size="sm" onClick={() => void result.refetch()}>Retry search</Button></div>;
  if (result.data.rootId !== rootId) return <p role="status" className="py-3 text-sm">The session folder changed. Refresh files to continue.</p>;
  return <>
    {result.data.entries.length === 0 ? <p role="status" className="py-4 text-sm text-muted-foreground">No matching files. Try another name.</p> : <FileEntries {...props} entries={result.data.entries} depth={0} showPath />}
    {result.data.truncated ? <p role="status" className="py-2 text-xs text-muted-foreground">Search stopped at the limit. Try a more specific name.</p> : null}
  </>;
}

function FileEntries(props: ConnectedProps & { entries: SessionFileEntry[]; rootId: string; directory: string; depth: number; showPath?: boolean }) {
  return <ul aria-label={props.depth === 0 ? "Files" : undefined} className="min-w-0">{props.entries.map((entry) => <li key={entry.path}>
    {entry.kind === "dir" ? <DirectoryEntry {...props} entry={entry} /> : <Button variant="ghost" className="h-10 w-full min-w-0 justify-start gap-2 rounded-md px-2 text-sm hover:bg-muted" title={entry.path} onClick={() => props.onOpenFile(entry.path, props.rootId, props.directory)}><span className="size-4 shrink-0" aria-hidden="true" /><FileIcon path={entry.path} /><span className="min-w-0 truncate">{props.showPath ? entry.path : entry.name}</span></Button>}
  </li>)}</ul>;
}

function DirectoryEntry(props: ConnectedProps & { entry: SessionFileEntry; rootId: string; directory: string; depth: number; showPath?: boolean }) {
  const { client, workspaceId, sessionId, scope, entry, rootId, depth } = props;
  const [open, setOpen] = useState(false);
  const result = useQuery({
    queryKey: ["session-files", scope, workspaceId, sessionId ?? null, rootId, "directory", entry.path],
    queryFn: ({ signal }) => fetchSessionFiles({ serverClient: client, workspaceId, sessionId, path: entry.path, signal }),
    enabled: open && depth < 32, retry: false, gcTime: 0,
  });
  return <Collapsible open={open} onOpenChange={setOpen}>
    <CollapsibleTrigger render={<Button variant="ghost" className="h-10 w-full min-w-0 justify-start gap-2 rounded-md px-2 text-sm hover:bg-muted" title={entry.path} />}>
      <ChevronRight className={`size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} strokeWidth={1.5} aria-hidden="true" />
      <Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" /><span className="min-w-0 truncate">{props.showPath ? entry.path : entry.name}</span>
    </CollapsibleTrigger>
    <CollapsibleContent className="pl-3">
      {open ? depth >= 32 ? <p className="py-2 text-xs text-muted-foreground">Folder depth limit reached. Search for a file by name.</p> : result.isPending ? <FilesLoading /> : result.isError ? <div role="alert" className="py-2 text-sm">Could not open folder. <Button variant="outline" size="sm" onClick={() => void result.refetch()}>Retry folder</Button></div> : result.data?.rootId !== rootId ? <p role="status" className="py-2 text-sm">The session folder changed. Refresh files to continue.</p> : <>
        <FileEntries {...props} entries={result.data.entries} depth={depth + 1} showPath={false} />
        {result.data.entries.length === 0 ? <p className="py-2 text-xs text-muted-foreground">Empty folder</p> : null}
        {result.data.truncated ? <p className="py-2 text-xs text-muted-foreground">Some files are not shown. Search to narrow the list.</p> : null}
      </> : null}
    </CollapsibleContent>
  </Collapsible>;
}
