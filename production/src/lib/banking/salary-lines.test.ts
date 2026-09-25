import { describe, it, expect } from "vitest";
import { parseSalaryNarration, matchEmployee, previousPeriod, titleCaseName } from "./salary-lines";

describe("parseSalaryNarration", () => {
  it("reads name and month + year", () => {
    expect(parseSalaryNarration("50100784857169-TPT-SALARY APR 2026-PAWAN", "2026-05-12")).toEqual({
      name: "PAWAN", period: "2026-04", periodFromNarration: true, fullAndFinal: false,
    });
  });

  it("reads a multi-word name", () => {
    expect(parseSalaryNarration("50100784857172-TPT-SALARY APR 2026-RANJEET RAJ", "2026-05-12"))
      .toMatchObject({ name: "RANJEET RAJ", period: "2026-04" });
  });

  it("month word without a year takes the latest such month not after the payment", () => {
    expect(parseSalaryNarration("50100784857182-TPT-EMP MAY SALARY-HITESH BABU", "2026-06-13"))
      .toMatchObject({ name: "HITESH BABU", period: "2026-05", periodFromNarration: true });
    expect(parseSalaryNarration("X-TPT-DEC SALARY-AMIT", "2026-01-05"))
      .toMatchObject({ period: "2025-12" });
  });

  it("no month → previous month, flagged as assumed", () => {
    expect(parseSalaryNarration("50100784857182-TPT-SALARY EMP-HITESH BABU", "2026-05-14"))
      .toMatchObject({ name: "HITESH BABU", period: "2026-04", periodFromNarration: false });
  });

  it("flags full and final", () => {
    expect(parseSalaryNarration("50100508749370-TPT-FULL N FINAL SALARY-KESHAV MALIK", "2026-04-16"))
      .toMatchObject({ name: "KESHAV MALIK", fullAndFinal: true, period: "2026-03" });
  });

  it("a payee named like a month is not read as the month", () => {
    expect(parseSalaryNarration("X-TPT-SALARY-MAY", "2026-07-02"))
      .toMatchObject({ name: "MAY", period: "2026-06", periodFromNarration: false });
  });

  it("IMPS / NEFT put the payee third", () => {
    expect(parseSalaryNarration("IMPS-622258187163-DARSHAN-PUNB-XXXXXXXXXX3174-JUNE SALARY", "2026-08-10"))
      .toMatchObject({ name: "DARSHAN", period: "2026-06", periodFromNarration: true });
    expect(parseSalaryNarration("IMPS-621856395591-PARDEEP SHARMA-ICIC-XXXXXXXX4658-SALARY", "2026-08-06"))
      .toMatchObject({ name: "PARDEEP SHARMA", period: "2026-07", periodFromNarration: false });
  });

  it("no readable name → null name, still a salary line", () => {
    expect(parseSalaryNarration("50100784857182-TPT-JUNE SALARY", "2026-07-02"))
      .toMatchObject({ name: null, period: "2026-06" });
  });

  it("ignores non-salary and advance lines", () => {
    expect(parseSalaryNarration("IMPS-612256087508-PRASHANT BHAIYA-FINO", "2026-05-02")).toBeNull();
    expect(parseSalaryNarration("X-TPT-SALARY ADVANCE-PAWAN", "2026-05-02")).toBeNull();
  });
});

describe("matchEmployee", () => {
  const emps = [
    { id: "1", name: "Pawan Kumar" },
    { id: "2", name: "Ranjeet Raj" },
    { id: "3", name: "Rahul Sharma" },
    { id: "4", name: "Rahul Verma" },
  ];
  it("exact name", () => expect(matchEmployee("RANJEET RAJ", emps)).toEqual({ kind: "match", id: "2" }));
  it("first name only, unique", () => expect(matchEmployee("PAWAN", emps)).toEqual({ kind: "match", id: "1" }));
  it("two candidates is ambiguous, not a pick", () =>
    expect(matchEmployee("RAHUL", emps)).toEqual({ kind: "ambiguous", ids: ["3", "4"] }));
  it("no one", () => expect(matchEmployee("HITESH BABU", emps)).toEqual({ kind: "none" }));
  it("null name", () => expect(matchEmployee(null, emps)).toEqual({ kind: "none" }));
});

describe("helpers", () => {
  it("previousPeriod wraps the year", () => expect(previousPeriod("2026-01-10")).toBe("2025-12"));
  it("titleCaseName", () => expect(titleCaseName("RANJEET RAJ")).toBe("Ranjeet Raj"));
});
