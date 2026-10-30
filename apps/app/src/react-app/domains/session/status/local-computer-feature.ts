import { resolveFeature } from "@openwork/features/resolve";

export function resolveLocalComputerFeature(input: {
  hostEligible: boolean; optedIn: boolean; signedOut: boolean; organizationReady: boolean;
  serverUrl: string; key: string;
}): boolean {
  if (!input.hostEligible || !input.optedIn || !input.signedOut || input.organizationReady || input.key !== "computerUse") return false;
  try {
    const url = new URL(input.serverUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  } catch { return false; }
  return resolveFeature("localComputerUse", {
    deployment: "self_hosted", locks: {}, overrides: {},
    rollouts: { localComputerUse: { enabled: true, killed: false } },
  }).enabled;
}
