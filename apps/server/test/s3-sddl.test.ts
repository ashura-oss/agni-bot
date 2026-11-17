/**
 * S3-9 item 8: the owner-only check reads an SDDL string and must fail closed.
 * Anything that is not exactly "protected DACL with one full-control entry for
 * this user" is NOT owner-only: no DACL at all, a NULL DACL, an empty or broken
 * string, another account, a deny entry, an entry type this parser does not know.
 */
import { describe, expect, test } from "bun:test";
import { isOwnerOnlySddl } from "../src/util/windows-acl";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER = "S-1-5-21-1111111111-2222222222-3333333333-1002";
const dir = (text: string) => isOwnerOnlySddl(text, SID, true);
const file = (text: string) => isOwnerOnlySddl(text, SID, false);

describe("isOwnerOnlySddl accepts exactly the owner-only shape", () => {
  test("a protected DACL with one full-control entry for this user, as icacls /save prints it", () => {
    expect(dir(`D:P(A;OICI;FA;;;${SID})`)).toBe(true);
    expect(dir(`D:PAI(A;OICI;FA;;;${SID})`)).toBe(true);
    expect(file(`D:P(A;;FA;;;${SID})`)).toBe(true);
    // icacls /save writes a path line first, then the DACL, with CRLF line ends.
    expect(dir(`C:\home\r\nD:P(A;OICI;FA;;;${SID})\r\n`)).toBe(true);
  });

  test("a directory needs the inherit flags and a file must not have them", () => {
    expect(dir(`D:P(A;;FA;;;${SID})`)).toBe(false);
    expect(file(`D:P(A;OICI;FA;;;${SID})`)).toBe(false);
  });
});

describe("isOwnerOnlySddl fails closed", () => {
  test("no access control, a NULL DACL, and flags with no entries are not owner-only", () => {
    for (const text of ["D:NO_ACCESS_CONTROL", "D:PNO_ACCESS_CONTROL", "D:PAINO_ACCESS_CONTROL", "D:NULL", "D:P", "D:PAI", "D:", "D:()"]) {
      expect({ text, dir: dir(text), file: file(text) }).toEqual({ text, dir: false, file: false });
    }
  });

  test("empty, missing and unparsable text is not owner-only", () => {
    for (const text of ["", "   ", "\r\n", "C:\home", "garbage", "D:P(", `D:P(A;OICI;FA;;;${SID}`, `D:P)A;OICI;FA;;;${SID}(`, `D:P(A;OICI;FA;;;${SID})junk`, `D:Pjunk(A;OICI;FA;;;${SID})`, "\u0000\u0000"]) {
      expect({ text, ok: dir(text) }).toEqual({ text, ok: false });
    }
  });

  test("an unprotected DACL (inherited entries can follow) is not owner-only, even with the right entry", () => {
    expect(dir(`D:(A;OICI;FA;;;${SID})`)).toBe(false);
    expect(dir(`D:AI(A;OICI;FA;;;${SID})`)).toBe(false);
  });

  test("another account, a second entry, a deny entry or less than full control is not owner-only", () => {
    expect(dir(`D:P(A;OICI;FA;;;${OTHER})`)).toBe(false);
    expect(dir(`D:P(A;OICI;FA;;;${SID})(A;OICI;FA;;;SY)`)).toBe(false);
    expect(dir(`D:P(A;OICI;FA;;;${SID})(A;OICI;FR;;;WD)`)).toBe(false);
    expect(dir(`D:P(D;OICI;FA;;;${SID})`)).toBe(false);
    expect(dir(`D:P(A;OICI;FR;;;${SID})`)).toBe(false);
    expect(dir("D:P(A;OICI;FA;;;WD)")).toBe(false);
  });

  test("an entry type the parser does not know is not owner-only, however it looks", () => {
    for (const ace of [`(OA;OICI;FA;;;${SID})`, `(XA;OICI;FA;;;${SID};(Member_of{SID(WD)}))`, `(ZZ;OICI;FA;;;${SID})`, `(AU;OICI;FA;;;${SID})`, `(A;OICI;FA;;;${SID};)`, `(a;OICI;FA;;;${SID})`]) {
      expect({ ace, ok: dir(`D:P${ace}`) }).toEqual({ ace, ok: false });
    }
    // An unknown entry next to the right one is still not owner-only.
    expect(dir(`D:P(A;OICI;FA;;;${SID})(XX;;;;;WD)`)).toBe(false);
  });

  test("more than one DACL in the text is not owner-only", () => {
    expect(dir(`D:P(A;OICI;FA;;;${SID})\r\nD:P(A;OICI;FA;;;WD)`)).toBe(false);
  });

  test("the owner and group sections of a full descriptor are not part of an icacls DACL line, so the line is refused", () => {
    expect(dir(`O:${SID}G:${SID}D:P(A;OICI;FA;;;${SID})`)).toBe(false);
    expect(dir(`D:P(A;OICI;FA;;;${SID})S:(AU;SA;FA;;;WD)`)).toBe(false);
  });
});
