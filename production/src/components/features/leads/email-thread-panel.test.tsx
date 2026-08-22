// @vitest-environment jsdom
//
// The assembly rules live in lib/leads/email-thread.test.ts. What is checked here is what
// the operator actually ends up reading — and it exists because this panel cannot be
// browser-verified today: the ANUTECH tenant has zero leads after the data clear, so the
// running app has no drawer to open. Same reason margin-alerts-card.test.tsx exists.
//
// This is a real substitute, not a stand-in: the same component, really rendered, with the
// rows a real thread would carry.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EmailThreadPanel } from "./email-thread-panel";
import { buildEmailThread, summariseThread, type ThreadRow } from "@/lib/leads/email-thread";
import { SENT_REPLY_STATUS } from "@/lib/inbound/sent";

afterEach(cleanup);

const inbound = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "in-1", lead_id: "L-1", status: "new",
  from_email: "ankit@xyz.com", to_email: null,
  subject: "Need 20 mailboxes", body_text: "Do you support 20 mailboxes?", body_html: null,
  created_at: "2026-08-22T10:00:00Z", ...over,
});

const sent = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: "out-1", lead_id: "L-1", status: SENT_REPLY_STATUS,
  from_email: null, to_email: "ankit@xyz.com",
  subject: "Re: Need 20 mailboxes", body_text: "Yes — quote attached.", body_html: null,
  created_at: "2026-08-22T11:00:00Z", ...over,
});

function renderThread(rows: ThreadRow[], leadEmail: string | null = "ankit@xyz.com") {
  const thread = buildEmailThread(rows, "L-1");
  return render(
    <EmailThreadPanel thread={thread} summary={summariseThread(thread)} leadEmail={leadEmail} />,
  );
}

describe("EmailThreadPanel", () => {
  it("shows what the customer wrote and what we wrote back", () => {
    /* The reported complaint was not "the count is wrong" — it was not knowing where a
       reply would appear. So the test is that both bodies are on screen. */
    renderThread([inbound(), sent()]);
    expect(screen.getByText("Do you support 20 mailboxes?")).toBeTruthy();
    expect(screen.getByText("Yes — quote attached.")).toBeTruthy();
  });

  it("labels our side 'You' and theirs by their address", () => {
    renderThread([inbound(), sent()]);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getAllByText(/ankit@xyz\.com/).length).toBeGreaterThan(0);
  });

  it("counts each direction, so the header cannot disagree with the list", () => {
    renderThread([inbound(), sent(), inbound({ id: "in-2", created_at: "2026-08-22T12:00:00Z" })]);
    expect(screen.getByText("2 in · 1 out")).toBeTruthy();
  });

  it("says they have not replied when everything is outbound", () => {
    /* The state that caused the report. A silent panel here reads as broken. */
    renderThread([sent()]);
    expect(screen.getByText(/have not written back yet/i)).toBeTruthy();
  });

  it("does not claim they have not replied once they have", () => {
    renderThread([inbound(), sent()]);
    expect(screen.queryByText(/have not written back yet/i)).toBeNull();
  });

  it("explains an empty thread instead of showing a blank box", () => {
    renderThread([]);
    expect(screen.getByText(/No email either way yet/i)).toBeTruthy();
    expect(screen.getByText(/ankit@xyz\.com/)).toBeTruthy();
  });

  it("tells you to add an address when the lead has none", () => {
    /* Different empty state, different next step (§24) — "nothing yet" and "nowhere to
       send" are not the same problem. */
    renderThread([], null);
    expect(screen.getByText(/no email address on it/i)).toBeTruthy();
  });

  it("NEVER renders body_html, and says why the message is not shown", () => {
    /* body_html is whatever a stranger emailed in. Rendering it would run their markup in
       the operator's session. */
    renderThread([inbound({ body_text: null, body_html: "<b>hi</b><script>alert(1)</script>" })]);
    expect(screen.getByText(/formatted HTML only/i)).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(document.body.innerHTML).not.toContain("alert(1)");
  });

  it("says a Gmail send has no stored text rather than showing an empty bubble", () => {
    /* The drawer already tells the operator that the Email button's text is not kept. This
       panel must not contradict it by rendering a blank message. */
    renderThread([sent({ body_text: null, body_html: null })]);
    expect(screen.getByText(/not saved in ResellerOS/i)).toBeTruthy();
  });

  it("shows the subject when there is one", () => {
    renderThread([inbound()]);
    expect(screen.getByText("Need 20 mailboxes")).toBeTruthy();
  });
});
