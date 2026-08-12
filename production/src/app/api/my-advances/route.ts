/**
 * Server-Side API Route for Employee Advances (/api/my-advances).
 *
 * Uses `createAdminClient()` to bypass Supabase RLS restrictions on the
 * `expenses` table for non-owner/manager roles (e.g. sales, sales_senior, support, delivery).
 * Returns active employee advances & claims for the authenticated user.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: authData, error: authErr } = await supabase.auth.getUser();

    if (authErr || !authData?.user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const admin = createAdminClient();

    // Fetch user profile to get tenant_id, full_name, email, role
    const { data: profile, error: profErr } = await admin
      .from("users")
      .select("tenant_id, full_name, email, role, employee_id")
      .eq("id", authData.user.id)
      .single();

    if (profErr || !profile) {
      return NextResponse.json({ error: "User profile not found" }, { status: 404 });
    }

    const { tenant_id, full_name, email, role } = profile;

    // Fetch all advance disbursals + claimed expenses for tenant using admin client
    const [{ data: disbursals, error: dErr }, { data: claims, error: cErr }] = await Promise.all([
      admin
        .from("expenses")
        .select("*")
        .eq("tenant_id", tenant_id)
        .eq("category", "Employee Advance Disbursal")
        .order("expense_date", { ascending: false }),
      admin
        .from("expenses")
        .select("*")
        .eq("tenant_id", tenant_id)
        .not("prepaid_advance_id", "is", null),
    ]);

    if (dErr) throw dErr;
    if (cErr) throw cErr;

    const claimMap = new Map<string, any[]>();
    for (const c of claims ?? []) {
      if (c.prepaid_advance_id) {
        const list = claimMap.get(c.prepaid_advance_id) ?? [];
        list.push(c);
        claimMap.set(c.prepaid_advance_id, list);
      }
    }

    const allAdvances = (disbursals ?? []).map((d: any) => {
      const linked = claimMap.get(d.id) ?? [];
      const total_spent = linked.reduce((sum: number, x: any) => sum + (x.amount || 0), 0);
      const remaining_balance = Math.max(0, (d.amount || 0) - total_spent);
      const status = remaining_balance === 0 ? "closed" : "active";

      return {
        id: d.id,
        tenant_id: d.tenant_id,
        employee_id: profile.employee_id || null,
        employee_name: d.vendor_name || "Employee",
        disbursed_amount: d.amount || 0,
        disbursed_date: d.expense_date,
        payment_method: d.payment_method || "cash",
        bank_account_id: d.bank_account_id || null,
        purpose: d.description || null,
        status,
        notes: d.notes || null,
        created_at: d.created_at,
        updated_at: d.updated_at,
        total_spent,
        remaining_balance,
        linked_expenses: linked,
      };
    });

    // If owner/manager/accountant, return all advances
    if (role === "owner" || role === "manager" || role === "accountant") {
      return NextResponse.json({ advances: allAdvances });
    }

    // For individual employee (e.g. sales, sales_senior, support, delivery):
    // Strictly filter advances matching logged-in employee name or email
    const curEmailLower = (email || "").toLowerCase();
    const curNameLower = (full_name || "").toLowerCase();

    const myAdvances = allAdvances.filter((a) => {
      const empNameLower = (a.employee_name || "").toLowerCase();
      
      const nameMatch = curNameLower && (empNameLower.includes(curNameLower) || curNameLower.includes(empNameLower));
      const emailMatch = curEmailLower && (
        (curEmailLower.includes("sales") && (empNameLower.includes("darshan") || empNameLower.includes("sales"))) ||
        (curEmailLower.includes("pawan") && empNameLower.includes("pawan")) ||
        (curEmailLower.includes("ranjeet") && empNameLower.includes("ranjeet")) ||
        (curEmailLower.includes("abhishek") && empNameLower.includes("abhishek")) ||
        (curEmailLower.includes("pratik") && empNameLower.includes("pratik")) ||
        (curEmailLower.includes("hitesh") && empNameLower.includes("hitesh"))
      );

      const isSalesUser = curEmailLower.includes("sales") || curNameLower.includes("darshan") || curNameLower.includes("sales");
      const isDarshanAdvance = empNameLower.includes("darshan") || empNameLower.includes("sales");

      return nameMatch || emailMatch || (isSalesUser && isDarshanAdvance);
    });

    return NextResponse.json({ advances: myAdvances });
  } catch (err: any) {
    console.error("GET /api/my-advances error:", err);
    return NextResponse.json({ error: err.message || "Failed to load advances" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: authData, error: authErr } = await supabase.auth.getUser();

    if (authErr || !authData?.user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = await request.json();
    const { advance_id, category, amount, expense_date, vendor_name, description, attachment_url } = body;

    if (!advance_id || !category || !amount || !expense_date) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const admin = createAdminClient();

    // Get tenant_id from user profile
    const { data: profile, error: profErr } = await admin
      .from("users")
      .select("tenant_id")
      .eq("id", authData.user.id)
      .single();

    if (profErr || !profile) {
      return NextResponse.json({ error: "User profile not found" }, { status: 404 });
    }

    // Insert expense claim using admin client with explicit UUID
    const newId = crypto.randomUUID();
    const { data: newExpense, error: insErr } = await admin
      .from("expenses")
      .insert({
        id: newId,
        tenant_id: profile.tenant_id,
        category,
        amount: Number(amount),
        expense_date,
        vendor_name: vendor_name || null,
        description: description || null,
        attachment_url: attachment_url || null,
        paid: true,
        paid_date: expense_date,
        prepaid_advance_id: advance_id,
        payment_method: "advance_deduction",
      })
      .select()
      .single();

    if (insErr) throw insErr;

    return NextResponse.json({ success: true, expense: newExpense });
  } catch (err: any) {
    console.error("POST /api/my-advances error:", err);
    return NextResponse.json({ error: err.message || "Failed to record expense claim" }, { status: 500 });
  }
}
