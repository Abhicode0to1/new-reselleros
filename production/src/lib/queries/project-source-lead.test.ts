/**
 * R-008 — the project page shows the lead it came from, and nothing on our side
 * duplicates Pardeep's Won trigger.
 *
 * The second half is the one worth having. `trg_leads_won_on_project_accept` (migration
 * 20260926120000) lives on `project_sales` and turns the linked lead Won when a project
 * becomes active. Pardeep asked, in the request itself: "Please do not add the same
 * update to `accept_project_quote`." Two writers for one state is how a lead ends up with
 * two timeline entries, or with one of them removed later as a duplicate.
 *
 * An absence is invisible in review, so it is asserted here rather than remembered.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PROJECT_PAGE = "src/app/(app)/projects/[id]/page.tsx";
const QUERIES      = "src/lib/queries/projects.ts";

/** Source with comments stripped — L46: prose about a thing must not satisfy a scan for it. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the project page names its source lead", () => {
  it("reads the link from leads.project_id, not from project_sales", () => {
    /* project_sales has no lead_id and must not grow one for this — the whole point of
       Pardeep's design is that the project module did not have to change. */
    const src = code(QUERIES);
    expect(src).toContain('.eq("project_id", projectId)');
    expect(src).toMatch(/from\("leads"\)/);
  });

  it("renders the lead and links to its drawer", () => {
    const src = code(PROJECT_PAGE);
    expect(src).toContain("useProjectSourceLead");
    expect(src).toContain("From lead:");
    expect(src).toContain("/leads?lead=");
  });

  it("shows nothing at all when there is no lead", () => {
    // Most projects have none. A "From lead: —" line on every one of them is furniture.
    expect(code(PROJECT_PAGE)).toContain("{sourceLead && (");
  });

  it("never writes the link — this side only reads it", () => {
    /* `update leads set project_id` here would race Pardeep's RPC and silently
       re-point a lead at a different project. */
    const src = code(QUERIES) + code(PROJECT_PAGE);
    expect(src).not.toMatch(/from\("leads"\)[\s\S]{0,80}\.update\(/);
  });
});

describe("Pardeep's Won trigger keeps its monopoly", () => {
  it("no project file marks a lead Won", () => {
    /* The trigger on project_sales does this. A second writer in accept_project_quote
       or on the page would double the timeline entry. */
    const files = [PROJECT_PAGE, QUERIES,
      "src/components/features/projects/create-project-quote-dialog.tsx"];
    for (const f of files) {
      const src = code(f);
      expect(src, `${f} appears to set a lead's stage to won`).not.toMatch(/stage:\s*["']won["']/i);
    }
  });
});
