import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { computeTenantMrrAnalytics, SubscriptionLineItem } from '@/lib/subscriptions/mrr-analytics';

export async function GET() {
  try {
    const supabase = createClient();
    
    // Fetch active subscriptions with item pricing for authenticated tenant
    const { data: subscriptions, error } = await supabase
      .from('subscriptions')
      .select(`
        id,
        tenant_id,
        quantity,
        status,
        billing_cycle,
        items (
          name,
          category,
          msrp,
          wholesale
        )
      `)
      .eq('status', 'active');

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const items: SubscriptionLineItem[] = (subscriptions || []).map((sub: any) => ({
      id: sub.id,
      tenant_id: sub.tenant_id,
      product_name: sub.items?.name || 'Subscription',
      category: sub.items?.category || 'other',
      billing_cycle: sub.billing_cycle || 'monthly',
      quantity: sub.quantity || 1,
      selling_price_rupees: sub.items?.msrp || 0,
      wholesale_cost_rupees: sub.items?.wholesale || 0,
      status: sub.status,
    }));

    const analytics = computeTenantMrrAnalytics(items);

    return NextResponse.json({
      success: true,
      analytics,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
