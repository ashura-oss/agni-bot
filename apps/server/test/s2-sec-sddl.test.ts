/**
 * Sprint 2 security round, item 3: an access list that cannot be read in full is not trusted. A NULL DACL
 * (`D:NO_ACCESS_CONTROL`: everyone has full access), an empty or unparsable one, and an entry of a type or with
 * flags the parser does not fully understand all count as writable by others.
 */
import { describe, expect, test } from "bun:test";
import { sddlWritableByOthers } from "../src/util/git-bash";

const OWN = "S-1-5-21-1111-2222-3333-1001";
const GOOD = `(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${OWN})`;

describe("a DACL that gives everyone access, or none that can be read, is writable", () => {
  const CASES: Array<[string, string]> = [
    ["a NULL DACL", "D:NO_ACCESS_CONTROL"],
    ["a NULL DACL with a protection flag", "D:PNO_ACCESS_CONTROL"],
    ["a NULL DACL after the owner and group", `O:${OWN}G:SYD:NO_ACCESS_CONTROL`],
    ["an empty DACL", "D:"],
    ["an empty protected DACL", "D:P"],
    ["an empty DACL with an inheritance flag", "D:AI"],
    ["an unknown DACL flag", `D:PZZ${GOOD}`],
    ["an entry that is not closed", "D:PAI(A;;FA;;;SY"],
    ["text between the entries", `D:PAI(A;;FA;;;SY)junk${GOOD}`],
    ["text after the entries", `D:PAI${GOOD}junk`],
    ["an entry with too few fields", "D:PAI(A;;FA;;SY)"],
    ["an entry with too many fields", "D:PAI(A;;FA;;;SY;;)"],
    ["an entry with no trustee", "D:PAI(A;;FA;;;)"],
    ["an allow entry that names an object", "D:PAI(A;;FA;{00000000-0000-0000-0000-000000000000};;SY)"],
    ["no D: at all", "O:BAG:SY"],
    ["an empty string", ""],
  ];
  for (const [name, sddl] of CASES) {
    test(`${name} is writable`, () => {
      expect(sddlWritableByOthers(sddl, OWN)).toBe(true);
    });
  }
});

describe("an entry the parser does not fully understand is writable, even for a trusted trustee", () => {
  const CASES: Array<[string, string]> = [
    ["a conditional allow (XA)", "D:PAI(XA;;FA;;;SY;(@User.Title==\"PM\"))"],
    ["a callback allow (ZA)", "D:PAI(ZA;;FA;;;SY)"],
    ["an object allow (OA)", "D:PAI(OA;;FA;;;SY)"],
    ["an object deny (OD)", `D:PAI(OD;;FA;;;WD)${GOOD}`],
    ["a conditional deny (XD)", `D:PAI(XD;;FA;;;WD;(@User.x==1))${GOOD}`],
    ["an audit entry in the DACL (AU)", `D:PAI(AU;SA;FA;;;WD)${GOOD}`],
    ["a mandatory label (ML)", `D:PAI(ML;;NW;;;S-1-16-4096)${GOOD}`],
    ["an unknown type", `D:PAI(ZZ;;FA;;;SY)${GOOD}`],
    ["unknown entry flags", "D:PAI(A;ZZ;FA;;;SY)"],
    ["an odd-length entry flags field", "D:PAI(A;OIC;FA;;;SY)"],
  ];
  for (const [name, sddl] of CASES) {
    test(`${name} is writable`, () => {
      expect(sddlWritableByOthers(sddl, OWN)).toBe(true);
    });
  }
});

describe("what was trusted before is still trusted", () => {
  test("the owner, SYSTEM and Administrators with full control, and a read-only grant to others", () => {
    expect(sddlWritableByOthers(`D:PAI${GOOD}(A;OICI;0x1200a9;;;BU)`, OWN)).toBe(false);
  });

  test("the owner's DACL with an owner and group section in front and a SACL behind", () => {
    expect(sddlWritableByOthers(`O:${OWN}G:SYD:PAI${GOOD}S:AI(ML;;NW;;;S-1-16-4096)`, OWN)).toBe(false);
  });

  test("a deny entry for someone is not a grant", () => {
    expect(sddlWritableByOthers(`D:PAI(D;;FA;;;WD)${GOOD}`, OWN)).toBe(false);
  });

  test("entry flags the system writes are understood", () => {
    expect(sddlWritableByOthers("D:PAI(A;OICIIOID;GA;;;SY)(A;CIIO;FA;;;BA)(A;NPSAFA;FA;;;BA)", OWN)).toBe(false);
  });
});
