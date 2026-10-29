import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { registerSessionFileRoutes } from "../src/routes/session-files.js";
import { matchRoute, type RequestContext, type Route } from "../src/routes/registry.js";
import type { WorkspaceInfo } from "../src/types.js";

async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "session-files-")));
  const workspacePath = join(temp, "workspace");
  const executionPath = join(temp, "execution");
  await mkdir(workspacePath);
  await mkdir(executionPath);
  const workspace: WorkspaceInfo = { id: "ws1", name: "Chat", path: workspacePath, preset: "starter", workspaceType: "local" };
  const routes: Route[] = [];
  let currentDirectory: string | null = executionPath;
  registerSessionFileRoutes({
    routes,
    resolveWorkspace: async (id) => {
      if (id !== workspace.id) throw new ApiError(404, "workspace_not_found", "Workspace not found");
      return workspace;
    },
    resolveSessionDirectory: async (_, id, signal) => {
      signal?.throwIfAborted();
      return id === "ses_owned" ? currentDirectory : null;
    },
  });
  return {
    temp, workspacePath, executionPath, routes,
    move: (directory: string | null) => { currentDirectory = directory; },
    close: () => rm(temp, { recursive: true, force: true }),
    read: async (params: Record<string, string> = {}, options: { content?: boolean; actor?: boolean; signal?: AbortSignal; workspace?: string; rawQuery?: string } = {}) => {
      const url = new URL(`http://localhost/workspace/${options.workspace ?? "ws1"}/files/browser${options.content ? "/content" : ""}`);
      url.search = options.rawQuery ?? new URLSearchParams(params).toString();
      const request = new Request(url, { signal: options.signal });
      const route = matchRoute(routes, "GET", url.pathname);
      assert.ok(route);
      const ctx = { request, url, params: route.params, actor: options.actor === false ? undefined : { scope: "viewer" } } as RequestContext;
      return route.handler(ctx);
    },
  };
}

test("session listing is nested, metadata-only and rooted at the real execution folder", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.executionPath, "nested"));
    await writeFile(join(f.executionPath, "nested", "example.txt"), "execution");
    await writeFile(join(f.executionPath, ".env"), "PRIVATE=fixture");
    await writeFile(join(f.workspacePath, "workspace-only.txt"), "workspace");
    const response = await f.read({ sessionId: "ses_owned" });
    const result = await response.json();
    assert.equal(result.directory, f.executionPath);
    assert.match(result.rootId, /^[a-f0-9]{64}$/);
    assert.deepEqual(result.entries.map((entry: { path: string }) => entry.path), ["nested", ".env"]);
    assert.equal(result.entries[1].hidden, true);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    assert.equal(response.headers.get("cache-control"), "no-store");
    const nested = await (await f.read({ sessionId: "ses_owned", path: "nested" })).json();
    assert.equal(nested.entries[0].path, "nested/example.txt");
    const workspace = await (await f.read()).json();
    assert.equal(workspace.entries[0].path, "workspace-only.txt");
  } finally { await f.close(); }
});

test("recursive search matches filenames, not content, and excludes heavy directories", async () => {
  const f = await fixture();
  try {
    for (const path of ["nested/deeper", ".git", "node_modules"]) await mkdir(join(f.executionPath, path), { recursive: true });
    for (const path of ["nested/deeper/Needle.txt", ".git/needle", "node_modules/needle"]) await writeFile(join(f.executionPath, path), "fixture");
    await writeFile(join(f.executionPath, "content.txt"), "needle");
    const data = await (await f.read({ sessionId: "ses_owned", query: "NEEDLE" })).json();
    assert.deepEqual(data.entries.map((entry: { path: string }) => entry.path), ["nested/deeper/Needle.txt"]);
    assert.equal(data.truncated, false);
  } finally { await f.close(); }
});

test("preview reads execution copy only and requires explicit open for hidden contents", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspacePath, "same.txt"), "wrong workspace copy");
    await writeFile(join(f.executionPath, "same.txt"), "execution copy");
    await writeFile(join(f.executionPath, ".env"), "PRIVATE=fixture");
    const root = await (await f.read({ sessionId: "ses_owned" })).json();
    const data = await (await f.read({ sessionId: "ses_owned", path: "same.txt", rootId: root.rootId }, { content: true })).json();
    assert.equal(data.content, "execution copy");
    assert.equal(data.encoding, "utf8");
    const hidden = await (await f.read({ sessionId: "ses_owned", path: ".env" }, { content: true })).json();
    assert.equal(hidden.content, "PRIVATE=fixture");
    f.move(f.workspacePath);
    await assert.rejects(f.read({ sessionId: "ses_owned", path: "same.txt", rootId: root.rootId }, { content: true }), (error: unknown) => error instanceof ApiError && error.status === 409);
  } finally { await f.close(); }
});

