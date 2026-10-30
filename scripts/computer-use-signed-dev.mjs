import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeEnvironment } from "./computer-use-trust-probe.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const hostIdentifier = "dev.openwork.local";
export const helperIdentifier = `${hostIdentifier}.computer-use`;

export function signedDevPaths(root = repo) {
  const output = path.join(root, ".data/computer-use-dev");
  const host = path.join(output, "OpenWork Local.app");
  return {
    output, host,
    helper: path.join(host, "Contents/Helpers/OpenWork Computer Use.app"),
    executable: path.join(host, "Contents/MacOS/Electron"),
    probe: path.join(host, "Contents/Resources/openwork-trust-probe.mjs"),
    electronDist: path.join(output, "electron-dist"),
  };
}

export function selectDevelopmentIdentity(text, selected = "") {
  const identities = [...text.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(Apple Development: [^"\r\n]+)"\s*$/gm)]
    .map((match) => ({ hash: match[1], name: match[2] }));
  const matches = selected.trim()
    ? identities.filter((identity) => identity.hash.toLowerCase() === selected.trim().toLowerCase() || identity.name === selected.trim())
    : identities;
  if (matches.length !== 1) throw new Error("Select exactly one available Apple Development identity using OPENWORK_LOCAL_SIGN_IDENTITY.");
  return matches[0];
}

export function parseOptions(args) {
  if (args.length === 0) return "build";
  if (args.length === 1 && ["--build", "--rebuild", "--probe", "--help"].includes(args[0])) return args[0].slice(2);
  throw new Error("Use --build, --rebuild, --probe or --help (one operation at a time).");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024, ...options,
  });
  // Never include command arguments or child output: codesign prints identities.
  if (result.error || result.status !== 0) {
    const reason = (result.stderr ?? "").replace(/Apple Development:[^\n]+/g, "[signing identity]")
      .replace(/[A-Fa-f0-9]{40}/g, "[certificate fingerprint]").replaceAll(repo, "<repo>")
      .replace(/(subject\[OU\] = ")[A-Z0-9]{10}("|$)/g, "$1[team]$2")
      .replaceAll(process.env.HOME || "/nonexistent", "~").slice(-1600);
    throw new Error(`Local ${path.basename(command)} operation failed (status ${result.status ?? "unavailable"}): ${reason}`);
  }
  return result;
}

function privateDirectory(directory) {
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Refusing an unsafe local output directory.");
  } else mkdirSync(directory, { mode: 0o700 });
}

export function signingTargets(bundle) {
  const result = [];
  const root = realpathSync(bundle);
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const location = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const destination = realpathSync(location);
        if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) throw new Error("Copied bundle contains an external symlink.");
      } else if (entry.isDirectory()) {
        walk(location);
        if (/\.(app|framework|xpc)$/.test(entry.name)) result.push(location);
      } else if (entry.isFile()) {
        const header = Buffer.alloc(4);
        const file = openSync(location, "r");
        try {
          const bytes = readSync(file, header, 0, 4, 0);
          if (bytes === 4 && ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(header.toString("hex"))) result.push(location);
        } finally { closeSync(file); }
      }
    }
  };
  walk(bundle);
  return [...result, bundle];
}

export function signatureMetadata(text) {
  const value = (key) => text.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim();
  const team = value("TeamIdentifier");
  const authority = value("Authority");
  if (!team || !/^[A-Z0-9]{10}$/.test(team) || !authority?.startsWith("Apple Development: ")
    || /^Signature=adhoc$/m.test(text)) throw new Error("A valid Apple Development team signature is required.");
  return { team, authority, identifier: value("Identifier") };
}

function verifyBundles(paths, identity) {
  const host = signatureMetadata(run("/usr/bin/codesign", ["--display", "--verbose=4", paths.host]).stderr);
  const helper = signatureMetadata(run("/usr/bin/codesign", ["--display", "--verbose=4", paths.helper]).stderr);
  if (host.identifier !== hostIdentifier || helper.identifier !== helperIdentifier
    || host.team !== helper.team || host.authority !== helper.authority
    || (identity && host.authority !== identity.name)) throw new Error("Local host and helper signing identities do not match.");
  for (const [bundle, identifier] of [[paths.host, hostIdentifier], [paths.helper, helperIdentifier]]) {
    const requirement = `identifier "${identifier}" and anchor apple generic and certificate leaf[subject.OU] = "${host.team}"`;
    run("/usr/bin/codesign", ["--verify", "--strict", "--deep", "-R", `=${requirement}`, bundle]);
  }
}

