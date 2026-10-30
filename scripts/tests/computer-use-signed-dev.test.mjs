import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { parseOptions, selectDevelopmentIdentity, signatureMetadata, signedDevPaths, signingTargets } from "../computer-use-signed-dev.mjs";
import { initializeRequest, probeEnvironment, probeHelper, validInitializeResponse } from "../computer-use-trust-probe.mjs";

const hash = "A".repeat(40);
const otherHash = "B".repeat(40);
const identity = `1) ${hash} "Apple Development: Local Test (ABCDEFGHIJ)"`;
const otherIdentity = `2) ${otherHash} "Apple Development: Other Test (KLMNOPQRST)"`;
const response = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", serverInfo: { name: "openwork-computer-use" }, capabilities: { tools: {} } } };

test("identity selection requires exactly one valid Apple Development match", () => {
  assert.equal(selectDevelopmentIdentity(identity).hash, hash);
  assert.equal(selectDevelopmentIdentity(`${identity}\n${otherIdentity}`, otherHash.toLowerCase()).hash, otherHash);
  assert.equal(selectDevelopmentIdentity(identity, "Apple Development: Local Test (ABCDEFGHIJ)").hash, hash);
  for (const [text, selected] of [["", ""], [`${identity}\n${otherIdentity}`, ""], [identity, "-"], [identity, "missing"], [`1) ${hash} "Developer ID Application: Local Test"`, ""], [`${identity} (CSSMERR_TP_CERT_EXPIRED)`, ""]]) {
    assert.throws(() => selectDevelopmentIdentity(text, selected), /exactly one available Apple Development/);
  }
});

test("identity-selection failures never echo names, fingerprints or arbitrary input", () => {
  assert.throws(() => selectDevelopmentIdentity(identity, "PRIVATE-DATA"), (error) => {
    assert.equal(error.message.includes("PRIVATE-DATA"), false);
    assert.equal(error.message.includes(hash), false);
    assert.equal(error.message.includes("Local Test"), false);
    return true;
  });
});

test("only explicit independent build and probe operations are accepted", () => {
  assert.equal(parseOptions([]), "build");
  assert.equal(parseOptions(["--probe"]), "probe");
  assert.equal(parseOptions(["--rebuild"]), "rebuild");
  assert.throws(() => parseOptions(["--rebuild", "--probe"]));
  assert.equal(parseOptions(["--help"]), "help");
  assert.throws(() => parseOptions(["--build", "--probe"]));
  assert.throws(() => parseOptions(["--identity", "anything"]));
});

test("all output paths stay private and npm Electron runner gets a distribution alias", () => {
  const paths = signedDevPaths("/repo");
  for (const location of Object.values(paths)) assert.ok(location.startsWith("/repo/.data/computer-use-dev"));
  assert.equal(paths.host, "/repo/.data/computer-use-dev/OpenWork Local.app");
  assert.equal(paths.electronDist, "/repo/.data/computer-use-dev/electron-dist");
  assert.equal(paths.helper, `${paths.host}/Contents/Helpers/OpenWork Computer Use.app`);
});

test("signature metadata rejects ad-hoc, absent teams and non-development certificates", () => {
  const text = "Identifier=dev.openwork.local\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Apple Development: Local Test (ABCDEFGHIJ)";
  assert.equal(signatureMetadata(text).identifier, "dev.openwork.local");
  for (const invalid of ["", `${text}\nSignature=adhoc`, text.replace("ABCDEFGHIJ", "not set"), text.replace("Apple Development", "Developer ID Application")]) {
    assert.throws(() => signatureMetadata(invalid), /valid Apple Development team signature/);
  }
});

