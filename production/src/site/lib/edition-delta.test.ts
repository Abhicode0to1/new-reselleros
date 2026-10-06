import { describe, it, expect } from "vitest";
import { editionDelta } from "./edition-delta";

describe("editionDelta", () => {
  it("keeps new features and changed values, drops what the lower edition already had", () => {
    const starter = ["Storage per user: 30 GB", "Custom email on your domain", "Meet participants: 100"];
    const standard = ["Storage per user: 2 TB", "Custom email on your domain", "Meet participants: 150", "Meeting recordings to Drive"];
    expect(editionDelta(starter, standard)).toEqual(["Storage per user: 2 TB", "Meet participants: 150", "Meeting recordings to Drive"]);
  });
  it("an edition with nothing below it lists everything", () => {
    expect(editionDelta([], ["A", "B"])).toEqual(["A", "B"]);
  });
});
