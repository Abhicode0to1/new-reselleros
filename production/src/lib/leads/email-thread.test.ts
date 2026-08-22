import { describe, it, expect } from "vitest";
import { buildEmailThread, summariseThread, type ThreadRow } from "./email-thread";
import { SENT_REPLY_STATUS } from "@/lib/inbound/sent";

/* Shapes taken from the real table. An inbound message carries from_email; a reply we sent
   carries to_email with from_email null and status 'reply_sent' — the convention
   lib/inbound/sent.ts documents. */
const inbound = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "in-1", lead_id: "L-1", status: "new",
  from_email: "ankit@xyz.com", to_email: null,
  subject: "About your inquiry", body_text: "Do you support 20 mailboxes?", body_html: null,
  created_at: "2026-08-22T10:00:00Z", ...over,
});

const sent = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "out-1", lead_id: "L-1", status: SENT_REPLY_STATUS,
  from_email: null, to_email: "ankit@xyz.com",
  subject: "Re: About your inquiry", body_text: "Yes — here is a quote.", body_html: null,
  created_at: "2026-08-22T11:00:00Z", ...over,
});

describe("buildEmailThread", () => {
  it("puts both sides in one thread, oldest first", () => {
    const t = buildEmailThread([sent(), inbound()], "L-1");
    expect(t.map((m) => m.id)).toEqual(["in-1", "out-1"]);
    expect(t.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
  });

  it("reads the counterparty from the side the message came from", () => {
    /* Inbound: who wrote to us. Outbound: who we wrote to. The tenant's own address is on
       neither row — sent replies leave from the connected Google account, which is why
       from_email is null there (lib/inbound/sent.ts). */
    const t = buildEmailThread([inbound(), sent()], "L-1");
    expect(t[0].counterparty).toBe("ankit@xyz.com");
    expect(t[1].counterparty).toBe("ankit@xyz.com");
  });

  it("carries the body, which is the whole point of the tab", () => {
    /* Before the Sent row existed the screen could say "you replied on 18 Aug" and nothing
       more. Knowing WHAT was said is the useful fact. */
    const t = buildEmailThread([sent()], "L-1");
    expect(t[0].body).toBe("Yes — here is a quote.");
  });

  it("keeps only this lead's mail", () => {
    const t = buildEmailThread([inbound(), inbound({ id: "in-2", lead_id: "L-2" })], "L-1");
    expect(t.map((m) => m.id)).toEqual(["in-1"]);
  });

  it("does NOT thread by matching address", () => {
    /* Two leads can share an info@ address. Threading on the string would merge two
       customers' correspondence, which is not a display bug. */
    const other = inbound({ id: "in-3", lead_id: "L-9", from_email: "ankit@xyz.com" });
    expect(buildEmailThread([other], "L-1")).toEqual([]);
  });

  it("returns nothing when there is no lead", () => {
    expect(buildEmailThread([inbound()], null)).toEqual([]);
    expect(buildEmailThread([inbound()], undefined)).toEqual([]);
  });

  it("breaks a timestamp tie by id, so the order does not reshuffle between refetches", () => {
    const a = sent({ id: "aaa", created_at: "2026-08-22T11:00:00Z" });
    const b = sent({ id: "bbb", created_at: "2026-08-22T11:00:00Z" });
    expect(buildEmailThread([b, a], "L-1").map((m) => m.id)).toEqual(["aaa", "bbb"]);
    expect(buildEmailThread([a, b], "L-1").map((m) => m.id)).toEqual(["aaa", "bbb"]);
  });

  it("survives a null timestamp without dropping the message", () => {
    /* Losing a message because a column was null is the failure this whole tab exists to
       stop — a disappeared email is indistinguishable from no email. */
    const t = buildEmailThread([inbound({ created_at: "" }), sent()], "L-1");
    expect(t).toHaveLength(2);
  });

  it("never hands back body_html, and says why the body is empty", () => {
    /* body_html is attacker-controlled — anyone can email this address — so rendering it
       would put a stranger's markup inside the operator's session. The panel gets a flag
       instead of the html, and shows a line rather than an empty bubble. */
    const htmlOnly = inbound({ id: "in-5", body_text: null, body_html: "<b>hi</b><script>x()</script>" });
    const [m] = buildEmailThread([htmlOnly], "L-1");
    expect(m.body).toBeNull();
    expect(m.htmlOnly).toBe(true);
    expect(JSON.stringify(m)).not.toContain("script");
  });

  it("treats a whitespace-only body as no body", () => {
    const blank = inbound({ id: "in-6", body_text: "   \n  ", body_html: null });
    const [m] = buildEmailThread([blank], "L-1");
    expect(m.body).toBeNull();
    expect(m.htmlOnly).toBe(false);
  });

  it("prefers plain text when both are present", () => {
    const both = inbound({ id: "in-7", body_text: "plain", body_html: "<b>rich</b>" });
    const [m] = buildEmailThread([both], "L-1");
    expect(m.body).toBe("plain");
    expect(m.htmlOnly).toBe(false);
  });

  it("reads direction from the status marker, not from a null from_email", () => {
    /* An inbound row with no sender must not be mistaken for something we sent. */
    const orphan = inbound({ id: "in-4", from_email: null });
    const t = buildEmailThread([orphan], "L-1");
    expect(t[0].direction).toBe("inbound");
    expect(t[0].counterparty).toBeNull();
  });
});

describe("summariseThread", () => {
  it("counts each side", () => {
    const s = summariseThread(buildEmailThread([inbound(), sent()], "L-1"));
    expect(s).toMatchObject({ total: 2, inbound: 1, outbound: 1, awaitingFirstInbound: false });
    expect(s.latest?.id).toBe("out-1");
  });

  it("flags a thread the customer has never written into", () => {
    /* This is the state the drawer must explain rather than leave blank: we have emailed
       them, they have not replied, so there is no thread to reply INTO. */
    const s = summariseThread(buildEmailThread([sent()], "L-1"));
    expect(s.awaitingFirstInbound).toBe(true);
    expect(s.outbound).toBe(1);
  });

  it("is empty and honest when nothing has been exchanged", () => {
    const s = summariseThread([]);
    expect(s).toEqual({ total: 0, inbound: 0, outbound: 0, awaitingFirstInbound: true, latest: null });
  });
});
