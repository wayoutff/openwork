import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalComputerAdapter } from "./computer-local.mjs";

test("local Mac adapter explicitly forwards keep-front and cannot inherit an opt-in", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "computer-local-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "helper");
  // A harmless MCP stand-in: no native helper, permissions, windows or input.
  await writeFile(binary, `#!${process.execPath}
const { createInterface } = require("node:readline");
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ protocolVersion: "openwork.computer-use/1", ok: true, supported: true, accessibility: true, screenRecording: true }));
} else {
  const tools = ["computer_discover", "computer_open_session", "computer_observe", "computer_zoom", "computer_act", "computer_session_status", "computer_close_session"];
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.method === "initialize"
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "openwork-computer-use", version: "1.0.0" } }
      : request.method === "tools/list"
      ? { tools: tools.map(name => ({ name, inputSchema: { type: "object", additionalProperties: false } })) }
      : { content: [{ type: "text", text: JSON.stringify({ keepFront: process.env.OPENWORK_COMPUTER_USE_KEEP_FRONT, delivery: process.env.OPENWORK_COMPUTER_USE_DELIVERY }) }] };
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
}
`, { mode: 0o755 });
  const previous = { binary: process.env.OPENWORK_COMPUTER_USE_BINARY, keepFront: process.env.OPENWORK_COMPUTER_USE_KEEP_FRONT };
  t.after(() => {
    for (const [key, value] of [["OPENWORK_COMPUTER_USE_BINARY", previous.binary], ["OPENWORK_COMPUTER_USE_KEEP_FRONT", previous.keepFront]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.OPENWORK_COMPUTER_USE_BINARY = binary;
  process.env.OPENWORK_COMPUTER_USE_KEEP_FRONT = "1";
  const adapter = createLocalComputerAdapter({ platform: "darwin", osRelease: "23.0.0" });
  assert.equal(adapter.id, "this-mac");
  assert.equal(adapter.placement, "local");
  for (const [options, expected] of [[{}, "0"], [{ keepFront: false }, "0"], [{ keepFront: true }, "1"], [{ keepFront: "1" }, "0"], [{ keepFront: true, background: true }, "1"]]) {
    const transport = await adapter.connect(options);
    try {
      const result = await transport.callTool("computer_discover", {});
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.keepFront, expected);
      assert.equal(value.delivery, options.background ? "background" : undefined);
    } finally { await transport.close(); }
  }
});
