/** @jsxImportSource react */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { gitChangesItems } from "../src/react-app/domains/session/panel/git-changes-renderer";
import type { GitFile } from "../src/react-app/domains/session/panel/git-changes-client";

let store: typeof import("../src/react-app/domains/session/panel/panel-tab-store");
let destinations: typeof import("../src/react-app/domains/session/panel/panel-empty");
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  store = await import("../src/react-app/domains/session/panel/panel-tab-store");
  destinations = await import("../src/react-app/domains/session/panel/panel-empty");
});
beforeEach(() => store.usePanelTabStore.setState({ sessions: {}, transcriptArtifactTargets: {} }));
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

const patch = "diff --git a/src/example.ts b/src/example.ts\nindex 1111111..2222222 100644\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n";
const file: GitFile = { file: "src/example.ts", patch, additions: 1, deletions: 1, status: "modified" };

test("Git tab opening is idempotent and scoped to a workspace and session", () => {
  const state = store.usePanelTabStore.getState();
  state.openTab("session-1", store.gitChangesPanelTab("workspace-1"));
  state.openTab("session-1", store.gitChangesPanelTab("workspace-1"));
  state.openTab("session-1", store.gitChangesPanelTab("workspace-2"));
  state.openTab("session-2", store.gitChangesPanelTab("workspace-1"));
  const sessions = store.usePanelTabStore.getState().sessions;
  expect(sessions["session-1"].tabs).toHaveLength(2);
  expect(sessions["session-2"].tabs).toHaveLength(1);
  expect(sessions["session-1"].activeTabId).toBe("git-changes:workspace-2");
});

test("Files has its own tab and survives browser and artifact updates", () => {
  const state = store.usePanelTabStore.getState();
  state.openTab("session-1", store.filesPanelTab());
  state.openTab("session-1", store.filesPanelTab());
  state.syncBrowserTabs("session-1", [], null);
  state.syncTranscriptArtifacts("session-1", []);
  expect(store.usePanelTabStore.getState().sessions["session-1"].tabs).toHaveLength(1);
  expect(store.usePanelTabStore.getState().sessions["session-1"].activeTabId).toBe("session-files");
  expect(store.reconcileClosedBrowserPanel("session-1")).toBe(true);
});

test("file preview tabs deduplicate within a root but not across moved directories", () => {
  const state = store.usePanelTabStore.getState();
  const file = store.sessionFilePanelTab("workspace", "/project", "root-1", "src/index.ts");
  state.openTab("session", file);
  state.openTab("session", file);
  state.openTab("session", store.sessionFilePanelTab("workspace", "/other", "root-2", "src/index.ts"));
  expect(store.usePanelTabStore.getState().sessions.session.tabs).toHaveLength(2);
});

test("background browser synchronization preserves Git selection and closing selects neighbor", () => {
  const state = store.usePanelTabStore.getState();
  state.openTab("session-1", { id: "file:example.ts", type: "artifact", label: "example.ts", preview: "code" });
  state.openTab("session-1", store.gitChangesPanelTab("workspace-1"));
  state.syncBrowserTabs("session-1", [], null);
  expect(store.usePanelTabStore.getState().sessions["session-1"].activeTabId).toBe("git-changes:workspace-1");
  state.closeTab("session-1", "git-changes:workspace-1");
  expect(store.usePanelTabStore.getState().sessions["session-1"].activeTabId).toBe("file:example.ts");
});

test("destination remains locked when feature is off and activates the shared command when on", () => {
  let opens = 0;
  const actions = { onOpenGitChanges: () => { opens++; }, gitChangesEnabled: false };
  const locked = destinations.getPanelDestinations(actions, () => {}).find((item) => item.id === "git-changes");
  expect(locked?.disabled).toBe(true);
  const enabled = destinations.getPanelDestinations({ ...actions, gitChangesEnabled: true }, () => {}).find((item) => item.id === "git-changes");
  expect(enabled?.disabled).toBe(false);
  enabled?.activate();
  expect(opens).toBe(1);
});

