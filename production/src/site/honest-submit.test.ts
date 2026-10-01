/**
 * The site's trial form and quote builder must not show success when the send failed
 * (owner, 30 Sep 2026: "Give honest feedback to user, so that user can retry if failed, or
 * success so that user can expect the success email").
 *
 * Both used to confirm regardless: TrialForm swallowed the fetch error ("still confirm") and
 * never read the answer; QuoteBuilder caught a refusal, cleared the error message and showed
 * the quote as if our team had it. These pin the honest shape in the source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("TrialForm — honest about the send", () => {
  const c = code("src/site/components/trial/TrialForm.tsx");
  it("reads the answer and stops on a failure, with a message to retry", () => {
    expect(c).toMatch(/if \(!res\.ok \|\| !json\.ok\) \{\s*setSubmitErr\(/);
    expect(c).toMatch(/setSubmitErr\("We could not reach our server/);
    expect(c).not.toMatch(/catch \{\s*\}\s*setReqNo/); // no swallowed error followed by "received"
  });
  it("says \"check your inbox\" only when the copy was really emailed", () => {
    expect(c).toMatch(/setAckSent\(json\.ackSent === true\)/);
    expect(c).toMatch(/\{ackSent\s*\?/);
  });
});

describe("QuoteBuilder — honest about the send", () => {
  const c = code("src/site/components/quote/QuoteBuilder.tsx");
  it("a failed send is marked not received, with a way to try again", () => {
    expect(c).toMatch(/setTeamHasIt\(false\)/);
    expect(c).toMatch(/did <b>not<\/b> reach our team/);
    expect(c).not.toMatch(/setErr\([^)]*\? "" : ""\)/); // the old blanked-out error
  });
  it("promises an emailed copy only when the server says it went", () => {
    expect(c).toMatch(/setAckSent\(data\.ackSent === true\)/);
  });
});

describe("the enquiry routes report whether the customer's copy was emailed", () => {
  for (const f of ["src/app/api/public/enquiry/general/route.ts", "src/app/api/public/enquiry/workspace/route.ts"]) {
    it(f, () => {
      const c = code(f);
      expect(c).toMatch(/const ackSent = ack\.status === "fulfilled"/);
      expect(c).toMatch(/ackSent \}\);/);
    });
  }
});