test("unauthenticated and foreign sessions fail closed; only GET routes exist", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.read({}, { actor: false }), (error: unknown) => error instanceof ApiError && error.status === 401);
    await assert.rejects(f.read({ sessionId: "ses_foreign" }), (error: unknown) => error instanceof ApiError && error.code === "session_not_found");
    await assert.rejects(f.read({}, { workspace: "missing" }), (error: unknown) => error instanceof ApiError && error.status === 404);
    f.move(null);
    await assert.rejects(f.read({ sessionId: "ses_owned" }), (error: unknown) => error instanceof ApiError && error.code === "session_not_found");
    assert.ok(f.routes.every((route) => route.auth === "client"));
    assert.equal(matchRoute(f.routes, "POST", "/workspace/ws1/files/browser/content"), null);
  } finally { await f.close(); }
});

test("absolute paths, traversal, query roots and symlink files/directories are rejected", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.temp, "outside.txt"), "not accessible");
    await symlink(f.temp, join(f.executionPath, "escape"));
    await symlink(join(f.temp, "outside.txt"), join(f.executionPath, "outside.txt"));
    await writeFile(join(f.executionPath, "inside.txt"), "inside");
    await symlink(join(f.executionPath, "inside.txt"), join(f.executionPath, "alias.txt"));
    for (const path of ["../outside.txt", "/etc/passwd", "a/../b", "a\\b", "a//b", "C:/file", "./file", "bad\0file"]) {
      await assert.rejects(f.read({ sessionId: "ses_owned", path }), (error: unknown) => error instanceof ApiError && error.status === 400);
    }
    for (const extra of ["root", "directory", "location[directory]"]) {
      await assert.rejects(f.read({ [extra]: f.temp }), (error: unknown) => error instanceof ApiError && error.status === 400);
    }
    await assert.rejects(f.read({}, { rawQuery: "path=inside.txt&path=../outside.txt" }), (error: unknown) => error instanceof ApiError && error.status === 400);
    for (const path of ["escape/outside.txt", "outside.txt", "alias.txt"]) {
      await assert.rejects(f.read({ sessionId: "ses_owned", path }, { content: true }), (error: unknown) => error instanceof ApiError && error.status === 403);
    }
    const result = await (await f.read({ sessionId: "ses_owned" })).json();
    assert.deepEqual(result.entries.map((entry: { path: string }) => entry.path), ["inside.txt"]);
  } finally { await f.close(); }
});

test("search/list bounds and cancellation stop work", async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 510 }, (_, index) => writeFile(join(f.executionPath, `file-${index}.txt`), "")));
    const listing = await (await f.read({ sessionId: "ses_owned" })).json();
    assert.equal(listing.entries.length, 500);
    assert.equal(listing.truncated, true);
    const search = await (await f.read({ sessionId: "ses_owned", query: "file" })).json();
    assert.equal(search.entries.length, 200);
    assert.equal(search.truncated, true);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.read({ sessionId: "ses_owned", query: "file" }, { signal: controller.signal }), { name: "AbortError" });
    const active = new AbortController();
    const pending = f.read({ sessionId: "ses_owned", query: "file" }, { signal: active.signal });
    setImmediate(() => active.abort());
    await assert.rejects(pending, { name: "AbortError" });
  } finally { await f.close(); }
});

test("deep searches are truncated instead of recursing without a bound", async () => {
  const f = await fixture();
  try {
    const nested = Array.from({ length: 23 }, () => "deep").join("/");
    await mkdir(join(f.executionPath, nested), { recursive: true });
    await writeFile(join(f.executionPath, nested, "needle.txt"), "fixture");
    const data = await (await f.read({ sessionId: "ses_owned", query: "needle" })).json();
    assert.equal(data.entries.length, 0);
    assert.equal(data.truncated, true);
  } finally { await f.close(); }
});

test("preview bounds binary data and serves active formats only as inert JSON text", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.executionPath, "large.txt"), Buffer.alloc(5_000_001));
    await writeFile(join(f.executionPath, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(f.executionPath, "page.html"), "<script>alert(1)</script>");
    await writeFile(join(f.executionPath, "picture.png"), Buffer.from([137, 80, 78, 71]));
    await assert.rejects(f.read({ sessionId: "ses_owned", path: "large.txt" }, { content: true }), (error: unknown) => error instanceof ApiError && error.status === 413);
    const binary = await (await f.read({ sessionId: "ses_owned", path: "binary.bin" }, { content: true })).json();
    assert.equal(binary.encoding, "unsupported");
    assert.equal(binary.content, null);
    const html = await f.read({ sessionId: "ses_owned", path: "page.html" }, { content: true });
    assert.match(html.headers.get("content-type") ?? "", /application\/json/);
    assert.equal((await html.json()).encoding, "utf8");
    const image = await (await f.read({ sessionId: "ses_owned", path: "picture.png" }, { content: true })).json();
    assert.equal(image.encoding, "base64");
    assert.equal(image.contentType, "image/png");
  } finally { await f.close(); }
});