test("Files destination opens a real file browser rather than an anonymous empty screen", () => {
  let opens = 0;
  const openFiles = () => { opens++; };
  const entry = destinations.getPanelDestinations({ filesEnabled: true }, openFiles).find((item) => item.id === "files");
  expect(entry?.label).toBe("Files");
  expect(entry?.disabled).toBe(false);
  entry?.activate();
  expect(opens).toBe(1);
  expect(destinations.getPanelDestinations({ filesEnabled: false }, openFiles).find((item) => item.id === "files")?.disabled).toBe(true);
});

test("closing the last browser preserves Git and selects it before native state arrives", () => {
  const state = store.usePanelTabStore.getState();
  state.openTab("session-1", store.gitChangesPanelTab("workspace-1"));
  state.syncBrowserTabs("session-1", [{
    id: "browser-1", type: "browser", label: "New tab", url: "about:blank",
    favicon: null, status: "ready", canGoBack: false, canGoForward: false,
    ownerSessionId: "session-1", siteToolCount: 0, siteTools: [], siteToolActivity: [],
  }], "browser-1");
  state.selectTab("session-1", "browser-1");
  expect(store.reconcileClosedBrowserPanel("session-1")).toBe(true);
  expect(store.usePanelTabStore.getState().sessions["session-1"].activeTabId).toBe("git-changes:workspace-1");
  expect(store.usePanelTabStore.getState().sessions["session-1"].tabs).toHaveLength(1);
  // A duplicate close notification and later native sync must not hide Git.
  state.syncBrowserTabs("session-1", [], null);
  expect(store.reconcileClosedBrowserPanel("session-1")).toBe(true);
});

test("browser close is owner-scoped and an empty panel can still close", () => {
  const state = store.usePanelTabStore.getState();
  state.openTab("session-1", store.gitChangesPanelTab("workspace-1"));
  state.openTab("session-2", { id: "artifact-1", type: "artifact", label: "File", preview: "code" });
  expect(store.reconcileClosedBrowserPanel("session-2")).toBe(true);
  expect(store.usePanelTabStore.getState().sessions["session-1"].activeTabId).toBe("git-changes:workspace-1");
  expect(store.reconcileClosedBrowserPanel("empty-session")).toBe(false);
});

test("Pierre parses text patches and uses revision-scoped caches", () => {
  const first = gitChangesItems([file], "owner-1:revision-1").items[0];
  const second = gitChangesItems([file], "owner-1:revision-2").items[0];
  expect(first.type).toBe("diff");
  if (first.type !== "diff" || second.type !== "diff") throw new Error("Expected diff items");
  expect(first.fileDiff.name).toBe(file.file);
  expect(first.fileDiff.hunks).toHaveLength(1);
  expect(first.fileDiff.isPartial).toBe(true);
  expect(first.fileDiff.cacheKey).not.toBe(second.fileDiff.cacheKey);
});

test("binary, empty and malformed patches remain visible without hiding valid files", () => {
  const result = gitChangesItems([
    file,
    { ...file, file: "image.png", patch: "Binary files a/image.png and b/image.png differ\n" },
    { ...file, file: "large.txt", patch: "" },
    { ...file, file: "broken.txt", patch: patch.replace("@@ -1 +1 @@", "@@ invalid @@") },
  ], "revision-1");
  expect(result.items).toHaveLength(4);
  expect(result.items[0].type).toBe("diff");
  expect(result.notices.get("image.png")).toBe("Binary file");
  expect(result.notices.get("large.txt")).toBe("Text changes unavailable");
  expect(result.notices.has("broken.txt")).toBe(true);
  expect(result.items.slice(1).every((item) => item.collapsed)).toBe(true);
});

test("added, deleted, spaces and missing final newline parse as read-only diff items", () => {
  const added = "diff --git a/nested/new file.txt b/nested/new file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/nested/new file.txt\n@@ -0,0 +1 @@\n+hello\n\\ No newline at end of file\n";
  const deleted = "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-goodbye\n";
  const result = gitChangesItems([{ ...file, file: "nested/new file.txt", patch: added, status: "added" }, { ...file, file: "old.txt", patch: deleted, status: "deleted" }], "revision-2");
  expect(result.notices.size).toBe(0);
  expect(result.items.every((item) => item.type === "diff" && !item.edit)).toBe(true);
});