export function build(root = repo) {
  const paths = signedDevPaths(root);
  privateDirectory(path.join(root, ".data"));
  privateDirectory(paths.output);
  if (existsSync(paths.host) || existsSync(paths.electronDist)) throw new Error("Isolated host already exists. Move the previous computer-use-dev output aside before building a fresh copy.");
  const electron = path.join(root, "apps/desktop/node_modules/electron");
  if (readFileSync(path.join(electron, "path.txt"), "utf8").trim() !== "Electron.app/Contents/MacOS/Electron") throw new Error("Unexpected Electron distribution layout.");
  const source = path.join(electron, "dist/Electron.app");
  if (!existsSync(source)) throw new Error("Install the repository Electron dependency before building the isolated host.");
  const identity = selectDevelopmentIdentity(run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]).stdout, process.env.OPENWORK_LOCAL_SIGN_IDENTITY);
  const staging = mkdtempSync(path.join(paths.output, ".build-"));
  const host = path.join(staging, "OpenWork Local.app");
  try {
    run("/usr/bin/ditto", ["--noextattr", "--noqtn", source, host]);
    // Refuse any copied link that could redirect subsequent writes outside this host.
    signingTargets(host);
    const plist = path.join(host, "Contents/Info.plist");
    for (const [key, value] of [["CFBundleIdentifier", hostIdentifier], ["CFBundleDisplayName", "OpenWork Local"], ["CFBundleName", "OpenWork Local"]]) {
      run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
    }
    // Keep default_app.asar: Resources/app would turn explicit main-file launches into packaged mode.
    if (existsSync(path.join(host, "Contents/Resources/app")) || existsSync(path.join(host, "Contents/Resources/app.asar"))) throw new Error("Expected a stock, unpackaged Electron distribution.");
    copyFileSync(path.join(root, "scripts/computer-use-trust-probe.mjs"), path.join(host, "Contents/Resources/openwork-trust-probe.mjs"));
    run(process.execPath, [path.join(root, "apps/desktop/scripts/prepare-computer-use-helper.mjs"),
      "--force", "--outdir", path.join(host, "Contents/Helpers"),
      "--bundle-id", helperIdentifier, "--host-bundle-id", hostIdentifier,
      "--display-name", "OpenWork Local Computer Use", "--require-team-signature"], {
      cwd: root, timeout: 600_000,
      env: { ...process.env, OPENWORK_COMPUTER_USE_SIGN_IDENTITY: identity.hash },
    });
    const entitlements = path.join(root, "apps/desktop/build/entitlements.mac.plist");
    const nativeHelper = path.join(host, "Contents/Helpers/OpenWork Computer Use.app");
    for (const target of signingTargets(host)) {
      // The native helper is already signed; do not grant it Electron JIT entitlements.
      if (target === nativeHelper || target.startsWith(nativeHelper + path.sep)) continue;
      run("/usr/bin/codesign", ["--force", "--sign", identity.hash, "--options", "runtime", "--timestamp=none", "--entitlements", entitlements, target]);
    }
    verifyBundles({ host, helper: path.join(host, "Contents/Helpers/OpenWork Computer Use.app") }, identity);
    renameSync(host, paths.host);
    privateDirectory(paths.electronDist);
    symlinkSync("../OpenWork Local.app", path.join(paths.electronDist, "Electron.app"));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { status: "signed_host_built", hostIdentifier, helperIdentifier, probed: false };
}

export function probe(root = repo) {
  const paths = signedDevPaths(root);
  verifyBundles(paths);
  const result = run(paths.executable, [paths.probe, "--openwork-trust-probe"], {
    env: probeEnvironment(), cwd: paths.output, timeout: 20_000,
  });
  const messages = result.stdout.trim().split("\n");
  if (messages.length !== 1) throw new Error("Unexpected local trust probe response.");
  const message = JSON.parse(messages[0]);
  if (message.status !== "live_trust_passed" || message.unpackaged !== true) throw new Error("Live host trust was not verified.");
  return { status: "live_trust_passed", unpackaged: true, permissionsTested: false, captureTested: false, inputTested: false };
}

export function rebuild(root = repo) {
  const paths = signedDevPaths(root);
  verifyBundles(paths);
  const backup = `${paths.output}-backup-${Date.now()}`;
  if (existsSync(backup)) throw new Error("Backup already exists; previous bundle was not changed.");
  renameSync(paths.output, backup);
  try {
    const result = build(root);
    return { ...result, previousBundlePreserved: true };
  } catch (error) {
    // Keep failed output for diagnosis; restore the old signed path unchanged.
    if (existsSync(paths.output)) renameSync(paths.output, `${backup}-failed`);
    renameSync(backup, paths.output);
    throw error;
  }
}

export function main(args = process.argv.slice(2)) {
  const operation = parseOptions(args);
  if (operation === "help") {
    console.log("Usage: node scripts/computer-use-signed-dev.mjs [--build | --rebuild | --probe | --help]\nBuild copies and signs only .data/computer-use-dev/OpenWork Local.app using OPENWORK_LOCAL_SIGN_IDENTITY, or exactly one available Apple Development identity. No ad-hoc fallback or installed-app/node_modules changes. Stop the signed app before --rebuild: it preserves the previous output as a backup and restores it on failure. --probe separately launches the signed copy with an embedded initialize-only probe, no windows, capture, input or permission requests. Signing may ask for private-key access. No DMG or keychain configuration changes.");
    return;
  }
  if (process.platform !== "darwin") throw new Error("The isolated signed host requires macOS.");
  console.log(JSON.stringify(operation === "build" ? build() : operation === "rebuild" ? rebuild() : probe()));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : "Isolated signed host operation failed."); process.exitCode = 1; }
}
