import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { test } from "node:test";
import { ApiError } from "../src/errors.js";
import { registerGitChangesRoutes } from "../src/routes/git-changes.js";
import { matchRoute, type RequestContext, type Route } from "../src/routes/registry.js";
import type { WorkspaceInfo } from "../src/types.js";

const file = { file: "src/example.ts", patch: "@@ -1 +1 @@\n-old\n+new\n", status: "modified", additions: 1, deletions: 1 };

async function fixture(options: { session?: string | null; repository?: boolean; base?: string | null; mismatch?: boolean; failDiff?: boolean; cold?: boolean; failReadiness?: boolean } = {}) {
  const directory = await realpath(process.cwd());
  const workspace: WorkspaceInfo = { id: "ws1", name: "Chat", path: directory, preset: "starter", workspaceType: "local" };
  const routes: Route[] = [];
  const requests: URL[] = [];
  const originalFetch = globalThis.fetch;
  let ready = !options.cold;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("opencode:test-password").toString("base64")}`);
    let data: unknown;
    if (url.pathname === "/api/vcs") data = options.repository === false || !ready ? { branch: {} } : { provider: "git", branch: { current: "topic", default: "main" } };
    else if (url.pathname === "/api/agent") {
      if (options.failReadiness) return Response.json({ message: "Location plugins did not finish activating" }, { status: 503 });
      ready = true;
      data = [];
    }
    else if (url.pathname === "/api/vcs/base") data = options.base === null ? null : { ref: options.base ?? "refs/heads/main", name: "main", source: "default" };
    else if (url.pathname === "/api/vcs/branch") data = ["main", "topic"];
    else if (url.pathname === "/api/vcs/status") data = [{ ...file, additions: 99 }];
    else if (url.pathname === "/api/vcs/diff") {
      if (options.failDiff) return Response.json({ message: "No merge base" }, { status: 503 });
      data = [file];
    } else throw new Error(`Unexpected endpoint ${url.pathname}`);
    return Response.json({ location: { directory: options.mismatch ? "/unrelated" : url.searchParams.get("location[directory]") }, data });
  };
  registerGitChangesRoutes({
    routes,
    resolveWorkspace: async (id) => {
      if (id !== workspace.id) throw new ApiError(404, "workspace_not_found", "Workspace not found");
      return workspace;
    },
    resolveSessionDirectory: async (_, id) => id === "ses_owned" ? options.session ?? directory : null,
    connection: () => ({ url: "http://127.0.0.1:1234", username: "opencode", password: "test-password" }),
  });
  return {
    directory, requests, routes,
    restore: () => { globalThis.fetch = originalFetch; },
    read: async (query = "", actor = true, workspaceId = "ws1") => {
      const request = new Request(`http://localhost/workspace/${workspaceId}/git/changes${query}`);
      const route = matchRoute(routes, "GET", new URL(request.url).pathname);
      assert.ok(route);
      // These routes intentionally use none of the mutable services in RequestContext.
      const ctx = { request, url: new URL(request.url), params: route.params, actor: actor ? { scope: "viewer" } : undefined } as RequestContext;
      return route.handler(ctx);
    },
  };
}

test("working changes use native VCS data, bounded context and diff-only totals", async () => {
  const f = await fixture();
  try {
    const response = await f.read("?mode=working");
    const data = await response.json();
    assert.equal(data.directory, f.directory);
    assert.equal(data.additions, 1);
    assert.equal(data.workingStatus[0].additions, 99);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(f.requests.length, 5);
    const diff = f.requests.find((url) => url.pathname === "/api/vcs/diff");
    assert.equal(diff?.searchParams.get("context"), "3");
    assert.equal(diff?.searchParams.get("untracked"), "files");
    assert.ok(f.requests.every((url) => url.searchParams.get("location[directory]") === f.directory));
  } finally { f.restore(); }
});

test("owned session execution directory wins over workspace title and path", async () => {
  const session = await realpath("..");
  const f = await fixture({ session });
  try {
    const data = await (await f.read("?sessionId=ses_owned&mode=branch&base=main")).json();
    assert.notEqual(session, f.directory);
    assert.equal(data.directory, session);
    assert.ok(f.requests.every((url) => url.searchParams.get("location[directory]") === session));
    assert.equal(f.requests.find((url) => url.pathname === "/api/vcs/diff")?.searchParams.get("base"), "main");
  } finally { f.restore(); }
});

test("unauthorized session and arbitrary paths fail closed before reading Git", async () => {
  const f = await fixture();
  try {
    for (const query of ["?path=/tmp", "?location[directory]=/tmp", "?sessionId=../../tmp", "?mode=committed", "?base=--output=/tmp", "?base=../other", "?mode=working&mode=branch"]) {
      await assert.rejects(f.read(query), (error: unknown) => error instanceof ApiError && error.status === 400);
    }
    await assert.rejects(f.read("?sessionId=ses_foreign"), (error: unknown) => error instanceof ApiError && error.code === "session_not_found");
    await assert.rejects(f.read("", false), (error: unknown) => error instanceof ApiError && error.status === 401);
    await assert.rejects(f.read("", true, "missing"), (error: unknown) => error instanceof ApiError && error.status === 404);
    assert.equal(f.requests.length, 0);
    assert.equal(f.routes[0].auth, "client");
    assert.equal(matchRoute(f.routes, "POST", "/workspace/ws1/git/changes"), null);
  } finally { f.restore(); }
});

test("no repository and missing review base are distinct from a clean diff", async () => {
  const f = await fixture({ repository: false });
  try {
    const data = await (await f.read()).json();
    assert.equal(data.repository, false);
    assert.deepEqual(f.requests.map((url) => url.pathname), ["/api/vcs", "/api/agent", "/api/vcs"]);
  } finally { f.restore(); }
  const branch = await fixture({ base: null });
  try {
    const data = await (await branch.read("?mode=branch")).json();
    assert.equal(data.baseRequired, true);
    assert.equal(data.base, null);
    assert.ok(branch.requests.every((url) => url.pathname !== "/api/vcs/diff"));
  } finally { branch.restore(); }
});

test("cold V2 locations await plugin activation before deciding whether Git exists", async () => {
  const f = await fixture({ cold: true });
  try {
    const data = await (await f.read("?sessionId=ses_owned")).json();
    assert.equal(data.repository, true);
    assert.equal(data.files.length, 1);
    assert.deepEqual(f.requests.slice(0, 3).map((url) => url.pathname), ["/api/vcs", "/api/agent", "/api/vcs"]);
    assert.ok(f.requests.every((url) => url.searchParams.get("location[directory]") === f.directory));
  } finally { f.restore(); }
  const failed = await fixture({ cold: true, failReadiness: true });
  try {
    await assert.rejects(failed.read(), (error: unknown) => error instanceof ApiError && error.code === "git_unavailable");
    assert.equal(failed.requests.length, 2);
  } finally { failed.restore(); }
});

test("mismatched locations and unavailable diffs never become empty success", async () => {
  const f = await fixture({ mismatch: true });
  try {
    await assert.rejects(f.read(), (error: unknown) => error instanceof ApiError && error.code === "git_directory_mismatch");
  } finally { f.restore(); }
  const failed = await fixture({ failDiff: true });
  try {
    await assert.rejects(failed.read(), (error: unknown) => error instanceof ApiError && error.code === "git_unavailable");
  } finally { failed.restore(); }
});
