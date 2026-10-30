import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createClient } from "../src/app/lib/opencode";
import { createOpenworkServerClient, type OpenworkCloudMcpHealth, type OpenworkCloudMcpProviderModelContext } from "../src/app/lib/openwork-server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const den = await import("../src/app/lib/den");
const { getSessionMcpMaintenanceTargetKey, useSessionMcpMaintenance } = await import("../src/react-app/domains/connections/use-session-mcp-maintenance");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const free = { provider: "openwork-free", model: "openai/gpt-6-luna" };
const selected = { provider: "litellm", model: "gpt-6.1-sol" };
const client = createOpenworkServerClient({ baseUrl: "http://localhost:8787" });
const opencodeClient = createClient("http://localhost:4096");
let root: Root;
let host: HTMLDivElement;
let providerModel = free;

function health(model: OpenworkCloudMcpProviderModelContext = free, usable = true): OpenworkCloudMcpHealth {
  const tools = { expected: [], present: [], missing: [] };
  return {
    schemaVersion: 1, phase: usable ? "ready" : "provider_projection_missing", usable,
    usableByCurrentModel: usable, connectCatalogEnabled: true,
    workspace: { id: "workspace", type: "local", directory: "/workspace", path: "/workspace" },
    desired: { present: true, name: "openwork-cloud", revision: null, config: null,
      token: { present: true, metadata: { organizationId: "org" } } },
    delivery: { state: "ready", desiredRevision: null, appliedRevision: null, updatedAt: null, appliedAt: null, lastAttemptAt: null },
    engine: { status: "connected" },
    tools: { ...tools, direct: { ...tools, checked: true, source: "mcp_tools_list" },
      providerProjection: { ...tools, checked: true, ...model, modelExists: usable, toolCalling: usable } },
    pluginCanaries: tools,
    compatibility: {
      openwork: { serverVersion: null, app: null },
      opencode: { expectedVersion: null, actualVersion: null, probe: "ok" },
      pluginFileHashes: [],
      supportedFeatures: { dynamicMcp: true, directoryScoping: true, toolIds: true, providerToolProjection: true, pluginCanaries: true },
      experimentalToolIds: { ...tools, checked: true, includesMcpTools: true },
      experimentalProviderTools: { ...tools, checked: true, includesMcpTools: usable },
    },
    toolDenies: [], checkedAt: new Date().toISOString(),
    firstFailure: usable ? null : {
      code: "provider_tool_projection_missing", stage: "provider_projection", retryable: false,
      recommendedAction: "Choose an available model.", message: `${model.provider}/${model.model} is missing from the catalog`,
    },
  };
}

function Probe() {
  const state = useSessionMcpMaintenance({ cloudSignedIn: true, cloudAuthStatus: "signed_in", client,
    workspaceId: "workspace", directory: "/workspace", opencodeClient, providerModel });
  return <output data-status={state.status}>{state.issue?.message ?? ""}</output>;
}

async function render(model = providerModel) {
  providerModel = model;
  await act(async () => { root.render(<Probe />); });
}

beforeEach(() => {
  window.localStorage.clear();
  const settings = { ...den.readDenSettings(), baseUrl: "https://den.example.test", authToken: "test-session", activeOrgId: "org" };
  spyOn(den, "readDenSettings").mockReturnValue(settings);
  spyOn(den, "mintCloudControlMcpToken").mockResolvedValue({ token: "test-mcp-token", organizationId: "org",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), scopes: ["mcp"], resource: "https://den.example.test/mcp" });
  spyOn(client, "listMcp").mockResolvedValue({ items: [] });
  spyOn(client, "getOpenworkCloudMcpHealth").mockImplementation(async (_workspace, model) => health(model, false));
  spyOn(client, "reconcileOpenworkCloudMcp").mockImplementation(async (_workspace, payload) =>
    health({ provider: payload.provider ?? "", model: payload.model ?? "" }, false));
  providerModel = free;
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  mock.restore();
  window.localStorage.clear();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("the route projects the effective composer model, including workspace and conversation selections", () => {
  const route = readFileSync(new URL("../src/react-app/shell/session-route.tsx", import.meta.url), "utf8");
  // Guard the caller wiring: changing the global default is not how either picker saves a choice.
  expect(route).toContain("const activeComposerModel = selectedSessionModelSelection?.model ?? (selectedSessionId ? local.prefs.defaultModel : newTaskModel) ?? null;");
  expect(route).toContain("const cloudMcpProviderModel = useMemo(() => activeComposerModel");
  expect(route).toContain("provider: activeComposerModel.providerID");
  expect(route).toContain("model: activeComposerModel.modelID");
  expect(route).toContain("[activeComposerModel?.modelID, activeComposerModel?.providerID]");
});

test("both provider and model changes have independent maintenance retry keys", () => {
  const key = (model: OpenworkCloudMcpProviderModelContext) => getSessionMcpMaintenanceTargetKey({
    client, cloudSignedIn: true, workspaceId: "workspace", orgId: "org", providerModel: model,
  });
  expect(key(free)).not.toBe(key({ ...free, provider: "litellm" }));
  expect(key(selected)).not.toBe(key({ ...selected, model: "another-model" }));
});

test("a model change rechecks projection and clears the old failure only after verified success", async () => {
  await render();
  expect(host.querySelector("output")?.dataset.status).toBe("failed");
  expect(host.textContent).toContain("openwork-free");

  let resolve!: (result: OpenworkCloudMcpHealth) => void;
  const pending = new Promise<OpenworkCloudMcpHealth>((done) => { resolve = done; });
  const probe = spyOn(client, "getOpenworkCloudMcpHealth").mockReturnValue(pending);
  await render(selected);
  expect(probe).toHaveBeenLastCalledWith("workspace", selected, { probe: true });
  expect(host.querySelector("output")?.dataset.status).toBe("checking");
  expect(host.textContent).toBe("");

  await act(async () => { resolve(health(selected)); });
  expect(host.querySelector("output")?.dataset.status).toBe("ready");
  expect(host.textContent).toBe("");
});

test("a genuine projection failure for the newly selected model is not masked", async () => {
  await render();
  await render(selected);
  expect(host.querySelector("output")?.dataset.status).toBe("failed");
  expect(host.textContent).toContain("litellm/gpt-6.1-sol");
  expect(host.textContent).not.toContain("openwork-free");
  await render({ ...selected, model: "another-model" });
  expect(host.querySelector("output")?.dataset.status).toBe("failed");
  expect(host.textContent).toContain("litellm/another-model");
});
