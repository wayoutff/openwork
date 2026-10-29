/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CodeView } from "@pierre/diffs/react";
import { ChevronDown, ChevronRight, Columns2, GitBranch, LockKeyhole, RefreshCw, Rows2 } from "lucide-react";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskRecovery } from "@/components/chat/task-recovery";
import { fetchGitChanges, type GitChangesMode } from "./git-changes-client";
import { gitChangesItems } from "./git-changes-renderer";
import { useGitChangesFeature } from "./use-git-changes-feature";

const clientScopes = new WeakMap<OpenworkServerClient, number>();
let nextClientScope = 0;
function clientScope(client: OpenworkServerClient) {
  let scope = clientScopes.get(client);
  if (scope === undefined) { scope = ++nextClientScope; clientScopes.set(client, scope); }
  return scope;
}

const DIFF_CSS = `
  :host {
    --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
    background: var(--background);
  }
`;

type GitChangesPanelProps = { client: OpenworkServerClient | null; workspaceId: string; sessionId?: string };

export function GitChangesPanel(props: GitChangesPanelProps) {
  const enabled = useGitChangesFeature();
  if (!enabled) return <div role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><LockKeyhole className="size-4 shrink-0" />Git changes is disabled in Advanced settings or by your administrator.</div>;
  if (!props.client) return <p role="status" className="p-4 text-sm text-muted-foreground">Connect to this workspace to review changes.</p>;
  // A new connection/auth owner never inherits another owner's patches or controls.
  const scope = clientScope(props.client);
  return <GitChangesContent key={JSON.stringify([scope, props.workspaceId, props.sessionId])} {...props} client={props.client} scope={scope} />;
}

