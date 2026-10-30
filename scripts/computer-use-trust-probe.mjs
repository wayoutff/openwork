import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// An allowlist also removes the helper's responsibility/host-PID bypass markers.
export function probeEnvironment(env = process.env) {
  const result = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING"]) {
    if (env[key]) result[key] = env[key];
  }
  return result;
}

export const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "openwork-local-trust-probe", version: "1.0.0" },
  },
};

export function validInitializeResponse(message) {
  return message?.jsonrpc === "2.0" && message.id === 1 && !message.error
    && message.result?.protocolVersion === initializeRequest.params.protocolVersion
    && message.result?.serverInfo?.name === "openwork-computer-use"
    && typeof message.result?.capabilities?.tools === "object"
    && message.result.capabilities.tools !== null;
}

export function probeHelper(executable, { spawnProcess = spawn, timeoutMs = 10_000, graceMs = 1_000 } = {}) {
  return new Promise((resolveProbe) => {
    let child;
    let response = false;
    let failed = false;
    let stopping = false;
    let settled = false;
    let pending = "";
    let bytes = 0;
    let terminateTimer;
    let killTimer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(terminateTimer);
      clearTimeout(killTimer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      resolveProbe(ok);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      terminateTimer = setTimeout(() => child.kill("SIGTERM"), graceMs);
      killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs * 2);
    };
    const interrupt = () => { failed = true; stop(); };
    const timeout = setTimeout(() => { failed = true; stop(); }, timeoutMs);
    try {
      child = spawnProcess(executable, ["mcp-embedded"], {
        env: probeEnvironment(), stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      finish(false);
      return;
    }
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.once("error", () => finish(false));
    child.once("close", (code, signal) => finish(response && !failed && !pending && code === 0 && !signal));
    child.stdin.on("error", () => { failed = true; stop(); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) { failed = true; stop(); return; }
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          if (response || !validInitializeResponse(JSON.parse(line))) failed = true;
          else response = true;
        } catch { failed = true; }
        stop();
      }
    });
    // Exactly one protocol request. No tool listing/calls or initialized notification.
    child.stdin.write(`${JSON.stringify(initializeRequest)}\n`);
  });
}

export async function main() {
  const { app } = await import("electron");
  let ok = false;
  try {
    app.dock?.hide();
    const resources = path.dirname(fileURLToPath(import.meta.url));
    if (!process.argv.includes("--openwork-trust-probe") || app.isPackaged
      || path.resolve(process.resourcesPath) !== resources) throw new Error("Invalid probe invocation");
    app.setPath("userData", path.resolve(resources, "../../..", "probe-profile"));
    await app.whenReady();
    ok = await probeHelper(path.resolve(resources, "../Helpers/OpenWork Computer Use.app/Contents/MacOS/ComputerUse"));
  } catch { /* Do not expose native errors, environment or certificate metadata. */ }
  process.stdout.write(`${JSON.stringify({ status: ok ? "live_trust_passed" : "live_trust_failed", unpackaged: !app.isPackaged })}\n`, () => app.exit(ok ? 0 : 1));
}

if (process.versions.electron && process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
