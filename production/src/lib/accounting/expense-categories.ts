/**
 * Kharche ki categories — ek hi jagah, aur ye file JAAN-BOOJHKAR khaali hai.
 *
 * Ye `lib/queries/expenses.ts` me thi, jo Supabase aur react-query import karti hai. 30 Aug
 * 2026 ko bill-extractor ke sanitiser ko ye list chahiye thi, aur us file ke sir par likha
 * hai: "Pure, dependency-free helpers … so they can be unit-tested without pulling in
 * server-only Supabase/Gemini imports". Us waade ko todne se behtar tha list ko us jagah
 * rakhna jahan se dono le sakein.
 *
 * `expenses.ts` ise aage bhi export karti hai, isliye maujooda 11 call site waise hi chalte
 * hain — kisi ko badalne ki zaroorat nahi.
 */
export const EXPENSE_CATEGORIES = [
  "Hosting",
  "Software",
  "Salaries",
  "Office Rent",
  "Marketing",
  "Advertising",
  "Business Promotion",
  "Staff Welfare",
  "Travel",
  "Professional Services",
  "Bank Charges",
  "Internet & Phone",
  "Utilities",
  "Office Supplies",
  "Equipment",
  "Repairs & Maintenance",
  "Insurance",
  "Other",
] as const;
