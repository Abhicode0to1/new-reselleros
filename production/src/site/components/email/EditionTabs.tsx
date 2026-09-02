"use client";
/** Three suite tabs over the 11-row feature matrix. */
import { useState } from "react";
import { EDITION_MATRICES } from "@/site/lib/data/catalog";

const SUITES = Object.keys(EDITION_MATRICES);

export function EditionTabs() {
  const [suite, setSuite] = useState(SUITES[0]);
  const m = EDITION_MATRICES[suite];

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {SUITES.map((s) => (
          <button key={s} className="chip" aria-pressed={suite === s} onClick={() => setSuite(s)}>
            {s}
          </button>
        ))}
      </div>
      <div className="tablewrap">
        <table className="rates" style={{ minWidth: 760 }}>
          <thead>
            <tr>
              <th></th>
              {m.cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map(([label, a, b, c]) => (
              <tr key={label}>
                <td style={{ fontWeight: 600 }}>{label}</td>
                {[a, b, c].map((v, i) => (
                  <td key={i} style={{ color: v === "—" ? "var(--text-disabled)" : "var(--text)" }}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="meta" style={{ marginTop: 12 }}>{m.note}</p>
    </div>
  );
}
