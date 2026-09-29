import { describe, expect, it } from "vitest";
import { firstTouchDue, firstTouchTask } from "./lead-finder";

// IST = UTC+5:30. 2026-09-28 is a Monday; 2026-10-03 a Saturday; 2026-10-04 a Sunday.
const ist = (s: string) => new Date(s + "+05:30");

describe("firstTouchDue — business hours IST", () => {
  it("before 10:00 → 11:00 same day", () => expect(firstTouchDue(ist("2026-09-28T08:15:00")).toISOString()).toBe(ist("2026-09-28T11:00:00").toISOString()));
  it("during the day → one hour later", () => expect(firstTouchDue(ist("2026-09-28T14:20:00")).toISOString()).toBe(ist("2026-09-28T15:20:00").toISOString()));
  it("after 17:00 → 11:00 next day", () => expect(firstTouchDue(ist("2026-09-28T19:05:00")).toISOString()).toBe(ist("2026-09-29T11:00:00").toISOString()));
  it("Saturday evening skips Sunday → Monday 11:00", () => expect(firstTouchDue(ist("2026-10-03T18:30:00")).toISOString()).toBe(ist("2026-10-05T11:00:00").toISOString()));
  it("Sunday morning → Monday 11:00", () => expect(firstTouchDue(ist("2026-10-04T09:00:00")).toISOString()).toBe(ist("2026-10-05T11:00:00").toISOString()));
  it("late night UTC that is already the next IST day", () => expect(firstTouchDue(new Date("2026-09-28T20:00:00Z")).toISOString()).toBe(ist("2026-09-29T11:00:00").toISOString()));
});

describe("firstTouchTask", () => {
  const c = { company: "Taksh IT", pitch: "Workspace se trust badhega", fit_reason: "Basic email", domain: "taksh.in" };
  it("phone → call task with number and pitch in notes", () => {
    const t = firstTouchTask(c, { phone: "+919560602339", email: "sales@taksh.in" });
    expect(t.kind).toBe("call");
    expect(t.title).toBe("Call karo: Taksh IT");
    expect(t.notes).toContain("Phone: +919560602339");
    expect(t.notes).toContain("Kya bolna hai: Workspace se trust badhega");
  });
  it("email only → email task", () => expect(firstTouchTask(c, { phone: null, email: "a@taksh.in" }).kind).toBe("email"));
});
