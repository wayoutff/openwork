/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import type { SessionFiles, SessionFileContent, SessionFileEntry } from "../src/react-app/domains/session/panel/session-files-client";

let createRoot: typeof import("react-dom/client")["createRoot"];
let SessionFilesPanel: typeof import("../src/react-app/domains/session/panel/session-files-panel")["SessionFilesPanel"];
let SessionFilePreview: typeof import("../src/react-app/domains/session/panel/session-file-preview")["SessionFilePreview"];
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
let root: Root | undefined;
let host: HTMLDivElement;
let cache: QueryClient;

beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  createRoot = (await import("react-dom/client")).createRoot;
  SessionFilesPanel = (await import("../src/react-app/domains/session/panel/session-files-panel")).SessionFilesPanel;
  SessionFilePreview = (await import("../src/react-app/domains/session/panel/session-file-preview")).SessionFilePreview;
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  cache?.clear();
  host?.remove();
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

function entry(path: string, kind: "file" | "dir" = "file"): SessionFileEntry {
  return { path, name: path.split("/").pop() ?? path, kind, size: 12, updatedAt: 1, hidden: false };
}
function listing(entries: SessionFileEntry[], overrides: Partial<SessionFiles> = {}): SessionFiles {
  return { directory: "/work/session", rootId: "root-1", path: "", entries, truncated: false, ...overrides };
}
function file(overrides: Partial<SessionFileContent> = {}): SessionFileContent {
  return { directory: "/work/session", rootId: "root-1", path: "test.txt", content: "hello", encoding: "utf8", contentType: "text/plain", bytes: 5, updatedAt: 1, ...overrides };
}
function client(overrides: Partial<ReturnType<typeof createOpenworkServerClient>> = {}) {
  return { ...createOpenworkServerClient({ baseUrl: "http://localhost:1" }), ...overrides };
}
async function render(node: ReactNode) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }
  await act(async () => root?.render(<QueryClientProvider client={cache}>{node}</QueryClientProvider>));
  await settle();
}
async function settle(ms = 20) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}
function button(label: string) {
  const found = Array.from(host.querySelectorAll("button")).find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}
async function search(value: string) {
  const input = host.querySelector("input");
  if (!input) throw new Error("Missing search input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("lists actual execution root, lazily expands folders, and opens pinned files", async () => {
  const paths: string[] = [];
  const opened: string[][] = [];
  const api = client({ getSessionFiles: async (_workspace, options) => {
    paths.push(options?.path ?? "");
    return options?.path === "src" ? listing([entry("src/main.ts")], { path: "src" }) : listing([entry("src", "dir"), entry("readme.md")]);
  } });
  await render(<SessionFilesPanel client={api} workspaceId="ws" sessionId="session" onOpenFile={(...args) => opened.push(args)} />);
  expect(paths).toEqual([""]);
  expect(host.textContent).toContain("/work/session");
  expect(button("src").getAttribute("aria-expanded")).toBe("false");
  await click("src");
  expect(paths).toEqual(["", "src"]);
  expect(button("src").getAttribute("aria-expanded")).toBe("true");
  expect(button("main.ts").tagName).toBe("BUTTON");
  await click("main.ts");
  expect(opened).toEqual([["src/main.ts", "root-1", "/work/session"]]);
  await click("src");
  expect(button("src").getAttribute("aria-expanded")).toBe("false");
});

test("debounces filename search, shows paths and truncation, and clears to the tree", async () => {
  const searches: string[] = [];
  const api = client({ getSessionFiles: async (_workspace, options) => {
    if (options?.query) { searches.push(options.query); return listing([entry("src/main.ts")], { truncated: true }); }
    return listing([entry("readme.md")]);
  } });
  await render(<SessionFilesPanel client={api} workspaceId="ws" onOpenFile={() => {}} />);
  await search("ma");
  await search("main");
  expect(searches).toEqual([]);
  await settle(300);
  await settle();
  expect(searches).toEqual(["main"]);
  expect(button("src/main.ts")).toBeDefined();
  expect(host.textContent).toContain("Search stopped at the limit");
  await search("");
  await settle(300);
  expect(button("readme.md")).toBeDefined();
});

