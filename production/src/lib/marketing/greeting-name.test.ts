import { describe, expect, it } from "vitest";
import { fillName, greetingName, NO_NAME } from "./greeting-name";

describe("greetingName", () => {
  it.each([
    ["Dr. Kopal Singhal Jain", "Dr. Kopal"],
    ["Dr Shrey Dhawan", "Dr. Shrey"],
    ["CA Rahul Choudhary", "CA Rahul"],
    ["Mr Sanjeev Pratap Singh", "Sanjeev"],
    ["Mr. Divjyot Singh", "Divjyot"],
    ["Rahul Choudhary", "Rahul"],
    ["", null],
    [null, null],
  ])("%s → %s", (full, want) => expect(greetingName(full)).toBe(want));
});

describe("fillName", () => {
  it("fills a known name and keeps ji", () => expect(fillName("Namaste {{name}} ji,", "Dr. Shrey Dhawan")).toBe("Namaste Dr. Shrey ji,"));
  it("no name: Sir/Ma'am and the ji goes", () => expect(fillName("Namaste {{name}} ji,", null)).toBe(`Namaste ${NO_NAME},`));
  it("no name in an English template", () => expect(fillName("Hi {{name}},", "")).toBe("Hi Sir/Ma'am,"));
  it("leaves other variables alone", () => expect(fillName("{{name}} at {{company}}", "Rahul K")).toBe("Rahul at {{company}}"));
});
