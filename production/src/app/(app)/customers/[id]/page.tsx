/**
 * /customers/[id] — the standalone customer profile.
 *
 * A thin wrapper on purpose. The whole profile lives in CustomerProfile so the page and
 * the master-detail pane on /customers render THE SAME component; when this was two
 * implementations the panel showed a summary and the page showed the truth, and the two
 * were free to drift. Everything except the id and the page/panel variant belongs there.
 */
"use client";

import { useParams } from "next/navigation";
import { CustomerProfile } from "@/components/features/customers/customer-profile";

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  return <CustomerProfile customerId={params.id} variant="page" />;
}
