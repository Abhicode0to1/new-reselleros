import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   Rail par do number saath-saath baithte hain, aur is page ne unhe do baar ek doosre
   ko jhutlate hue dikhaya hai:

     30 Aug, subah   rail "17" (mail)      · header "(12)" (baat-cheet)
     30 Aug, dopahar rail "2"  (unread)    · header "(14)" (baat-cheet)

   Dono baar dono number SAHI the. Dono baar Pardeep ne poochha "kya ye theek hai?" —
   aur wo sawaal hi saboot hai ki theek nahi tha.

   Pehli baar ki jad `folderCounts` thi (mail ginta tha) — wo theek ho chuki hai aur uske
   apne test folders.test.ts me hain. Doosri baar ki jad YE page thi: rail ya to unread
   dikhata tha YA kul, kabhi dono nahi. Unread aate hi kul ginti gायab ho jati thi.
   ───────────────────────────────────────────────────────────────────────────── */

const PAGE = readFileSync(
  join(process.cwd(), "src", "app", "(app)", "enquiries", "page.tsx"), "utf8");

describe("folder rail — kul ginti kabhi gायab nahi hoti", () => {
  it("unread aur kul ek DOOSRE ki jagah nahi lete", () => {
    /* Purana code:  badge > 0 ? <Badge>{badge}</Badge> : count > 0 && <span>{count}</span>
       Us ternary ka lautna hi bug ka lautna hai. */
    expect(PAGE).not.toMatch(/badge > 0\s*\n?\s*\?\s*<Badge/);
  });

  it("dono alag-alag shart par dikhte hain", () => {
    expect(PAGE).toMatch(/\{badge > 0 && \(/);
    expect(PAGE).toMatch(/\{count > 0 && \(/);
  });

  it("har folder ke button par naam hai jo batata hai kaunsa number kya hai", () => {
    /* "2  14" bina naam ke sirf do ginti hain jinme se ek galat lagti hai. Hover par
       aur screen reader par dono ko naam milna chahiye — CLAUDE.md §8. */
    expect(PAGE).toMatch(/title=\{`\$\{f\.label\}/);
    expect(PAGE).toMatch(/aria-label=\{`\$\{f\.label\}/);
    for (const word of ["conversation", "unread"]) {
      expect(PAGE).toContain(word);
    }
  });

  it("list ka header wahi ginti dikhata hai jo rail dikhata hai", () => {
    /* Dono `threads.length` / `counts[f.id]` par baithe hain, aur dono ab baat-cheet
       ginte hain (lib/inbound/folders.ts). Agar koi ise wapas mail par le jaye, folders
       ke apne test laal ho jayenge — ye sirf ye pakadta hai ki header abhi bhi thread
       hi gin raha hai. */
    expect(PAGE).toMatch(/\{threads\.length > 0 && <span[^>]*>\(\{threads\.length\}\)<\/span>\}/);
  });
});
