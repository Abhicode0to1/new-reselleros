"use client";
/**
 * Support page body: live KB search (title + category, case-insensitive, with an empty
 * state) and the sidebar — WhatsApp card, the 15-minute call booker (4 day chips × 6 time
 * chips, dynamic confirm label) and three channel cards.
 *
 * The booker's confirm is a mailto for now — the site has no booking backend. That is
 * stated in the button's own text rather than pretending a calendar exists.
 */
import { useState } from "react";
import { KB_ARTICLES, SUPPORT_CHANNELS } from "@/lib/data/misc";
import { WHATSAPP_URL, COMPANY } from "@/lib/config";

const DAYS = ["Mon 31 Aug", "Tue 01 Sep", "Wed 02 Sep", "Thu 03 Sep"];
const SLOTS = ["10:30", "11:30", "14:00", "15:30", "17:00", "18:15"];

export function SupportBody() {
  const [query, setQuery] = useState("");
  const [day, setDay] = useState(DAYS[0]);
  const [slot, setSlot] = useState(SLOTS[0]);

  const q = query.trim().toLowerCase();
  const articles = q ? KB_ARTICLES.filter((a) => (a.title + " " + a.cat).toLowerCase().includes(q)) : KB_ARTICLES;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.4fr .8fr", gap: 40, alignItems: "start" }} data-grid>
      <div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the knowledge base"
          aria-label="Search knowledge base"
          style={{ width: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "13px 14px", fontSize: 15, fontFamily: "inherit", marginBottom: 16 }}
        />
        <div className="meta" style={{ marginBottom: 10 }}>
          {q ? `${articles.length} article(s) matching “${query}”` : "Most-read articles"}
        </div>
        {articles.length === 0 ? (
          <div style={{ border: "1px dashed var(--border-strong)", borderRadius: 8, padding: 28, textAlign: "center" }}>
            <p className="body" style={{ margin: 0 }}>
              Nothing matches. WhatsApp us — a human answer beats a search result anyway.
            </p>
          </div>
        ) : (
          articles.map((a) => (
            <div key={a.title} style={{ display: "flex", gap: 14, alignItems: "baseline", padding: "13px 0", borderBottom: "1px solid var(--border-hairline)" }}>
              <span className="mono-label" style={{ color: "var(--text-muted)", flex: "none", width: 76 }}>{a.cat}</span>
              <span style={{ fontSize: 15, fontWeight: 500 }}>{a.title}</span>
            </div>
          ))
        )}
      </div>

      <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="card card-highlight">
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>WhatsApp us</div>
          <p className="body" style={{ margin: "0 0 12px", fontSize: 14 }}>
            Eleven-minute average first reply, {COMPANY.hours}.
          </p>
          <a href={WHATSAPP_URL} target="_blank" rel="noopener" className="btn btn-primary btn-sm">Open WhatsApp</a>
        </div>

        <div className="card">
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Book a 15-minute call</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            {DAYS.map((d) => (
              <button key={d} className="chip" aria-pressed={day === d} onClick={() => setDay(d)} style={{ fontSize: 12, padding: "6px 10px" }}>
                {d}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
            {SLOTS.map((s) => (
              <button key={s} className="chip chip-primary" aria-pressed={slot === s} onClick={() => setSlot(s)} style={{ fontSize: 12, padding: "6px 10px" }}>
                {s}
              </button>
            ))}
          </div>
          <a
            className="btn btn-outline btn-sm"
            style={{ width: "100%" }}
            href={`mailto:${COMPANY.supportEmail}?subject=${encodeURIComponent(`Call request — ${day} at ${slot} IST`)}`}
          >
            Request {day} at {slot} IST
          </a>
        </div>

        {SUPPORT_CHANNELS.map((c) => (
          <div key={c.title} className="card" style={{ padding: 18 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{c.title}</div>
            <p className="body" style={{ margin: 0, fontSize: 14 }}>{c.body}</p>
          </div>
        ))}
      </aside>
    </div>
  );
}
