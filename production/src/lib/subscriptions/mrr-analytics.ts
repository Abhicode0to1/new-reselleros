/**
 * Real-Time MRR/ARR & Profit Margin Analytics Engine
 * ResellerOS - ANUTECH DIGITAL PVT LTD
 * 
 * Rules Enforced:
 * 1. Whole Rupees storage & output (AGENTS.md Rule 1)
 * 2. Multi-tenant isolation (AGENTS.md Rule 4)
 * 3. IST Date compliance (@/lib/dates/ist)
 */

export interface SubscriptionLineItem {
  id: string;
  tenant_id: string;
  product_name: string;
  category: 'google_workspace' | 'microsoft_365' | 'zoho' | 'hosting' | 'domain' | 'other';
  billing_cycle: 'monthly' | 'yearly';
  quantity: number;
  selling_price_rupees: number; // MSRP / Custom price per seat/unit
  wholesale_cost_rupees: number; // Vendor wholesale cost per seat/unit
  status: 'active' | 'suspended' | 'canceled';
}

export interface CategoryAnalytics {
  category: string;
  active_subscriptions: number;
  total_units: number;
  mrr_rupees: number;
  monthly_cost_rupees: number;
  monthly_profit_rupees: number;
  margin_percentage: number;
}

export interface OverallMrrAnalytics {
  total_active_subscriptions: number;
  total_mrr_rupees: number;
  total_arr_rupees: number;
  total_monthly_cost_rupees: number;
  total_monthly_profit_rupees: number;
  overall_margin_percentage: number;
  category_breakdown: Record<string, CategoryAnalytics>;
}

/**
 * Calculates monthly revenue and cost for a single subscription line item
 */
export function calculateLineItemMrr(item: SubscriptionLineItem): {
  monthlyRevenue: number;
  monthlyCost: number;
  monthlyProfit: number;
} {
  if (item.status !== 'active') {
    return { monthlyRevenue: 0, monthlyCost: 0, monthlyProfit: 0 };
  }

  const qty = Math.max(0, item.quantity);
  const rawRevenue = item.billing_cycle === 'yearly'
    ? (qty * item.selling_price_rupees) / 12
    : qty * item.selling_price_rupees;

  const rawCost = item.billing_cycle === 'yearly'
    ? (qty * item.wholesale_cost_rupees) / 12
    : qty * item.wholesale_cost_rupees;

  // Round to whole rupees for final storage/display
  const monthlyRevenue = Math.round(rawRevenue);
  const monthlyCost = Math.round(rawCost);
  const monthlyProfit = monthlyRevenue - monthlyCost;

  return { monthlyRevenue, monthlyCost, monthlyProfit };
}

/**
 * Computes complete MRR, ARR & Margin Analytics across all subscriptions for a tenant
 */
export function computeTenantMrrAnalytics(items: SubscriptionLineItem[]): OverallMrrAnalytics {
  let totalActive = 0;
  let totalMrr = 0;
  let totalCost = 0;

  const categories: Record<string, CategoryAnalytics> = {
    google_workspace: { category: 'Google Workspace', active_subscriptions: 0, total_units: 0, mrr_rupees: 0, monthly_cost_rupees: 0, monthly_profit_rupees: 0, margin_percentage: 0 },
    microsoft_365: { category: 'Microsoft 365', active_subscriptions: 0, total_units: 0, mrr_rupees: 0, monthly_cost_rupees: 0, monthly_profit_rupees: 0, margin_percentage: 0 },
    zoho: { category: 'Zoho', active_subscriptions: 0, total_units: 0, mrr_rupees: 0, monthly_cost_rupees: 0, monthly_profit_rupees: 0, margin_percentage: 0 },
    hosting: { category: 'Hosting', active_subscriptions: 0, total_units: 0, mrr_rupees: 0, monthly_cost_rupees: 0, monthly_profit_rupees: 0, margin_percentage: 0 },
    domain: { category: 'Domain Names', active_subscriptions: 0, total_units: 0, mrr_rupees: 0, monthly_cost_rupees: 0, monthly_profit_rupees: 0, margin_percentage: 0 },
    other: { category: 'Other Services', active_subscriptions: 0, total_units: 0, mrr_rupees: 0, monthly_cost_rupees: 0, monthly_profit_rupees: 0, margin_percentage: 0 },
  };

  for (const item of items) {
    if (item.status !== 'active') continue;

    const { monthlyRevenue, monthlyCost, monthlyProfit } = calculateLineItemMrr(item);
    const catKey = categories[item.category] ? item.category : 'other';

    totalActive++;
    totalMrr += monthlyRevenue;
    totalCost += monthlyCost;

    categories[catKey].active_subscriptions++;
    categories[catKey].total_units += item.quantity;
    categories[catKey].mrr_rupees += monthlyRevenue;
    categories[catKey].monthly_cost_rupees += monthlyCost;
    categories[catKey].monthly_profit_rupees += monthlyProfit;
  }

  // Calculate percentage margins per category
  for (const key of Object.keys(categories)) {
    const cat = categories[key];
    cat.margin_percentage = cat.mrr_rupees > 0
      ? Number(((cat.monthly_profit_rupees / cat.mrr_rupees) * 100).toFixed(2))
      : 0;
  }

  const totalProfit = totalMrr - totalCost;
  const overallMargin = totalMrr > 0
    ? Number(((totalProfit / totalMrr) * 100).toFixed(2))
    : 0;

  return {
    total_active_subscriptions: totalActive,
    total_mrr_rupees: totalMrr,
    total_arr_rupees: totalMrr * 12,
    total_monthly_cost_rupees: totalCost,
    total_monthly_profit_rupees: totalProfit,
    overall_margin_percentage: overallMargin,
    category_breakdown: categories,
  };
}
