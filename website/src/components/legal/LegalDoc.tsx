/** 760px legal measure: h1 40px, mono "Last updated", intro, blocks with 1px top rules. */
import { LEGAL } from "@/lib/data/misc";

export function LegalDoc({ page }: { page: keyof typeof LEGAL }) {
  const doc = LEGAL[page];
  return (
    <section className="section rise">
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 20px" }}>
        <h1 className="h1-narrow" style={{ marginBottom: 8 }}>{doc.title}</h1>
        <div className="mono-label" style={{ color: "var(--text-muted)", marginBottom: 16 }}>{doc.updated.toUpperCase()}</div>
        <p className="body-lg" style={{ margin: "0 0 30px" }}>{doc.intro}</p>
        {doc.blocks.map((b) => (
          <div key={b.h} style={{ borderTop: "1px solid var(--border-light)", padding: "22px 0" }}>
            <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 8 }}>{b.h}</h2>
            <p style={{ fontSize: 16, lineHeight: 1.6, color: "var(--text-secondary)", margin: 0 }}>{b.p}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
