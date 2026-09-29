import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
import { previewTemplate, unknownVariables } from "./campaign-templates";

describe("campaign template helpers", () => {
  it("preview fills every variable the send route fills", () => {
    const out = previewTemplate("{{name}} {{company}} {{sender}} {{offer_code}} {{discount}} {{expires}}");
    expect(out).not.toMatch(/\{\{/);
  });

  it("flags a variable that would go out raw", () => {
    expect(unknownVariables("Hi {{name}}", "Your {{review_link}} and {{company}}")).toEqual(["review_link"]);
    expect(unknownVariables("Hi {{name}}", null, undefined)).toEqual([]);
  });
});
