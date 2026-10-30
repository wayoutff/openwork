import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseSignature(text, present = true) {
  const value = (name) => text.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim() ?? null;
  const team = value("TeamIdentifier");
  return {
    present,
    identifier: value("Identifier"),
    team: team && /^[A-Z0-9]{10}$/.test(team) ? team : null,
    adhoc: /^Signature=adhoc$/m.test(text) || /flags=.*\badhoc\b/.test(text),
  };
}

export function countIdentities(text) {
  // Never report certificate owner names, hashes or team identities.
  return {
    development: (text.match(/"Apple Development: [^"\n]+"/g) ?? []).length,
    distribution: (text.match(/"Developer ID Application: [^"\n]+"/g) ?? []).length,
  };
}

export function assessTrust(host, helper, expectedHost) {
  const blockers = [];
  if (!host.present) blockers.push("host_missing");
  if (!helper.present) blockers.push("helper_missing");
  if (host.present && (!host.team || host.adhoc)) blockers.push("host_has_no_team_signature");
  if (helper.present && (!helper.team || helper.adhoc)) blockers.push("helper_has_no_team_signature");
  if (host.present && host.identifier !== expectedHost) blockers.push("host_identifier_mismatch");
  if (host.team && helper.team && host.team !== helper.team) blockers.push("signing_team_mismatch");
  return blockers;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
}

function inspect(bundle) {
  if (!existsSync(bundle)) return parseSignature("", false);
  const result = run("/usr/bin/codesign", ["--display", "--verbose=4", bundle]);
  return parseSignature(result.stderr ?? "");
}

export function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log("Usage: node scripts/computer-use-preflight.mjs [--host /path/App.app] [--helper /path/Helper.app]\nRead-only: inspects signatures and certificate counts. Does not capture, launch helpers, sign, or request permissions. Exit 2 means prerequisites are blocked; exit 0 is NOT proof of runtime readiness.");
    return 0;
  }
  if (process.platform !== "darwin") {
    console.log(JSON.stringify({ status: "unsupported", reason: "macos_only" }));
    return 2;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--host", "--helper"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error("Expected --host or --helper followed by an app bundle path");
    }
    options[args[i]] = path.resolve(args[i + 1]);
  }
  const hostPath = options["--host"] ?? path.join(repo, "apps/desktop/node_modules/electron/dist/Electron.app");
  const helperPath = options["--helper"] ?? path.join(repo, "apps/desktop/resources/helpers/OpenWork Computer Use.app");
  const source = readFileSync(path.join(repo, "packages/computer-use/native/Sources/ComputerUse/HostTrust.swift"), "utf8");
  const configured = run("/usr/bin/plutil", ["-extract", "OpenWorkTrustedHostIdentifier", "raw", "-o", "-", path.join(helperPath, "Contents/Info.plist")]);
  const expectedHost = configured.status === 0 ? configured.stdout.trim() : source.match(/static let desktopIdentifier = "([A-Za-z0-9.-]+)"/)?.[1];
  if (!expectedHost) throw new Error("Host trust policy changed; review preflight before relying on it");
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(expectedHost)) throw new Error("Invalid signed host identity");
  const host = inspect(hostPath);
  const helper = inspect(helperPath);
  const blockers = assessTrust(host, helper, expectedHost);
  const identitiesResult = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  const identities = identitiesResult.status === 0 ? countIdentities(identitiesResult.stdout) : null;
  // Match the Apple/team/identifier requirement used by the native host check.
  // This verifies files on disk, not the live parent-process chain.
  let requirementVerified = false;
  if (blockers.length === 0) {
    const requirement = `identifier "${expectedHost}" and anchor apple generic and certificate leaf[subject.OU] = "${helper.team}"`;
    const hostCheck = run("/usr/bin/codesign", ["--verify", "--strict", "--deep", "-R", `=${requirement}`, hostPath]);
    const helperCheck = run("/usr/bin/codesign", ["--verify", "--strict", "--deep", helperPath]);
    requirementVerified = hostCheck.status === 0 && helperCheck.status === 0;
    if (!requirementVerified) blockers.push("signature_verification_failed");
  }
  console.log(JSON.stringify({
    status: blockers.length ? "blocked" : "static_checks_passed",
    expectedHost,
    host: { present: host.present, identifier: host.identifier, teamSigned: Boolean(host.team) && !host.adhoc },
    helper: { present: helper.present, identifier: helper.identifier, teamSigned: Boolean(helper.team) && !helper.adhoc },
    availableIdentities: identities,
    signatureRequirementVerified: requirementVerified,
    blockers,
    notTested: ["certificate_private_key_access", "live_parent_process_trust", "accessibility_permission", "screen_recording_permission", "system_sharing_indicator", "model_vision"],
  }, null, 2));
  return blockers.length ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch { console.error("Computer-use preflight failed; verify arguments, local tools and HostTrust policy."); process.exitCode = 1; }
}
