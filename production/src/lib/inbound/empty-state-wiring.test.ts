import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(
  join(process.cwd(), "src", "app", "(app)", "enquiries", "page.tsx"), "utf8");

describe("/enquiries empty Inbox", () => {
  it("offers a primary and a secondary action, not bare text", () => {
    expect(PAGE).toMatch(/Add a lead manually/);
    expect(PAGE).toMatch(/Set up email in Settings/);
  });
  it("explains how enquiries arrive and names the folders", () => {
    expect(PAGE).toMatch(/enquiries-empty-guidance/);
    expect(PAGE).toMatch(/Enquiries arrive here when/);
  });
});
