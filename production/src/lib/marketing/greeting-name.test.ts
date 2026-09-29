import { describe, expect, it } from "vitest";
import { greetingName } from "./greeting-name";

describe("greetingName", () => {
  it.each([
    ["Dr. Kopal Singhal Jain", "Dr. Kopal"],
    ["Dr Shrey Dhawan", "Dr. Shrey"],
    ["CA Rahul Choudhary", "CA Rahul"],
    ["Mr Sanjeev Pratap Singh", "Sanjeev"],
    ["Mr. Divjyot Singh", "Divjyot"],
    ["Rahul Choudhary", "Rahul"],
    ["", "there"],
    [null, "there"],
  ])("%s → %s", (full, want) => expect(greetingName(full)).toBe(want));
});
