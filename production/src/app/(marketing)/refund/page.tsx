import type { Metadata } from "next";
import { LegalDoc } from "@/site/components/legal/LegalDoc";
export const metadata: Metadata = { title: "Refund policy" };
export default function RefundPage() { return <LegalDoc page="refund" />; }
