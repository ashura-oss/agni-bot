/**
 * S3-9 item 5: device-token checks fail closed. A device whose timestamps
 * cannot be read is not trusted, and revoking by a prefix never picks one of
 * several devices at random.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { AmbiguousDevicePrefixError, mintToken, revokeDevice, verifyToken } from "../src/auth/tokens";
import { openDatabase } from "../src/db";

let db: Database;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => db.close());

describe("verifyToken with a timestamp it cannot read", () => {
  test("a normal device passes (control)", async () => {
    const { token, device } = await mintToken(db, "phone");
    expect((await verifyToken(db, token))?.id).toBe(device.id);
  });

  test("an unparsable last_seen_at rejects the token", async () => {
    const { token, device } = await mintToken(db, "phone");
    db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", ["not a date", device.id]);
    expect(await verifyToken(db, token)).toBeNull();
  });

  test("an unparsable created_at on a device never seen rejects the token", async () => {
    const { token, device } = await mintToken(db, "phone");
    db.run("UPDATE devices SET created_at = ?, last_seen_at = NULL WHERE id = ?", ["", device.id]);
    expect(await verifyToken(db, token)).toBeNull();
  });

  test("an unparsable created_at is refused even when last_seen_at is fine", async () => {
    const { token, device } = await mintToken(db, "phone");
    db.run("UPDATE devices SET created_at = ?, last_seen_at = ? WHERE id = ?", ["??", new Date().toISOString(), device.id]);
    expect(await verifyToken(db, token)).toBeNull();
  });
});

describe("revokeDevice with a prefix that matches more than one device", () => {
  async function twoWithSharedPrefix(): Promise<void> {
    const a = await mintToken(db, "phone");
    const b = await mintToken(db, "laptop");
    db.run("UPDATE devices SET id = 'dev_shared_1' WHERE id = ?", [a.device.id]);
    db.run("UPDATE devices SET id = 'dev_shared_2' WHERE id = ?", [b.device.id]);
  }
  const revoked = (): number => db.query<{ n: number }, []>("SELECT count(*) AS n FROM devices WHERE revoked_at IS NOT NULL").get()!.n;

  test("is refused, with the count, and revokes nothing", async () => {
    await twoWithSharedPrefix();
    expect(() => revokeDevice(db, "dev_shared")).toThrow(AmbiguousDevicePrefixError);
    expect(() => revokeDevice(db, "dev_")).toThrow(/2 devices/);
    expect(revoked()).toBe(0);
  });

  test("a longer prefix that names one device still revokes it", async () => {
    await twoWithSharedPrefix();
    expect(revokeDevice(db, "dev_shared_2")?.name).toBe("laptop");
    expect(revoked()).toBe(1);
  });

  test("an exact id wins over a longer id that starts with it", async () => {
    const a = await mintToken(db, "phone");
    const b = await mintToken(db, "laptop");
    db.run("UPDATE devices SET id = 'dev_abc' WHERE id = ?", [a.device.id]);
    db.run("UPDATE devices SET id = 'dev_abcdef' WHERE id = ?", [b.device.id]);
    expect(revokeDevice(db, "dev_abc")?.name).toBe("phone");
    expect(revoked()).toBe(1);
  });

  test("a prefix that matches nothing is still just null", async () => {
    await twoWithSharedPrefix();
    expect(revokeDevice(db, "dev_other")).toBeNull();
  });
});
