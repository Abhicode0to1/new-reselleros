import type { Metadata } from "next";
import { LegalDoc } from "@/components/legal/LegalDoc";
export const metadata: Metadata = { title: "Privacy policy" };
export default function PrivacyPage() { return <LegalDoc page="privacy" />; }