test("refreshes expanded folders and resets their contents when the root moves", async () => {
  let moved = false;
  let calls = 0;
  const api = client({ getSessionFiles: async (_workspace, options) => {
    calls++;
    const rootId = moved ? "root-2" : "root-1";
    return listing(options?.path ? [entry("src/old.ts")] : [entry("src", "dir")], { rootId, directory: moved ? "/work/moved" : "/work/session" });
  } });
  await render(<SessionFilesPanel client={api} workspaceId="ws" onOpenFile={() => {}} />);
  await click("src");
  const beforeRefresh = calls;
  await click("Refresh files");
  expect(calls).toBeGreaterThanOrEqual(beforeRefresh + 2);
  moved = true;
  await click("Refresh files");
  expect(host.textContent).toContain("/work/moved");
  expect(host.textContent).not.toContain("old.ts");
  expect(button("src").getAttribute("aria-expanded")).toBe("false");
});

test("does not show another root's directory results", async () => {
  const api = client({ getSessionFiles: async (_workspace, options) => options?.path ? listing([entry("src/wrong.ts")], { rootId: "other-root" }) : listing([entry("src", "dir")]) });
  await render(<SessionFilesPanel client={api} workspaceId="ws" onOpenFile={() => {}} />);
  await click("src");
  expect(host.textContent).toContain("session folder changed");
  expect(host.textContent).not.toContain("wrong.ts");
});

test("reports disconnected, loading, empty and retryable failures without clearing last known files", async () => {
  await render(<SessionFilesPanel client={null} workspaceId="ws" onOpenFile={() => {}} />);
  expect(host.textContent).toContain("Connect to this workspace");
  let resolve: (data: SessionFiles) => void = () => {};
  let fail = false;
  const pending = new Promise<SessionFiles>((done) => { resolve = done; });
  const api = client({ getSessionFiles: async () => { if (fail) throw new Error("offline"); return pending; } });
  await render(<SessionFilesPanel client={api} workspaceId="ws" onOpenFile={() => {}} />);
  expect(host.querySelector('[aria-label="Loading files"]')).not.toBeNull();
  await act(async () => resolve(listing([])));
  await settle();
  expect(host.textContent).toContain("This folder is empty");
  fail = true;
  await click("Refresh files");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not refresh files");
  expect(host.textContent).toContain("Last checked");
  fail = false;
  await click("Retry");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("switching sessions or authentication owners cancels stale requests and isolates results", async () => {
  let firstSignal: AbortSignal | undefined;
  const api = client({ getSessionFiles: async (_workspace, options) => {
    if (options?.sessionId === "old") { firstSignal = options.signal; return new Promise(() => {}); }
    return listing([entry("new.txt")]);
  } });
  await render(<SessionFilesPanel client={api} workspaceId="ws" sessionId="old" onOpenFile={() => {}} />);
  await render(<SessionFilesPanel client={api} workspaceId="ws" sessionId="new" onOpenFile={() => {}} />);
  expect(firstSignal?.aborted).toBe(true);
  expect(button("new.txt")).toBeDefined();
  const other = client({ getSessionFiles: async () => listing([entry("private.txt")]) });
  await render(<SessionFilesPanel client={other} workspaceId="ws" sessionId="new" onOpenFile={() => {}} />);
  expect(host.textContent).not.toContain("new.txt");
  expect(button("private.txt")).toBeDefined();
});

test("preview uses bounded read-only code rather than active HTML", async () => {
  const requests: string[] = [];
  const api = client({ getSessionFileContent: async (_workspace, options) => {
    requests.push(options.rootId ?? "");
    return file({ path: "test.html", contentType: "text/html", content: "<script>window.previewExecuted=true</script>" + "x".repeat(200_001) });
  } });
  await render(<SessionFilePreview client={api} workspaceId="ws" path="test.html" rootId="root-1" />);
  expect(requests).toEqual(["root-1"]);
  expect(host.textContent).toContain("Read only");
  expect(host.textContent).toContain("Preview limited to the first");
  expect(host.querySelector("[data-artifact-code-view]")).not.toBeNull();
  expect(host.querySelector("iframe,script,[contenteditable=true]")).toBeNull();
  expect(Reflect.get(window, "previewExecuted")).toBeUndefined();
});

test("preview only renders bounded allowlisted raster data and rejects mismatched roots", async () => {
  let response = file({ encoding: "base64", contentType: "image/png", content: "aGVsbG8=" });
  const api = client({ getSessionFileContent: async () => response });
  await render(<SessionFilePreview client={api} workspaceId="ws" path="test.txt" rootId="root-1" />);
  expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
  response = file({ encoding: "base64", contentType: "image/svg+xml", content: "aGVsbG8=" });
  await click("Refresh file");
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Preview unavailable");
  response = file({ rootId: "root-2", content: "WRONG ROOT" });
  await click("Refresh file");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not read this file");
  expect(host.textContent).not.toContain("WRONG ROOT");
});
