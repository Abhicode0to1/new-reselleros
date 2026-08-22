import { describe, it, expect } from "vitest";
import { classifySender, listSenderCandidates, blockerText, type SenderCandidateInput } from "./sender-candidates";

const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

/* The two real accounts from the report: mail was leaving as pardeep@anutech.in and should
   leave as sales@anutech.in, and sales@ had no Google token at all. */
const pardeep: SenderCandidateInput = {
  userId: "u-pardeep", email: "pardeep@anutech.in", role: "owner",
  token: { google_email: "pardeep@anutech.in", refresh_token: "rt", scopes: `openid email ${SEND_SCOPE}` },
};
const sales: SenderCandidateInput = {
  userId: "u-sales", email: "sales@anutech.in", role: "sales_senior", token: null,
};

describe("classifySender", () => {
  it("accepts a connected account that granted the send scope", () => {
    expect(classifySender(pardeep)).toMatchObject({ eligible: true, blocker: null, sendsAs: "pardeep@anutech.in" });
  });

  it("rejects an account that never connected, and says so distinctly", () => {
    expect(classifySender(sales)).toMatchObject({ eligible: false, blocker: "not_connected" });
  });

  it("rejects a connected account that did not allow sending, as a DIFFERENT blocker", () => {
    /* The fix differs — reconnect, not connect — and telling somebody to redo work they
       have already done is how they stop trusting the screen. */
    const noScope = { ...pardeep, token: { google_email: "x@y.com", refresh_token: "rt", scopes: "openid email" } };
    expect(classifySender(noScope)).toMatchObject({ eligible: false, blocker: "no_send_scope" });
  });

  it("treats an unknown scope string as cannot-send", () => {
    /* A token granted before gmail.send existed authenticates perfectly and fails only at
       send time, in a cron, at night. provider.ts makes the same call. */
    for (const scopes of [null, "", "   "]) {
      const t = { ...pardeep, token: { google_email: "x@y.com", refresh_token: "rt", scopes } };
      expect(classifySender(t).eligible, JSON.stringify(scopes)).toBe(false);
    }
  });

  it("reports the GOOGLE address as what mail sends as, not the workspace login", () => {
    /* A login of sales@anutech.in connected to a personal Gmail would send from the
       personal one. Showing the login would hide that from the operator and from the
       customer's From line. */
    const mismatch: SenderCandidateInput = {
      userId: "u-x", email: "sales@anutech.in", role: "sales",
      token: { google_email: "darshan.personal@gmail.com", refresh_token: "rt", scopes: SEND_SCOPE },
    };
    const c = classifySender(mismatch);
    expect(c.sendsAs).toBe("darshan.personal@gmail.com");
    expect(c.loginEmail).toBe("sales@anutech.in");
  });

  it("never decides on the role", () => {
    /* An owner who has not connected cannot send; a sales rep who has, can. */
    const ownerNoToken = { ...pardeep, token: null };
    const repWithToken = { ...sales, token: { google_email: "sales@anutech.in", refresh_token: "rt", scopes: SEND_SCOPE } };
    expect(classifySender(ownerNoToken).eligible).toBe(false);
    expect(classifySender(repWithToken).eligible).toBe(true);
  });
});

describe("listSenderCandidates", () => {
  it("puts usable accounts first so the picker opens on a real choice", () => {
    const list = listSenderCandidates([sales, pardeep]);
    expect(list.map((c) => c.userId)).toEqual(["u-pardeep", "u-sales"]);
  });

  it("KEEPS the ineligible ones in the list", () => {
    /* "sales@ is not in the list" and "sales@ has not connected Google" send the operator
       to different places, and only the second is true. Hiding the row would have left the
       reporter hunting for a bug in the picker. */
    const list = listSenderCandidates([sales, pardeep]);
    expect(list).toHaveLength(2);
    expect(list.find((c) => c.userId === "u-sales")?.blocker).toBe("not_connected");
  });

  it("orders ties by login so the list does not reshuffle", () => {
    const a = { ...sales, userId: "a", email: "aaa@x.in" };
    const b = { ...sales, userId: "b", email: "bbb@x.in" };
    expect(listSenderCandidates([b, a]).map((c) => c.userId)).toEqual(["a", "b"]);
  });

  it("handles an empty workspace without throwing", () => {
    expect(listSenderCandidates([])).toEqual([]);
  });
});

describe("blockerText", () => {
  it("says who has to act, because it cannot be done for them", () => {
    /* OAuth belongs to the person. The owner cannot connect a teammate's Google. */
    expect(blockerText("not_connected")).toMatch(/themselves/i);
    expect(blockerText("no_send_scope")).toMatch(/reconnect/i);
  });

  it("gives the two blockers different instructions", () => {
    expect(blockerText("not_connected")).not.toBe(blockerText("no_send_scope"));
  });
});
