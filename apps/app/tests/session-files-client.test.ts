import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { fetchSessionFileContent, fetchSessionFiles } from "../src/react-app/domains/session/panel/session-files-client";

const listing = { directory: "/projects/example", rootId: "root", path: "", entries: [], truncated: false };

test("file browser transport uses authenticated GET with exact scope and cancellation", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.pathname, "/workspace/runtime%20workspace/files/browser");
    assert.equal(url.searchParams.get("sessionId"), "ses_owned");
    assert.equal(url.searchParams.get("path"), "nested folder");
    assert.equal(url.searchParams.get("query"), "test");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    assert.equal(init?.body, undefined);
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException("Canceled", "AbortError");
  };
  try {
    await assert.rejects(fetchSessionFiles({ serverClient: createOpenworkServerClient({ baseUrl: "http://localhost:1234", token: "fixture-token" }), workspaceId: "runtime workspace", sessionId: "ses_owned", path: "nested folder", query: "test", signal: controller.signal }), { name: "AbortError" });
  } finally { globalThis.fetch = original; }
});

test("file browser client validates data and rejects late canceled results", async () => {
  const result = await fetchSessionFiles({ serverClient: { getSessionFiles: async () => listing }, workspaceId: "ws" });
  assert.deepEqual(result, listing);
  await assert.rejects(fetchSessionFiles({ serverClient: { getSessionFiles: async () => ({ ...listing, entries: [{ kind: "invalid" }] }) }, workspaceId: "ws" }));
  const controller = new AbortController();
  await assert.rejects(fetchSessionFiles({ serverClient: { getSessionFiles: async () => { controller.abort(); return listing; } }, workspaceId: "ws", signal: controller.signal }), { name: "AbortError" });
});

test("preview forwards root identity and refuses mismatched roots or paths", async () => {
  const preview = { ...listing, path: ".env", encoding: "utf8", content: "fixture", contentType: "application/octet-stream", bytes: 7, updatedAt: 0 };
  const data = await fetchSessionFileContent({ serverClient: { getSessionFileContent: async (workspaceId, input) => {
    assert.equal(workspaceId, "ws");
    assert.equal(input.rootId, "root");
    assert.equal(input.sessionId, "ses_owned");
    return preview;
  } }, workspaceId: "ws", sessionId: "ses_owned", path: ".env", rootId: "root" });
  assert.equal(data.content, "fixture");
  for (const mismatch of [{ rootId: "different" }, { path: "different" }]) {
    await assert.rejects(fetchSessionFileContent({ serverClient: { getSessionFileContent: async () => ({ ...preview, ...mismatch }) }, workspaceId: "ws", path: ".env", rootId: "root" }));
  }
});

test("preview transport serializes root and file path without granting a root override", async () => {
  const original = globalThis.fetch;
  const rootId = "a".repeat(64);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.pathname, "/workspace/ws/files/browser/content");
    assert.equal(url.searchParams.get("sessionId"), "ses_owned");
    assert.equal(url.searchParams.get("rootId"), rootId);
    assert.equal(url.searchParams.get("path"), "nested/file name.txt");
    assert.equal(url.searchParams.has("directory"), false);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
    return Response.json({ directory: "/projects/example", rootId, path: "nested/file name.txt", content: "fixture", encoding: "utf8", contentType: "text/plain", bytes: 7, updatedAt: 0 });
  };
  try {
    const result = await fetchSessionFileContent({ serverClient: createOpenworkServerClient({ baseUrl: "http://localhost:1234", token: "fixture-token" }), workspaceId: "ws", sessionId: "ses_owned", path: "nested/file name.txt", rootId });
    assert.equal(result.content, "fixture");
  } finally { globalThis.fetch = original; }
});
