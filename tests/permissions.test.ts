import { describe, it, expect } from "vitest";
import { canWrite, assertCanWrite, PermissionDeniedError } from "../src/permissions.js";
import type { Permissions } from "../src/types.js";

const ROOT = "/proj";
function perms(p: Partial<Permissions>): Permissions {
  return {
    CODEX: { mode: "READ", scope: [] },
    GEMINI: { mode: "READ", scope: [] },
    ...p,
  };
}

describe("permission scope matching", () => {
  it("CLAUDE always has WRITE everywhere", () => {
    const r = canWrite(perms({}), "CLAUDE", "/proj/anywhere/x.ts", ROOT);
    expect(r.allowed).toBe(true);
  });

  it("READ-only agent is denied for any path", () => {
    const r = canWrite(perms({ CODEX: { mode: "READ", scope: ["src/**"] } }), "CODEX", "/proj/src/a.ts", ROOT);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/READ/);
  });

  it("WRITE with empty scope denies everything", () => {
    const r = canWrite(perms({ CODEX: { mode: "WRITE", scope: [] } }), "CODEX", "/proj/src/a.ts", ROOT);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/empty/);
  });

  it("WRITE with matching glob allows", () => {
    const r = canWrite(
      perms({ CODEX: { mode: "WRITE", scope: ["src/api/**"] } }),
      "CODEX",
      "/proj/src/api/zip.ts",
      ROOT,
    );
    expect(r.allowed).toBe(true);
  });

  it("WRITE outside scope is denied", () => {
    const r = canWrite(
      perms({ CODEX: { mode: "WRITE", scope: ["src/api/**"] } }),
      "CODEX",
      "/proj/src/web/page.tsx",
      ROOT,
    );
    expect(r.allowed).toBe(false);
  });

  it('"**" matches everything', () => {
    const r = canWrite(
      perms({ GEMINI: { mode: "WRITE", scope: ["**"] } }),
      "GEMINI",
      "/proj/anywhere/deep/file.tsx",
      ROOT,
    );
    expect(r.allowed).toBe(true);
  });

  it("assertCanWrite throws PermissionDeniedError", () => {
    expect(() =>
      assertCanWrite(
        perms({ CODEX: { mode: "READ", scope: [] } }),
        "CODEX",
        "/proj/src/a.ts",
        ROOT,
      ),
    ).toThrow(PermissionDeniedError);
  });
});
