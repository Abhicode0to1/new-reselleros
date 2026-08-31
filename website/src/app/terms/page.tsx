import type { Metadata } from "next";
import { LegalDoc } from "@/components/legal/LegalDoc";
export const metadata: Metadata = { title: "Terms of service" };
export default function TermsPage() { return <LegalDoc page="terms" />; }
