import { describe, expect, test } from "bun:test";
import { resolveLocalGitChanges } from "../src/react-app/domains/session/panel/git-changes-feature";

describe("local Git changes rollout", () => {
  test("requires an explicit local rollout", () => {
    expect(resolveLocalGitChanges(false, "http://127.0.0.1:4000", true, false)).toBe(false);
    expect(resolveLocalGitChanges(true, "http://127.0.0.1:4000", true, false)).toBe(true);
  });
  test("does not override managed or remote deployment policy", () => {
    expect(resolveLocalGitChanges(true, "http://127.0.0.1:4000", true, true)).toBe(false);
    expect(resolveLocalGitChanges(true, "https://example.com", true, false)).toBe(false);
    expect(resolveLocalGitChanges(true, "http://localhost:4000", false, false)).toBe(false);
  });
  test("rejects malformed URLs and localhost lookalikes", () => {
    for (const url of ["", "localhost", "http://localhost.example.com", "file:///localhost"]) {
      expect(resolveLocalGitChanges(true, url, true, false)).toBe(false);
    }
    expect(resolveLocalGitChanges(true, "http://[::1]:4000", true, false)).toBe(true);
  });
});
