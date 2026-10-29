import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchGitChanges } from "../src/react-app/domains/session/panel/git-changes-client";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";

const result = {
  directory: "/projects/example", repository: true, branch: "topic", defaultBranch: "main",
  mode: "working", base: "refs/heads/main", baseRequired: false, branches: ["main", "topic"],
  files: [{ file: "file.txt", patch: "", additions: 2, deletions: 1, status: "modified" }],
  workingStatus: [], additions: 2, deletions: 1,
};

test("Git client forwards workspace, session and abort without reading credentials", async () => {
  const controller = new AbortController();
  const data = await fetchGitChanges({
    serverClient: { getGitChanges: async (workspace, input) => {
      assert.equal(workspace, "runtime-workspace");
      assert.equal(input.sessionId, "ses_owned");
      assert.equal(input.signal, controller.signal);
      return result;
    } },
    workspaceId: "runtime-workspace", sessionId: "ses_owned", mode: "working", signal: controller.signal,
  });
  assert.equal(data.directory, "/projects/example");
  assert.equal(data.additions, 2);
});

test("Git client rejects invalid data and canceled late responses", async () => {
  await assert.rejects(fetchGitChanges({
    serverClient: { getGitChanges: async () => ({ ...result, files: [{ file: "x", additions: -1 }] }) },
    workspaceId: "ws", mode: "working",
  }));
  const controller = new AbortController();
  await assert.rejects(fetchGitChanges({
    serverClient: { getGitChanges: async () => { controller.abort(); return result; } },
    workspaceId: "ws", mode: "working", signal: controller.signal,
  }), { name: "AbortError" });
});

test("Git transport uses existing authenticated GET and propagates cancellation", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.pathname, "/workspace/runtime%20workspace/git/changes");
    assert.equal(url.searchParams.get("sessionId"), "ses_owned");
    assert.equal(url.searchParams.get("base"), "feature/topic");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    assert.equal(init?.body, undefined);
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("Canceled", "AbortError");
  };
  try {
    await assert.rejects(fetchGitChanges({
      serverClient: createOpenworkServerClient({ baseUrl: "http://localhost:1234", token: "fixture-token" }),
      workspaceId: "runtime workspace", sessionId: "ses_owned", mode: "branch", base: "feature/topic", signal: controller.signal,
    }), { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});
