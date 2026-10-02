import { describe, it, expect } from 'vitest';
import { calculateLineItemMrr, computeTenantMrrAnalytics, SubscriptionLineItem } from './mrr-analytics';

describe('MRR & Profit Analytics Engine', () => {
  it('correctly calculates monthly line item for Google Workspace Business Starter', () => {
    const item: SubscriptionLineItem = {
      id: 'sub-1',
      tenant_id: 'fbb976f1-9090-4f10-9726-0901bd144e42',
      product_name: 'Google Workspace Business Starter',
      category: 'google_workspace',
      billing_cycle: 'monthly',
      quantity: 10,
      selling_price_rupees: 270, // MSRP ₹270
      wholesale_cost_rupees: 110, // Cost ₹110
      status: 'active',
    };

    const res = calculateLineItemMrr(item);
    expect(res.monthlyRevenue).toBe(2700); // 10 * 270
    expect(res.monthlyCost).toBe(1100);    // 10 * 110
    expect(res.monthlyProfit).toBe(1600);  // 2700 - 1100
  });

  it('correctly normalizes yearly billing to monthly MRR', () => {
    const item: SubscriptionLineItem = {
      id: 'sub-2',
      tenant_id: 'tenant-1',
      product_name: 'Yearly Hosting Plan',
      category: 'hosting',
      billing_cycle: 'yearly',
      quantity: 1,
      selling_price_rupees: 1200, // ₹1200 / year = ₹100 / month
      wholesale_cost_rupees: 600,   // ₹600 / year = ₹50 / month
      status: 'active',
    };

    const res = calculateLineItemMrr(item);
    expect(res.monthlyRevenue).toBe(100);
    expect(res.monthlyCost).toBe(50);
    expect(res.monthlyProfit).toBe(50);
  });

  it('ignores non-active subscriptions', () => {
    const item: SubscriptionLineItem = {
      id: 'sub-3',
      tenant_id: 'tenant-1',
      product_name: 'Canceled Workspace',
      category: 'google_workspace',
      billing_cycle: 'monthly',
      quantity: 5,
      selling_price_rupees: 270,
      wholesale_cost_rupees: 110,
      status: 'canceled',
    };

    const res = calculateLineItemMrr(item);
    expect(res.monthlyRevenue).toBe(0);
    expect(res.monthlyProfit).toBe(0);
  });

  it('computes overall tenant analytics across multiple product lines', () => {
    const items: SubscriptionLineItem[] = [
      {
        id: '1', tenant_id: 't1', product_name: 'Google Workspace', category: 'google_workspace',
        billing_cycle: 'monthly', quantity: 10, selling_price_rupees: 270, wholesale_cost_rupees: 110, status: 'active'
      },
      {
        id: '2', tenant_id: 't1', product_name: 'DirectAdmin Hosting', category: 'hosting',
        billing_cycle: 'monthly', quantity: 2, selling_price_rupees: 500, wholesale_cost_rupees: 200, status: 'active'
      }
    ];

    const analytics = computeTenantMrrAnalytics(items);

    expect(analytics.total_active_subscriptions).toBe(2);
    expect(analytics.total_mrr_rupees).toBe(3700); // 2700 + 1000
    expect(analytics.total_arr_rupees).toBe(44400); // 3700 * 12
    expect(analytics.total_monthly_cost_rupees).toBe(1500); // 1100 + 400
    expect(analytics.total_monthly_profit_rupees).toBe(2200); // 3700 - 1500
    expect(analytics.overall_margin_percentage).toBe(59.46); // (2200 / 3700) * 100
  });
});
