import { describe, expect, test } from "bun:test";
import { resolveLocalComputerFeature } from "../src/react-app/domains/session/status/local-computer-feature";

const local = { hostEligible: true, optedIn: true, signedOut: true, organizationReady: false, serverUrl: "http://127.0.0.1:1234", key: "computerUse" };
describe("local computer use opt-in", () => {
  test("enables only the local foreground computer", () => {
    expect(resolveLocalComputerFeature(local)).toBe(true);
    for (const key of ["remoteComputers", "computerUseBackground", "mermaidZoom"]) {
      expect(resolveLocalComputerFeature({ ...local, key })).toBe(false);
    }
  });
  test("requires explicit opt-in and an eligible desktop host", () => {
    expect(resolveLocalComputerFeature({ ...local, optedIn: false })).toBe(false);
    expect(resolveLocalComputerFeature({ ...local, hostEligible: false })).toBe(false);
  });
  test("never overrides signed-in or pending organization policies", () => {
    expect(resolveLocalComputerFeature({ ...local, signedOut: false })).toBe(false);
    expect(resolveLocalComputerFeature({ ...local, organizationReady: true })).toBe(false);
  });
  test("rejects remote or malformed server endpoints", () => {
    for (const serverUrl of ["https://example.com", "http://localhost.example.com", "file:///localhost", ""]) {
      expect(resolveLocalComputerFeature({ ...local, serverUrl })).toBe(false);
    }
  });
});
