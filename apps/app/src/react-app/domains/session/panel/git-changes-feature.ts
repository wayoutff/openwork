import { resolveFeature } from "@openwork/features/resolve";

export function resolveLocalGitChanges(enabled: boolean, serverUrl: string, desktop: boolean, managed: boolean, feature: "gitChangesPanel" | "sessionFileBrowser" = "gitChangesPanel"): boolean {
  if (!desktop || managed) return false;
  let url: URL;
  try { url = new URL(serverUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  return resolveFeature(feature, {
    deployment: "self_hosted",
    locks: {},
    overrides: {},
    rollouts: { [feature]: { enabled, killed: false } },
  }).enabled;
}