test("signing traverses copied code inside-out, ignores resources and follows no symlinks", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "openwork-signing-test-"));
  try {
    const app = path.join(directory, "Host.app");
    const framework = path.join(app, "Contents/Frameworks/Test.framework");
    const binary = path.join(framework, "Versions/A/Test");
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, Buffer.from("cffaedfe00000000", "hex"));
    writeFileSync(path.join(framework, "resource.txt"), "not executable code");
    symlinkSync("A", path.join(framework, "Versions/Current"));
    symlinkSync("Versions/Current/Test", path.join(framework, "Test"));
    assert.deepEqual(signingTargets(app), [binary, framework, app]);
    symlinkSync(directory, path.join(app, "escape"));
    assert.throws(() => signingTargets(app), /external symlink/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("probe environment strips responsibility bypass, Node and DYLD injection and credentials", () => {
  assert.deepEqual(probeEnvironment({ HOME: "/home/test", TMPDIR: "/tmp", LANG: "C", PATH: "/untrusted", NODE_OPTIONS: "--require secret", ELECTRON_RUN_AS_NODE: "1", DYLD_INSERT_LIBRARIES: "bad", OPENWORK_COMPUTER_USE_DISCLAIMED: "1", OPENWORK_COMPUTER_USE_HOST_PID: "123", OPENWORK_LOCAL_SIGN_IDENTITY: "secret", API_KEY: "secret" }), {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/home/test", TMPDIR: "/tmp", LANG: "C",
  });
});

test("initialize success requires expected id, protocol, server and capabilities", () => {
  assert.equal(validInitializeResponse(response), true);
  for (const invalid of [null, {}, { ...response, id: 2 }, { ...response, error: {} }, { ...response, result: {} }]) assert.equal(validInitializeResponse(invalid), false);
});

function fakeSpawn(reply, { exitCode = 0, ignoreEof = false } = {}) {
  const state = { writes: [], signals: [] };
  state.spawn = (executable, args, options) => {
    state.executable = executable;
    state.args = args;
    state.options = options;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        state.writes.push(chunk.toString());
        callback();
        if (reply !== null) queueMicrotask(() => child.stdout.write(reply));
      },
      final(callback) {
        callback();
        if (!ignoreEof) queueMicrotask(() => child.emit("close", exitCode, null));
      },
    });
    child.kill = (signal) => {
      state.signals.push(signal);
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    return child;
  };
  return state;
}

test("probe sends exactly initialize to mcp-embedded then closes stdin", async () => {
  const child = fakeSpawn(`${JSON.stringify(response)}\n`);
  assert.equal(await probeHelper("/private/helper", { spawnProcess: child.spawn }), true);
  assert.deepEqual(child.args, ["mcp-embedded"]);
  assert.deepEqual(child.writes, [`${JSON.stringify(initializeRequest)}\n`]);
  assert.deepEqual(child.options.stdio, ["pipe", "pipe", "ignore"]);
  assert.deepEqual(child.signals, []);
});

test("probe fails closed for malformed, failed, multiple, partial or oversized responses", async () => {
  for (const reply of ["bad\n", '{"jsonrpc":"2.0","id":1,"error":{}}\n', `${JSON.stringify(response)}\n{}\n`, `${JSON.stringify(response)}\ntrailing`, "x".repeat(65 * 1024)]) {
    const child = fakeSpawn(reply);
    assert.equal(await probeHelper("/private/helper", { spawnProcess: child.spawn }), false);
  }
  const child = fakeSpawn(`${JSON.stringify(response)}\n`, { exitCode: 1 });
  assert.equal(await probeHelper("/private/helper", { spawnProcess: child.spawn }), false);
});

test("probe timeout escalates cleanup and cannot report readiness", async () => {
  const child = fakeSpawn(null, { ignoreEof: true });
  assert.equal(await probeHelper("/private/helper", { spawnProcess: child.spawn, timeoutMs: 10, graceMs: 5 }), false);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("probe catches spawn failures without exposing native output", async () => {
  assert.equal(await probeHelper("/private/helper", { spawnProcess() { throw new Error("private data"); } }), false);
});
