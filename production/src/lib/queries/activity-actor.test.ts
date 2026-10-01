import { describe, expect, it } from "vitest";
import { activityActorInitials, activityActorName } from "./activity-actor";

const staff = { actor: { full_name: "Pawan Kumar", initials: "PK", color: "#123456" }, actor_label: null };
const customer = { actor: null, actor_label: "Customer Acme Pvt Ltd" };

describe("activity actor", () => {
  it("staff row shows the user's name and initials", () => {
    expect(activityActorName(staff)).toBe("Pawan Kumar");
    expect(activityActorInitials(staff)).toBe("PK");
  });

  it("portal customer row shows 'Customer <name>' from actor_label", () => {
    expect(activityActorName(customer)).toBe("Customer Acme Pvt Ltd");
    expect(activityActorInitials(customer)).toBe("C");
  });

  it("neither → Someone / ?", () => {
    expect(activityActorName({ actor: null, actor_label: null })).toBe("Someone");
    expect(activityActorInitials({ actor: null })).toBe("?");
  });
});