function GitChangesContent({ client, workspaceId, sessionId, scope }: GitChangesPanelProps & { client: OpenworkServerClient; scope: number }) {
  const [mode, setMode] = useState<GitChangesMode>("working");
  const [base, setBase] = useState<string>();
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const query = useQuery({
    queryKey: ["git-changes", scope, workspaceId, sessionId ?? null, mode, mode === "branch" ? base ?? null : null],
    queryFn: ({ signal }) => fetchGitChanges({ serverClient: client, workspaceId, sessionId, mode, base: mode === "branch" ? base : undefined, signal }),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  const data = query.data;
  const prepared = useMemo(() => gitChangesItems(data?.files ?? [], JSON.stringify([scope, workspaceId, sessionId, data?.directory, mode, data?.base, query.dataUpdatedAt])), [data, mode, query.dataUpdatedAt, scope, sessionId, workspaceId]);
  const filesById = new Map(data?.files.map((file) => [file.file, file]));
  // Pierre reconciles controlled items by version, not object identity.
  const items = prepared.items.map((item) => ({ ...item, collapsed: item.collapsed || collapsed.has(item.id), version: query.dataUpdatedAt * 2 + Number(collapsed.has(item.id)) }));
  const branches = Array.from(new Set([...(data?.branches ?? []), ...(data?.base ? [data.base] : []), ...(base ? [base] : [])]));
  const refresh = () => { void query.refetch(); };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-testid="git-changes-panel">
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5 text-xs" data-testid="git-changes-toolbar">
      <div className="flex shrink-0 items-center rounded-full bg-muted/70 pr-2" title={data?.repository ? `${data.files.length} files in ${data.directory}${data.files.some((file) => file.more) ? " (partial diff)" : ""}` : data?.directory}>
        <Select value={mode} onValueChange={(value) => { if (value === "working" || value === "branch") setMode(value); }}>
          <SelectTrigger size="sm" className="h-7! border-0 bg-transparent px-2 py-0 text-xs" aria-label="Compare changes"><SelectValue>{mode === "working" ? "Working tree" : "Branch"}</SelectValue></SelectTrigger>
          <SelectContent align="start"><SelectItem value="working">Working folder</SelectItem><SelectItem value="branch">Branch and working folder</SelectItem></SelectContent>
        </Select>
        {data?.repository && !data.baseRequired ? <span className="flex items-center gap-1.5 whitespace-nowrap font-mono tabular-nums" aria-label={`${data.files.length} files, ${data.additions} additions, ${data.deletions} deletions`}><span className="text-green-11">+{data.additions}</span><span className="text-red-11">-{data.deletions}</span>{data.files.some((file) => file.more) ? <span className="text-muted-foreground" title="Partial diff">*</span> : null}</span> : null}
      </div>
      {mode === "branch" ? <Select value={base ?? data?.base ?? null} onValueChange={(value) => { if (typeof value === "string") setBase(value); }}>
        <SelectTrigger size="sm" className="h-7! min-w-0 max-w-40 border-0 bg-muted/70 px-2 py-0 text-xs" aria-label="Base branch" title={`Base: ${base ?? data?.base ?? "Choose branch"}\nCurrent: ${data?.branch ?? "unknown"}\n${data?.directory ?? ""}`}><SelectValue className="min-w-0 truncate" placeholder="Base branch" /></SelectTrigger>
        <SelectContent align="start">{branches.map((branch) => <SelectItem key={branch} value={branch}>{branch}</SelectItem>)}</SelectContent>
      </Select> : data?.repository ? <span className="flex h-7 min-w-0 max-w-40 items-center gap-1 rounded-full bg-muted/70 px-2 text-muted-foreground" title={`${data.branch ?? "Detached HEAD"}\n${data.directory}`}><GitBranch className="size-3 shrink-0" /><span className="truncate">{data.branch ?? "Detached HEAD"}</span></span> : null}
      <div className="ml-auto flex shrink-0 items-center rounded-full bg-muted/70 p-0.5" role="group" aria-label="Diff actions">
        <Button variant="ghost" size="icon-sm" className="size-6 rounded-full" onClick={refresh} disabled={query.isFetching} aria-label="Refresh Git changes" title="Refresh Git changes"><RefreshCw className={`size-3.5 ${query.isFetching ? "motion-safe:animate-spin" : ""}`} /></Button>
        <span className="mx-0.5 h-3 w-px bg-border" />
        <Button variant={layout === "unified" ? "secondary" : "ghost"} size="icon-sm" className="size-6 rounded-full" aria-label="Unified diff" title="Unified diff" aria-pressed={layout === "unified"} onClick={() => setLayout("unified")}><Rows2 className="size-3.5" /></Button>
        <Button variant={layout === "split" ? "secondary" : "ghost"} size="icon-sm" className="size-6 rounded-full" aria-label="Side-by-side diff" title="Side-by-side diff" aria-pressed={layout === "split"} onClick={() => setLayout("split")}><Columns2 className="size-3.5" /></Button>
      </div>
    </div>
    {query.isError ? <div className="shrink-0 p-3"><TaskRecovery compact title="Could not refresh Git changes. Try again." technicalDetails={query.error instanceof Error ? query.error.message : "Request failed"} actions={<Button variant="outline" size="sm" onClick={refresh}>Retry</Button>} />{data ? <p className="mt-2 text-xs text-muted-foreground">Last checked {new Date(query.dataUpdatedAt).toLocaleTimeString()}</p> : null}</div> : null}
    {!data && query.isPending ? <div className="space-y-4 p-3" role="status" aria-label="Loading Git changes"><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-24 w-full" /></div> : null}
    {data && !data.repository ? <p className="p-4 text-sm text-muted-foreground">No Git repository in this folder. Select a workspace with a repository.</p> : data?.baseRequired ? <p className="p-4 text-sm text-muted-foreground">Choose a base branch to compare changes, or switch to Working folder.</p> : data && data.files.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4"><p className="text-sm text-muted-foreground">No changes</p><Button variant="outline" size="sm" onClick={refresh} disabled={query.isFetching}>Refresh</Button></div> : data ? <CodeView
      key={JSON.stringify([data.directory, mode, data.base])}
      className="min-h-0 flex-1 overflow-auto"
      disableWorkerPool
      items={items}
      options={{ theme: { light: "github-light", dark: "github-dark" }, diffStyle: layout, overflow: "wrap", diffIndicators: "classic", hunkSeparators: "simple", unsafeCSS: DIFF_CSS, itemMetrics: { diffHeaderHeight: 32, lineHeight: 20 }, layout: { paddingTop: 0, paddingBottom: 0, gap: 0 } }}
      renderCustomHeader={(item) => {
        const file = filesById.get(item.id);
        const notice = prepared.notices.get(item.id);
        return <div className="flex h-8 min-w-0 items-center gap-2 border-b border-border bg-background px-2">
            <Button variant="ghost" size="xs" className="min-w-0 flex-1 justify-start gap-1 px-0 font-mono text-xs" disabled={Boolean(notice)} aria-expanded={!item.collapsed} title={`${item.id}\n${file?.status ?? "modified"}`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}>{item.collapsed ? <ChevronRight /> : <ChevronDown />}<span className="truncate">{item.id}</span></Button>
            {notice || file?.more ? <span className="max-w-40 truncate text-[11px] text-muted-foreground" title={notice ?? "Partial diff"}>{notice ?? "Partial"}</span> : null}
            {file?.status !== "modified" ? <span className="text-[10px] text-muted-foreground" title={file?.status}>{file?.status === "added" ? "A" : "D"}</span> : null}
            <span className="shrink-0 font-mono text-xs text-green-11">+{file?.additions ?? 0}</span><span className="shrink-0 font-mono text-xs text-red-11">-{file?.deletions ?? 0}</span>
        </div>;
      }}
    /> : null}
  </div>;
}
