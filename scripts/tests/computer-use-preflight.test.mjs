import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assessTrust, countIdentities, parseSignature } from "../computer-use-preflight.mjs";

const signed = (id, team = "ABCDEFGHIJ") => parseSignature(`Identifier=${id}\nTeamIdentifier=${team}\nAuthority=Apple Development`);

test("ad-hoc and absent teams cannot pass trust prerequisites", () => {
  const host = parseSignature("Identifier=Electron\nSignature=adhoc\nTeamIdentifier=not set");
  const helper = parseSignature("Identifier=helper\nSignature=adhoc\nTeamIdentifier=not set");
  assert.deepEqual(assessTrust(host, helper, "test.host"), ["host_has_no_team_signature", "helper_has_no_team_signature", "host_identifier_mismatch"]);
});
test("missing bundles are reported without assuming permission failures", () => {
  assert.deepEqual(assessTrust(parseSignature("", false), parseSignature("", false), "test.host"), ["host_missing", "helper_missing"]);
});
test("valid matching identities satisfy prerequisites, not runtime readiness", () => {
  assert.deepEqual(assessTrust(signed("test.host"), signed("test.helper"), "test.host"), []);
});
test("a differently signed or identified host is refused", () => {
  assert.deepEqual(assessTrust(signed("wrong.host", "KLMNOPQRST"), signed("test.helper"), "test.host"), ["host_identifier_mismatch", "signing_team_mismatch"]);
});
test("identity summary contains counts, not certificate owners or hashes", () => {
  const summary = countIdentities('1) HASH "Apple Development: Example Owner (ABCDEFGHIJ)"\n2) HASH "Developer ID Application: Example Owner (ABCDEFGHIJ)"');
  assert.deepEqual(summary, { development: 1, distribution: 1 });
  assert.equal(JSON.stringify(summary).includes("Owner"), false);
});
test("malformed team identities are never used in a requirement", () => {
  assert.equal(parseSignature('Identifier=test\nTeamIdentifier=ABC" or true').team, null);
});

test("helper build rejects untrusted identifiers before building or signing", () => {
  const script = fileURLToPath(new URL("../../apps/desktop/scripts/prepare-computer-use-helper.mjs", import.meta.url));
  for (const [flag, value] of [["--host-bundle-id", "host\" or true"], ["--bundle-id", "bad<xml>"], ["--display-name", "bad<xml>"]]) {
    const result = spawnSync(process.execPath, [script, flag, value], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid (bundle identifier|helper display name)/);
  }
});
