/**
 * Windows has no POSIX mode bits, so "private to the owner" is an ACL. This
 * reads a path's ACL with `icacls /save` and asserts that the only access
 * entries grant full control to the current user (nobody else, no inherited
 * Users/Everyone entry).
 */
import { expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentUserSid, windowsSystemTool } from "../src/util/windows-acl";

export function aclEntries(path: string): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "agni-acl-"));
  try {
    const out = join(scratch, "acl.txt");
    execFileSync(windowsSystemTool("icacls"), [path, "/save", out, "/q"], { stdio: "pipe", windowsHide: true });
    return readFileSync(out, "utf16le").match(/\([^)]*\)/g) ?? [];
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function expectOwnerOnlyAcl(path: string): void {
  const sid = currentUserSid();
  const entries = aclEntries(path);
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry.startsWith("(A;")).toBe(true);
    expect(entry).toContain(`;FA;;;${sid})`);
  }
}

/**
 * Run `fn` with SystemRoot pointing at a drive-absolute path that has no
 * System32, so every icacls/whoami call fails the way it does on a volume
 * that cannot hold ACLs. Windows only: elsewhere the ACL step is a no-op.
 */
export function withFailingAcl<T>(fn: () => T): T {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = "C:\\agni-no-such-windows";
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  }
}

export async function withFailingAclAsync<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = "C:\\agni-no-such-windows";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  }
}

/** The owner-only assertion for the platform: an ACL on Windows, mode bits elsewhere. */
export function expectPrivate(path: string, posixMode: number): void {
  if (process.platform === "win32") expectOwnerOnlyAcl(path);
  else expect(statSync(path).mode & 0o777).toBe(posixMode);
}
