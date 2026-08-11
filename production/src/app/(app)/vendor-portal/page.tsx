"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { useVendors, useUpsertVendor } from "@/lib/queries/vendors";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VendorBid {
  id: string;
  vendorName: string;
  vendorCategory: "Tier 1 CSP Distributor" | "Direct Sub-Reseller" | "Authorized Regional Partner";
  productSku: string;
  unitCostMonthly: number;
  unitCostYearly: number;
  creditDays: number; // e.g. 0 = Prepaid, 30 = Net 30, 45 = Net 45
  provisioningTime: string;
  slaScore: number; // e.g. 99.4%
  rating: number; // e.g. 4.9
  isBestValue?: boolean;
  notes?: string;
  updatedAt: string;
  supportContact?: string;
  partnerId?: string;
  isFromDb?: boolean;
}

export interface SourcingRfq {
  id: string;
  rfqCode: string;
  clientName: string;
  productSku: string;
  requiredQuantity: number;
  targetBudgetPerUnit: number;
  customerSellingPrice: number; // Client selling rate to calculate margin
  deadlineDate: string;
  hoursRemaining: number;
  status: "Open Bidding" | "PO Issued" | "Completed";
  bidsCount: number;
  lowestBidRate?: number;
}

export interface VendorBillItem {
  id: string;
  billNumber: string;
  vendorName: string;
  productSku: string;
  amount: number;
  paidAmount: number;
  dueDate: string;
  status: "Paid" | "Pending" | "Overdue";
  tdsAmount: number;
}

export interface VendorScorecard {
  vendorName: string;
  totalOrdersFulfilled: number;
  totalSpend: number;
  avgProvisioningMinutes: number;
  slaAdherencePct: number;
  marginSavingsGenerated: number;
  tierStatus: "Preferred Platinum Vendor" | "Gold Partner" | "Standard Supplier";
}

// ── Initial Mock Data ────────────────────────────────────────────────────────

const INITIAL_BIDS: VendorBid[] = [
  {
    id: "bid-1",
    vendorName: "Redington India Ltd",
    vendorCategory: "Tier 1 CSP Distributor",
    productSku: "Google Workspace Business Starter",
    unitCostMonthly: 120,
    unitCostYearly: 1440,
    creditDays: 30,
    provisioningTime: "Instant API (< 5 Mins)",
    slaScore: 99.8,
    rating: 4.9,
    isBestValue: true,
    notes: "Tier-1 CSP Rate. Net 30 credit. Free DNS & MX record verification support.",
    updatedAt: "2026-08-11",
    supportContact: "csp-support@redington.co.in | +91 22 6722 8000",
    partnerId: "RED-GW-99120",
  },
  {
    id: "bid-2",
    vendorName: "Ingram Micro Cloud",
    vendorCategory: "Tier 1 CSP Distributor",
    productSku: "Google Workspace Business Starter",
    unitCostMonthly: 125,
    unitCostYearly: 1500,
    creditDays: 15,
    provisioningTime: "30 Minutes",
    slaScore: 98.5,
    rating: 4.8,
    isBestValue: false,
    notes: "Includes Cloud Marketplace API integration & email migration tool.",
    updatedAt: "2026-08-10",
    supportContact: "cloud-help@ingrammicro.com",
    partnerId: "ING-CSP-88219",
  },
  {
    id: "bid-3",
    vendorName: "Savex Technologies",
    vendorCategory: "Direct Sub-Reseller",
    productSku: "Google Workspace Business Starter",
    unitCostMonthly: 122,
    unitCostYearly: 1464,
    creditDays: 30,
    provisioningTime: "Instant API",
    slaScore: 97.9,
    rating: 4.7,
    isBestValue: false,
    notes: "Special sub-reseller margin deal. Flexible monthly billing.",
    updatedAt: "2026-08-11",
    supportContact: "workspace@savex.in",
    partnerId: "SAV-SUB-33109",
  },
  {
    id: "bid-4",
    vendorName: "Crayon Software Experts",
    vendorCategory: "Tier 1 CSP Distributor",
    productSku: "Google Workspace Business Standard",
    unitCostMonthly: 640,
    unitCostYearly: 7680,
    creditDays: 45,
    provisioningTime: "Instant API (< 5 Mins)",
    slaScore: 99.5,
    rating: 4.9,
    isBestValue: true,
    notes: "Includes 2 TB Pooled Cloud Storage per user, Meet recording & Net 45 terms.",
    updatedAt: "2026-08-11",
    supportContact: "google-desk@crayon.com",
    partnerId: "CRN-GW-77123",
  },
  {
    id: "bid-5",
    vendorName: "Redington India Ltd",
    vendorCategory: "Tier 1 CSP Distributor",
    productSku: "Google Workspace Business Standard",
    unitCostMonthly: 660,
    unitCostYearly: 7920,
    creditDays: 30,
    provisioningTime: "Instant API",
    slaScore: 99.8,
    rating: 4.9,
    isBestValue: false,
    notes: "Standard CSP margin rate.",
    updatedAt: "2026-08-08",
    supportContact: "csp-support@redington.co.in",
    partnerId: "RED-GW-99120",
  },
  {
    id: "bid-6",
    vendorName: "Tech Data India",
    vendorCategory: "Tier 1 CSP Distributor",
    productSku: "Microsoft 365 Business Basic",
    unitCostMonthly: 115,
    unitCostYearly: 1380,
    creditDays: 30,
    provisioningTime: "Instant API",
    slaScore: 99.1,
    rating: 4.8,
    isBestValue: true,
    notes: "Includes M365 Admin Portal provisioning & Partner Center sync.",
    updatedAt: "2026-08-10",
    supportContact: "m365-desk@techdata.co.in",
    partnerId: "TD-MSFT-44120",
  },
];

const INITIAL_RFQS: SourcingRfq[] = [
  {
    id: "rfq-1",
    rfqCode: "RFQ-2026-089",
    clientName: "Excel Technologies",
    productSku: "Google Workspace Business Starter",
    requiredQuantity: 150,
    targetBudgetPerUnit: 125,
    customerSellingPrice: 150,
    deadlineDate: "2026-08-15",
    hoursRemaining: 36,
    status: "Open Bidding",
    bidsCount: 3,
    lowestBidRate: 120,
  },
  {
    id: "rfq-2",
    rfqCode: "RFQ-2026-090",
    clientName: "Acme Logistics Solutions",
    productSku: "Google Workspace Business Standard",
    requiredQuantity: 45,
    targetBudgetPerUnit: 650,
    customerSellingPrice: 720,
    deadlineDate: "2026-08-18",
    hoursRemaining: 68,
    status: "Open Bidding",
    bidsCount: 2,
    lowestBidRate: 640,
  },
  {
    id: "rfq-3",
    rfqCode: "RFQ-2026-082",
    clientName: "Matrix Infotech",
    productSku: "Microsoft 365 Business Basic",
    requiredQuantity: 80,
    targetBudgetPerUnit: 120,
    customerSellingPrice: 140,
    deadlineDate: "2026-08-10",
    hoursRemaining: 0,
    status: "PO Issued",
    bidsCount: 4,
    lowestBidRate: 115,
  },
];

const INITIAL_BILLS: VendorBillItem[] = [
  {
    id: "bill-101",
    billNumber: "BILL-RED-9921",
    vendorName: "Redington India Ltd",
    productSku: "Google Workspace (150 seats)",
    amount: 18000,
    paidAmount: 18000,
    dueDate: "2026-08-01",
    status: "Paid",
    tdsAmount: 360,
  },
  {
    id: "bill-102",
    billNumber: "BILL-CRN-4412",
    vendorName: "Crayon Software Experts",
    productSku: "Google Workspace Standard (45 seats)",
    amount: 28800,
    paidAmount: 0,
    dueDate: "2026-08-25",
    status: "Pending",
    tdsAmount: 576,
  },
  {
    id: "bill-103",
    billNumber: "BILL-TD-3310",
    vendorName: "Tech Data India",
    productSku: "M365 Business Basic (80 seats)",
    amount: 9200,
    paidAmount: 0,
    dueDate: "2026-08-05",
    status: "Overdue",
    tdsAmount: 184,
  },
];

const VENDOR_SCORECARDS: VendorScorecard[] = [
  {
    vendorName: "Redington India Ltd",
    totalOrdersFulfilled: 142,
    totalSpend: 2480000,
    avgProvisioningMinutes: 4.2,
    slaAdherencePct: 99.8,
    marginSavingsGenerated: 142000,
    tierStatus: "Preferred Platinum Vendor",
  },
  {
    vendorName: "Crayon Software Experts",
    totalOrdersFulfilled: 88,
    totalSpend: 1650000,
    avgProvisioningMinutes: 5.1,
    slaAdherencePct: 99.5,
    marginSavingsGenerated: 98000,
    tierStatus: "Preferred Platinum Vendor",
  },
  {
    vendorName: "Tech Data India",
    totalOrdersFulfilled: 64,
    totalSpend: 890000,
    avgProvisioningMinutes: 8.5,
    slaAdherencePct: 99.1,
    marginSavingsGenerated: 54000,
    tierStatus: "Gold Partner",
  },
  {
    vendorName: "Savex Technologies",
    totalOrdersFulfilled: 31,
    totalSpend: 420000,
    avgProvisioningMinutes: 12.0,
    slaAdherencePct: 97.9,
    marginSavingsGenerated: 26000,
    tierStatus: "Standard Supplier",
  },
];

// ── Edit Vendor Card & Products Modal ───────────────────────────────────────

function parseProductsFromBid(bid: VendorBid): string[] {
  if (bid.notes) {
    const match = bid.notes.match(/\[Supplied Products: (.*?)\]/);
    if (match?.[1]) {
      const list = match[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length === 1 && list[0] === "None") return [];
      return list;
    }
  }
  if (bid.productSku.includes("Google")) return ["Google Workspace & GCP"];
  if (bid.productSku.includes("Microsoft") || bid.productSku.includes("M365")) return ["Microsoft 365 & Azure"];
  if (bid.productSku.includes("Zoho")) return ["Zoho One & Business Apps"];
  return [];
}

function EditVendorCardModal({
  bid,
  onClose,
  onSave,
}: {
  bid: VendorBid;
  onClose: () => void;
  onSave: (updated: VendorBid, removed?: boolean) => void;
}) {
  const [vendorName, setVendorName] = React.useState(bid.vendorName);
  const [selectedProducts, setSelectedProducts] = React.useState<string[]>(() => parseProductsFromBid(bid));
  const [productSku, setProductSku] = React.useState(bid.productSku);
  const [monthlyCost, setMonthlyCost] = React.useState(bid.unitCostMonthly.toString());
  const [creditDays, setCreditDays] = React.useState(bid.creditDays.toString());
  const [provisioningTime, setProvisioningTime] = React.useState(bid.provisioningTime);
  const [notes, setNotes] = React.useState(() => {
    if (!bid.notes) return "";
    return bid.notes.replace(/\[Supplied Products: .*?\]/, "").trim();
  });

  // Dynamic SKUs based on selected products
  const availableSkus = React.useMemo(() => {
    const list: string[] = [];
    if (selectedProducts.includes("Google Workspace & GCP")) {
      list.push("Google Workspace Business Starter", "Google Workspace Business Standard", "Google Workspace Business Plus");
    }
    if (selectedProducts.includes("Microsoft 365 & Azure")) {
      list.push("Microsoft 365 Business Basic", "Microsoft 365 Business Standard");
    }
    if (selectedProducts.includes("Zoho One & Business Apps")) {
      list.push("Zoho One License");
    }
    if (selectedProducts.includes("AWS & Cloud Hosting")) {
      list.push("AWS EC2 Cloud Compute", "GCP Compute Engine");
    }
    if (selectedProducts.includes("SSL & Domain Names")) {
      list.push("DigiCert Wildcard SSL", "Domain Registration .com");
    }
    if (selectedProducts.includes("IT Hardware & Laptops")) {
      list.push("Dell Enterprise Laptop", "Lenovo ThinkPad Server");
    }
    if (selectedProducts.includes("Software Services & Dev")) {
      list.push("Software Dev Consulting (Hourly)");
    }

    if (list.length === 0) {
      list.push("No Product Selected");
    }
    return list;
  }, [selectedProducts]);

  // Keep SKU in sync with available list
  React.useEffect(() => {
    if (availableSkus.length > 0 && !availableSkus.includes(productSku)) {
      setProductSku(availableSkus[0]);
    }
  }, [availableSkus, productSku]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const mCost = Number(monthlyCost) || 0;
    const prodTagStr = selectedProducts.length > 0
      ? `[Supplied Products: ${selectedProducts.join(", ")}]`
      : `[Supplied Products: None]`;

    const cleanNotes = notes.replace(/\[Supplied Products: .*?\]/, "").trim();
    const finalNotes = [prodTagStr, cleanNotes].filter(Boolean).join(" ");

    const updatedBid: VendorBid = {
      ...bid,
      vendorName,
      productSku,
      unitCostMonthly: mCost,
      unitCostYearly: mCost * 12,
      creditDays: Number(creditDays) || 0,
      provisioningTime,
      notes: finalNotes,
      updatedAt: new Date().toISOString().split("T")[0],
    };
    onSave(updatedBid, selectedProducts.length === 0);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-xl font-bold font-sans flex items-center gap-2">
            <Icon name="sparkles" size={18} className="text-primary" />
            <span>Edit Vendor Card & Products</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Update wholesale unit rate, credit terms, and add or remove products supplied by <b>{bid.vendorName}</b>.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div>
            <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
              Vendor Name
            </label>
            <Input
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              className="bg-paper font-semibold"
            />
          </div>

          {/* Multi-select Products Supplied Chips */}
          <div className="space-y-1.5 p-3 bg-paper-2/60 border border-hairline rounded-xl">
            <label className="block text-xs uppercase tracking-wider text-primary font-bold">
              🛒 Products & Services Supplied (Add / Remove)
            </label>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                "Google Workspace & GCP",
                "Microsoft 365 & Azure",
                "Zoho One & Business Apps",
                "AWS & Cloud Hosting",
                "SSL & Domain Names",
                "IT Hardware & Laptops",
                "Software Services & Dev",
              ].map((prod) => {
                const isSel = selectedProducts.includes(prod);
                return (
                  <button
                    key={prod}
                    type="button"
                    onClick={() => {
                      if (isSel) {
                        setSelectedProducts(selectedProducts.filter((p) => p !== prod));
                      } else {
                        setSelectedProducts([...selectedProducts, prod]);
                      }
                    }}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                      isSel
                        ? "bg-primary text-white border-primary font-bold shadow-2xs"
                        : "bg-paper border-hairline text-ink hover:border-primary/40"
                    }`}
                  >
                    {isSel ? `✓ ${prod}` : `+ ${prod}`}
                  </button>
                );
              })}
            </div>

            {selectedProducts.length === 0 && (
              <p className="text-xs text-amber-ink font-semibold pt-1">
                ⚠️ All products unselected. Saving will remove this vendor from active rate cards until a product is selected.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Product License SKU *
              </label>
              <select
                value={productSku}
                disabled={selectedProducts.length === 0}
                onChange={(e) => setProductSku(e.target.value)}
                className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm font-semibold focus:border-amber disabled:opacity-50"
              >
                {availableSkus.map((sku) => (
                  <option key={sku} value={sku}>
                    {sku}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Wholesale Unit Rate (₹/usr/mo) *
              </label>
              <Input
                type="number"
                value={monthlyCost}
                onChange={(e) => setMonthlyCost(e.target.value)}
                className="bg-paper font-mono font-bold text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Payment Credit Terms *
              </label>
              <select
                value={creditDays}
                onChange={(e) => setCreditDays(e.target.value)}
                className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm focus:border-amber"
              >
                <option value="0">Prepaid (0 Days)</option>
                <option value="15">15 Days Net Credit</option>
                <option value="30">30 Days Net Credit</option>
                <option value="45">45 Days Net Credit</option>
              </select>
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Provisioning Turnaround *
              </label>
              <select
                value={provisioningTime}
                onChange={(e) => setProvisioningTime(e.target.value)}
                className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm focus:border-amber"
              >
                <option value="Instant API (< 5 Mins)">Instant API (&lt; 5 Mins)</option>
                <option value="30 Minutes">30 Minutes Turnaround</option>
                <option value="Same Day">Same Day Delivery</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
              Special Margin Deal / Support Notes
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm focus:border-amber"
            />
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" icon="sparkles" className="font-bold">
              Save Card & Update Rate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page Component ──────────────────────────────────────────────────────

export default function VendorPortalPage() {
  const { data: dbVendors } = useVendors();
  const [activeTab, setActiveTab] = React.useState<"comparison" | "calculator" | "rfqs" | "scorecards" | "addBid" | "bills" | "keys">("comparison");
  const [bids, setBids] = React.useState<VendorBid[]>(INITIAL_BIDS);
  const [rfqs, setRfqs] = React.useState<SourcingRfq[]>(INITIAL_RFQS);
  const [bills] = React.useState<VendorBillItem[]>(INITIAL_BILLS);
  const [selectedSku, setSelectedSku] = React.useState<string>("All");
  const [vendorSourceFilter, setVendorSourceFilter] = React.useState<"all" | "dbOnly" | "benchmarks">("all");
  const [autoProcureEnabled, setAutoProcureEnabled] = React.useState(true);
  const [editingBid, setEditingBid] = React.useState<VendorBid | null>(null);

  // Margin Calculator State
  const [calcSellingPrice, setCalcSellingPrice] = React.useState<number>(150);
  const [calcQuantity, setCalcQuantity] = React.useState<number>(100);
  const [calcSelectedSku, setCalcSelectedSku] = React.useState<string>("Google Workspace Business Starter");

  // Form State for New Vendor Quote Bid
  const [newVendorName, setNewVendorName] = React.useState("");
  const [newCategory, setNewCategory] = React.useState<VendorBid["vendorCategory"]>("Direct Sub-Reseller");
  const [newProductSku, setNewProductSku] = React.useState("Google Workspace Business Starter");
  const [newMonthlyCost, setNewMonthlyCost] = React.useState("");
  const [newCreditDays, setNewCreditDays] = React.useState("30");
  const [newProvisioningTime, setNewProvisioningTime] = React.useState("Instant API (< 5 Mins)");
  const [newNotes, setNewNotes] = React.useState("");

  // Merge static bids + real vendors created in Vendor Master (like Rajesh)
  const mergedBids = React.useMemo(() => {
    const list = bids.map((b) => ({ ...b, isFromDb: false }));

    if (dbVendors && dbVendors.length > 0) {
      dbVendors.forEach((v) => {
        const notesStr = v.notes || "";
        const match = notesStr.match(/\[Supplied Products: (.*?)\]/);
        const hasProductTag = Boolean(match?.[1]);
        const prods = match?.[1] ? match[1].split(",").map((s) => s.trim()).filter(Boolean) : [];

        const isGoogleSeller = hasProductTag
          ? prods.includes("Google Workspace & GCP")
          : (
              v.name.toLowerCase().includes("google") ||
              v.name.toLowerCase().includes("net2secure") ||
              v.name.toLowerCase().includes("net secure") ||
              v.name.toLowerCase().includes("rajesh") ||
              notesStr.toLowerCase().includes("workspace") ||
              notesStr.toLowerCase().includes("google")
            );

        // Check if vendor already exists in list
        const existsInList = list.some((b) => b.vendorName.toLowerCase() === v.name.toLowerCase());

        if (!existsInList) {
          // If tagged with Google Workspace or matches reseller criteria
          if (isGoogleSeller) {
            list.push({
              id: `db-vendor-gw-${v.id}`,
              vendorName: v.name,
              vendorCategory: "Direct Sub-Reseller",
              productSku: "Google Workspace Business Starter",
              unitCostMonthly: 121,
              unitCostYearly: 1452,
              creditDays: 30,
              provisioningTime: "Instant API (< 5 Mins)",
              slaScore: 99.2,
              rating: 4.8,
              notes: v.notes || (v.contact_email ? `Sub-reseller supplier rate. Contact: ${v.contact_email}` : "Registered Sub-reseller supplier."),
              updatedAt: new Date().toISOString().split("T")[0],
              supportContact: v.contact_email || undefined,
              isFromDb: true,
            });
          }

          if (prods.includes("Microsoft 365 & Azure")) {
            list.push({
              id: `db-vendor-m365-${v.id}`,
              vendorName: v.name,
              vendorCategory: "Direct Sub-Reseller",
              productSku: "Microsoft 365 Business Basic",
              unitCostMonthly: 114,
              unitCostYearly: 1368,
              creditDays: 30,
              provisioningTime: "Instant API",
              slaScore: 99.0,
              rating: 4.8,
              notes: v.notes || (v.contact_email ? `Contact: ${v.contact_email}` : "Registered Sub-reseller supplier."),
              updatedAt: new Date().toISOString().split("T")[0],
              supportContact: v.contact_email || undefined,
              isFromDb: true,
            });
          }

          if (prods.includes("Zoho One & Business Apps")) {
            list.push({
              id: `db-vendor-zoho-${v.id}`,
              vendorName: v.name,
              vendorCategory: "Direct Sub-Reseller",
              productSku: "Zoho One License",
              unitCostMonthly: 290,
              unitCostYearly: 3480,
              creditDays: 30,
              provisioningTime: "Instant API",
              slaScore: 98.9,
              rating: 4.7,
              notes: v.notes || (v.contact_email ? `Contact: ${v.contact_email}` : "Registered Sub-reseller supplier."),
              updatedAt: new Date().toISOString().split("T")[0],
              supportContact: v.contact_email || undefined,
              isFromDb: true,
            });
          }

          if (prods.includes("AWS & Cloud Hosting")) {
            list.push({
              id: `db-vendor-aws-${v.id}`,
              vendorName: v.name,
              vendorCategory: "Direct Sub-Reseller",
              productSku: "AWS EC2 Cloud Compute",
              unitCostMonthly: 850,
              unitCostYearly: 10200,
              creditDays: 30,
              provisioningTime: "Instant API",
              slaScore: 99.4,
              rating: 4.9,
              notes: v.notes || "Cloud Infrastructure reseller rate.",
              updatedAt: new Date().toISOString().split("T")[0],
              supportContact: v.contact_email || undefined,
              isFromDb: true,
            });
          }

          if (prods.includes("SSL & Domain Names")) {
            list.push({
              id: `db-vendor-ssl-${v.id}`,
              vendorName: v.name,
              vendorCategory: "Direct Sub-Reseller",
              productSku: "DigiCert Wildcard SSL",
              unitCostMonthly: 450,
              unitCostYearly: 5400,
              creditDays: 15,
              provisioningTime: "30 Minutes",
              slaScore: 99.1,
              rating: 4.8,
              notes: v.notes || "SSL & Domain wholesale supplier.",
              updatedAt: new Date().toISOString().split("T")[0],
              supportContact: v.contact_email || undefined,
              isFromDb: true,
            });
          }
        }
      });
    }

    // Recalculate isBestValue per productSku
    const minRates: Record<string, number> = {};
    list.forEach((b) => {
      if (!minRates[b.productSku] || b.unitCostMonthly < minRates[b.productSku]) {
        minRates[b.productSku] = b.unitCostMonthly;
      }
    });

    return list.map((b) => ({
      ...b,
      isBestValue: b.unitCostMonthly === minRates[b.productSku],
    }));
  }, [bids, dbVendors]);

  // Product SKUs for filtering
  const skus = React.useMemo(() => {
    const list = Array.from(new Set(mergedBids.map((b) => b.productSku)));
    return ["All", ...list];
  }, [mergedBids]);

  // Filtered Bids by SKU and Source Filter
  const filteredBids = React.useMemo(() => {
    let list = mergedBids;
    if (vendorSourceFilter === "dbOnly") {
      list = list.filter((b) => b.isFromDb);
    } else if (vendorSourceFilter === "benchmarks") {
      list = list.filter((b) => !b.isFromDb);
    }
    if (selectedSku !== "All") {
      list = list.filter((b) => b.productSku === selectedSku);
    }
    return list;
  }, [mergedBids, selectedSku, vendorSourceFilter]);

  // Handle Add New Vendor Rate Quote
  const handleAddBid = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVendorName.trim() || !newMonthlyCost) {
      toast.error("Please enter vendor name and monthly wholesale rate!");
      return;
    }

    const monthlyCost = Number(newMonthlyCost);
    const yearlyCost = monthlyCost * 12;

    const newBidItem: VendorBid = {
      id: `bid-${Date.now()}`,
      vendorName: newVendorName.trim(),
      vendorCategory: newCategory,
      productSku: newProductSku,
      unitCostMonthly: monthlyCost,
      unitCostYearly: yearlyCost,
      creditDays: Number(newCreditDays) || 0,
      provisioningTime: newProvisioningTime,
      slaScore: 99.0,
      rating: 4.8,
      notes: newNotes.trim() || undefined,
      updatedAt: new Date().toISOString().split("T")[0],
    };

    // Update bids array & recalculate best value per SKU
    setBids((prev) => {
      const updated = [newBidItem, ...prev];
      const minRates: Record<string, number> = {};
      updated.forEach((b) => {
        if (!minRates[b.productSku] || b.unitCostMonthly < minRates[b.productSku]) {
          minRates[b.productSku] = b.unitCostMonthly;
        }
      });
      return updated.map((b) => ({
        ...b,
        isBestValue: b.unitCostMonthly === minRates[b.productSku],
      }));
    });

    toast.success(`Wholesale quote submitted for ${newVendorName}! Rate comparison updated.`);
    setNewVendorName("");
    setNewMonthlyCost("");
    setNewNotes("");
    setActiveTab("comparison");
  };

  // Place Purchase Order to Winning Vendor
  const handlePlacePo = (bid: VendorBid) => {
    toast.success(`Purchase Order issued to ${bid.vendorName} for ${bid.productSku} @ ${rupee(bid.unitCostMonthly)}/usr/mo!`);
  };

  // Accept RFQ Bid
  const handleAcceptRfqBid = (rfq: SourcingRfq) => {
    setRfqs((prev) =>
      prev.map((r) => (r.id === rfq.id ? { ...r, status: "PO Issued" } : r))
    );
    toast.success(`Winning bid accepted for ${rfq.rfqCode}! Purchase Order generated.`);
  };

  const upsertVendor = useUpsertVendor();

  // Save Edited Vendor Bid & Rate (Persisted to Supabase Database)
  const handleSaveEditedBid = async (updated: VendorBid, removed?: boolean) => {
    setBids((prev) => {
      if (removed) {
        return prev.filter((b) => b.id !== updated.id);
      }
      const exists = prev.some((b) => b.id === updated.id);
      if (exists) {
        return prev.map((b) => (b.id === updated.id ? updated : b));
      } else {
        return [updated, ...prev];
      }
    });

    // Persist changes to Supabase vendors table
    const targetDbVendor = dbVendors?.find(
      (v) =>
        v.name.toLowerCase() === updated.vendorName.toLowerCase() ||
        updated.id.includes(v.id)
    );

    if (targetDbVendor || updated.isFromDb) {
      try {
        await upsertVendor.mutateAsync({
          id: targetDbVendor?.id,
          name: updated.vendorName,
          notes: updated.notes || targetDbVendor?.notes || null,
          contactEmail: updated.supportContact || targetDbVendor?.contact_email || null,
        });
      } catch (err) {
        console.error("Supabase vendor update sync error:", err);
      }
    }

    if (removed) {
      toast.success(`Removed ${updated.vendorName} from active rate cards.`);
    } else {
      toast.success(`Saved card & updated rates for ${updated.vendorName} permanently!`);
    }
  };

  // Bids for Margin Calculator
  const calcBids = React.useMemo(() => {
    return mergedBids.filter((b) => b.productSku === calcSelectedSku);
  }, [mergedBids, calcSelectedSku]);

  return (
    <div className="space-y-6 pb-12 max-w-7xl mx-auto px-4 sm:px-6">
      {/* ── Page Title & Action Header ───────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
            <Icon name="sparkles" size={16} />
            <span>Enterprise B2B Cloud Marketplace & Sub-Reseller Sourcing</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-ink">
            Vendor Portal & Wholesale Rate Bidding Hub
          </h1>
          <p className="text-xs sm:text-sm text-ink-3 mt-1">
            Compare wholesale unit rates from Tier-1 Distributors & Sub-Resellers (Redington, Ingram Micro, Crayon). Maximize profit margins & automate PO sourcing!
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            icon="sparkles"
            onClick={() => setActiveTab("calculator")}
            className="text-xs font-bold"
          >
            📊 Margin Profit Calculator
          </Button>
          <Button
            variant="outline"
            icon="user"
            onClick={() => setActiveTab("addBid")}
            className="text-xs font-bold"
          >
            + Submit Vendor Quote
          </Button>
          <Button
            variant="primary"
            icon="cart"
            onClick={() => setActiveTab("rfqs")}
            className="text-xs font-bold shadow-sm"
          >
            🛒 View Open RFQs ({rfqs.filter((r) => r.status === "Open Bidding").length})
          </Button>
        </div>
      </div>

      {/* ── Auto-Procure Engine Banner ──────────────────────────────────── */}
      <div className="p-3.5 bg-paper border border-hairline rounded-xl flex items-center justify-between flex-wrap gap-3 shadow-2xs">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${autoProcureEnabled ? "bg-emerald-100 text-emerald-800" : "bg-paper-2 text-ink-3"}`}>
            <Icon name="sparkles" size={18} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-xs text-ink uppercase tracking-wider">⚡ Auto-Procure & Lowest Margin Engine</span>
              <Badge kind={autoProcureEnabled ? "success" : "muted"} size="sm" className="font-bold text-[10px]">
                {autoProcureEnabled ? "ACTIVE (AUTO-ROUTING POs)" : "MANUAL MODE"}
              </Badge>
            </div>
            <p className="text-[11px] text-ink-3 mt-0.5">
              Automatically routes new customer subscription orders to the Distributor offering lowest rate & Net 30+ credit.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            setAutoProcureEnabled(!autoProcureEnabled);
            toast.success(autoProcureEnabled ? "Auto-Procure Engine set to Manual Mode." : "Auto-Procure Engine Enabled!");
          }}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            autoProcureEnabled ? "bg-emerald-600 text-white shadow-2xs" : "bg-paper-2 border border-hairline text-ink"
          }`}
        >
          {autoProcureEnabled ? "✓ Auto-Procure Enabled" : "Enable Auto-Procure Engine"}
        </button>
      </div>

      {/* ── KPI Summary Cards ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 bg-paper border-hairline shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-xs text-ink-3 font-semibold uppercase tracking-wider">
            <span>🏆 Best Workspace Deal</span>
            <Icon name="award" size={16} className="text-amber-ink" />
          </div>
          <div className="text-xl font-bold font-mono text-ink">₹120 / usr / mo</div>
          <div className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
            <span>By Redington India (30 Days Credit)</span>
          </div>
        </Card>

        <Card className="p-4 bg-paper border-hairline shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-xs text-ink-3 font-semibold uppercase tracking-wider">
            <span>🛍️ Active Sourcing RFQs</span>
            <Icon name="cart" size={16} className="text-primary" />
          </div>
          <div className="text-xl font-bold font-mono text-ink">
            {rfqs.filter((r) => r.status === "Open Bidding").length} Open Requests
          </div>
          <div className="text-[11px] text-ink-3 font-medium">
            275 total seats in active procurement
          </div>
        </Card>

        <Card className="p-4 bg-paper border-hairline shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-xs text-ink-3 font-semibold uppercase tracking-wider">
            <span>💰 Monthly COGS Volume</span>
            <Icon name="rupee" size={16} className="text-ink-2" />
          </div>
          <div className="text-xl font-bold font-mono text-ink">{rupee(485000)}</div>
          <div className="text-[11px] text-ink-3 font-medium">
            Across 4 active Distributors & Sub-Resellers
          </div>
        </Card>

        <Card className="p-4 bg-paper border-hairline shadow-2xs space-y-1">
          <div className="flex items-center justify-between text-xs text-ink-3 font-semibold uppercase tracking-wider">
            <span>⚡ Margin Saved via Bidding</span>
            <Icon name="trending_up" size={16} className="text-emerald-600" />
          </div>
          <div className="text-xl font-bold font-mono text-emerald-600">14.2% Extra Profit</div>
          <div className="text-[11px] text-emerald-600 font-semibold">
            Saved ₹38,400 vs standard Google SRP list rate!
          </div>
        </Card>
      </div>

      {/* ── Navigation Tabs ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-hairline overflow-x-auto pb-2">
        <button
          type="button"
          onClick={() => setActiveTab("comparison")}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap flex items-center gap-2 ${
            activeTab === "comparison"
              ? "bg-primary text-white shadow-xs"
              : "bg-paper-2/70 text-ink-3 hover:text-ink"
          }`}
        >
          <Icon name="sparkles" size={14} />
          <span>🏆 Wholesale Rates & Bids</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("calculator")}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap flex items-center gap-2 ${
            activeTab === "calculator"
              ? "bg-primary text-white shadow-xs"
              : "bg-paper-2/70 text-ink-3 hover:text-ink"
          }`}
        >
          <Icon name="trending_up" size={14} />
          <span>📊 Live Margin Profit Calculator</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("rfqs")}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap flex items-center gap-2 ${
            activeTab === "rfqs"
              ? "bg-primary text-white shadow-xs"
              : "bg-paper-2/70 text-ink-3 hover:text-ink"
          }`}
        >
          <Icon name="cart" size={14} />
          <span>🛒 Active Sourcing RFQs ({rfqs.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("scorecards")}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap flex items-center gap-2 ${
            activeTab === "scorecards"
              ? "bg-primary text-white shadow-xs"
              : "bg-paper-2/70 text-ink-3 hover:text-ink"
          }`}
        >
          <Icon name="award" size={14} />
          <span>⭐ Vendor SLA & Reliability Scorecards</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("addBid")}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap flex items-center gap-2 ${
            activeTab === "addBid"
              ? "bg-primary text-white shadow-xs"
              : "bg-paper-2/70 text-ink-3 hover:text-ink"
          }`}
        >
          <Icon name="user" size={14} />
          <span>+ Submit Vendor Rate Quote</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("bills")}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap flex items-center gap-2 ${
            activeTab === "bills"
              ? "bg-primary text-white shadow-xs"
              : "bg-paper-2/70 text-ink-3 hover:text-ink"
          }`}
        >
          <Icon name="receipt" size={14} />
          <span>🧾 Vendor COGS Bills & Ledger</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("keys")}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap flex items-center gap-2 ${
            activeTab === "keys"
              ? "bg-primary text-white shadow-xs"
              : "bg-paper-2/70 text-ink-3 hover:text-ink"
          }`}
        >
          <Icon name="file" size={14} />
          <span>🔑 License Provisioning Keys</span>
        </button>
      </div>

      {/* ── TAB 1: Wholesale Rate Comparison & Bids Matrix ───────────────── */}
      {activeTab === "comparison" && (
        <div className="space-y-4">
          {/* SKU & Source Filter Bar */}
          <div className="flex items-center justify-between flex-wrap gap-3 bg-paper p-3 border border-hairline rounded-xl shadow-2xs">
            <div className="flex flex-wrap items-center gap-3">
              {/* Source Filter Group */}
              <div className="flex items-center gap-1 bg-paper-2 p-1 rounded-lg border border-hairline">
                <button
                  type="button"
                  onClick={() => setVendorSourceFilter("all")}
                  className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                    vendorSourceFilter === "all"
                      ? "bg-paper text-primary shadow-2xs font-extrabold"
                      : "text-ink-3 hover:text-ink"
                  }`}
                >
                  All Vendors ({mergedBids.length})
                </button>
                <button
                  type="button"
                  onClick={() => setVendorSourceFilter("dbOnly")}
                  className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all cursor-pointer flex items-center gap-1 ${
                    vendorSourceFilter === "dbOnly"
                      ? "bg-primary text-white shadow-2xs font-extrabold"
                      : "text-ink-3 hover:text-ink"
                  }`}
                >
                  <span>🏛️ My Vendors Master</span>
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-white/20 text-white font-mono font-bold">
                    {mergedBids.filter((b) => b.isFromDb).length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setVendorSourceFilter("benchmarks")}
                  className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all cursor-pointer ${
                    vendorSourceFilter === "benchmarks"
                      ? "bg-paper text-ink font-extrabold shadow-2xs"
                      : "text-ink-3 hover:text-ink"
                  }`}
                >
                  🌐 Tier-1 CSP Benchmarks ({mergedBids.filter((b) => !b.isFromDb).length})
                </button>
              </div>

              {/* SKU Filter Group */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-ink-3 uppercase tracking-wider">SKU:</span>
                <div className="flex flex-wrap gap-1">
                  {skus.map((sku) => (
                    <button
                      key={sku}
                      type="button"
                      onClick={() => setSelectedSku(sku)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                        selectedSku === sku
                          ? "bg-amber text-paper font-bold shadow-2xs"
                          : "bg-paper-2 text-ink-3 hover:text-ink"
                      }`}
                    >
                      {sku}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="text-xs text-ink-3 font-semibold">
              Showing <b>{filteredBids.length}</b> rate bids
            </div>
          </div>

          {/* Wholesale Bids Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredBids.map((bid) => (
              <Card
                key={bid.id}
                className={`p-5 space-y-4 transition-all relative flex flex-col justify-between ${
                  bid.isBestValue
                    ? "border-2 border-amber-500 bg-amber-soft/20 shadow-md"
                    : "border-hairline bg-paper shadow-2xs"
                }`}
              >
                {/* Best Value Ribbon */}
                {bid.isBestValue && (
                  <div className="absolute -top-3 right-4 bg-amber-500 text-white font-bold text-[10px] uppercase tracking-wider px-3 py-0.5 rounded-full shadow-xs flex items-center gap-1">
                    <Icon name="award" size={12} />
                    <span>Best Price & Margin Deal</span>
                  </div>
                )}

                {/* Source Badge */}
                <div className="flex items-center justify-between pt-1">
                  {bid.isFromDb ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-primary-soft text-primary border border-primary/20">
                      🏛️ Vendors Master
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-paper-2 text-ink-3 border border-hairline">
                      🌐 CSP Benchmark Rate
                    </span>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-bold text-base text-ink flex items-center gap-1.5">
                        <span>{bid.vendorName}</span>
                      </h3>
                      <Badge kind="info" size="sm" className="mt-1 font-mono text-[10px]">
                        {bid.vendorCategory}
                      </Badge>
                    </div>

                    <div className="text-right">
                      <div className="text-xs font-bold text-emerald-600 flex items-center justify-end gap-1">
                        <Icon name="star" size={13} className="fill-emerald-500 text-emerald-500" />
                        <span>{bid.rating} ({bid.slaScore}% SLA)</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 bg-paper-2/60 border border-hairline rounded-xl space-y-1.5">
                    <div className="text-xs font-bold text-primary">{bid.productSku}</div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-ink-3">Wholesale Unit Rate:</span>
                      <div className="text-right">
                        <span className="text-lg font-bold font-mono text-ink">
                          {rupee(bid.unitCostMonthly)}
                        </span>
                        <span className="text-[11px] text-ink-3"> / user / mo</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-ink-3 pt-1 border-t border-hairline/60">
                      <span>Annual Cost: <b>{rupee(bid.unitCostYearly)}/yr</b></span>
                      <span>Credit: <b>{bid.creditDays ? `${bid.creditDays} Days Net` : "Prepaid"}</b></span>
                    </div>
                  </div>

                  {bid.notes && (
                    <p className="text-xs text-ink-2 bg-paper p-2 rounded-lg border border-hairline/50 italic">
                      “{bid.notes}”
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-hairline space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-ink-3">
                    <span className="flex items-center gap-1">
                      <Icon name="clock" size={13} />
                      <span>Speed: <b>{bid.provisioningTime}</b></span>
                    </span>
                    <span className="text-[10px] text-ink-3">Updated {bid.updatedAt}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingBid(bid)}
                      className="text-xs font-semibold text-ink w-full justify-center"
                    >
                      ✏️ Edit Card
                    </Button>
                    <Button
                      variant={bid.isBestValue ? "primary" : "outline"}
                      size="sm"
                      icon="cart"
                      onClick={() => handlePlacePo(bid)}
                      className="text-xs font-bold w-full justify-center"
                    >
                      Place PO
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── TAB 2: Live Margin & Profitability Calculator ─────────────────── */}
      {activeTab === "calculator" && (
        <Card className="p-6 bg-paper border-hairline shadow-md space-y-6">
          <div>
            <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
              <Icon name="trending_up" size={16} />
              <span>Real-Time Sourcing Profitability Matrix</span>
            </div>
            <h2 className="text-xl font-bold font-serif text-ink">Margin & Profitability Calculator</h2>
            <p className="text-xs text-ink-3 mt-1">
              Input your customer selling price and seat count to see real-time gross profit & margin % across all vendor bids!
            </p>
          </div>

          {/* Calculator Inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 bg-paper-2/60 border border-hairline rounded-xl">
            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Select Product SKU
              </label>
              <select
                value={calcSelectedSku}
                onChange={(e) => setCalcSelectedSku(e.target.value)}
                className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm font-semibold focus:border-amber"
              >
                <option value="Google Workspace Business Starter">Google Workspace Business Starter</option>
                <option value="Google Workspace Business Standard">Google Workspace Business Standard</option>
                <option value="Microsoft 365 Business Basic">Microsoft 365 Business Basic</option>
              </select>
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Client Selling Price (₹/usr/mo)
              </label>
              <Input
                type="number"
                value={calcSellingPrice}
                onChange={(e) => setCalcSellingPrice(Number(e.target.value) || 0)}
                className="bg-paper font-mono font-bold text-sm"
              />
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Total Seat Quantity
              </label>
              <Input
                type="number"
                value={calcQuantity}
                onChange={(e) => setCalcQuantity(Number(e.target.value) || 0)}
                className="bg-paper font-mono font-bold text-sm"
              />
            </div>
          </div>

          {/* Profit Comparison Table */}
          <div className="space-y-3">
            <h3 className="text-xs uppercase tracking-wider font-bold text-ink-3">
              Profitability Breakdown across Vendor Quotes:
            </h3>

            <div className="overflow-x-auto border border-hairline rounded-xl overflow-hidden shadow-2xs">
              <table className="w-full text-xs text-left">
                <thead className="bg-paper-2 text-ink-3 font-bold uppercase tracking-wider border-b border-hairline">
                  <tr>
                    <th className="p-3">Vendor Name</th>
                    <th className="p-3">Wholesale Buy Rate</th>
                    <th className="p-3">Credit Terms</th>
                    <th className="p-3 text-right">Profit / User / Month</th>
                    <th className="p-3 text-right">Monthly Total Revenue</th>
                    <th className="p-3 text-right">Monthly Total Profit</th>
                    <th className="p-3 text-right">Gross Margin %</th>
                    <th className="p-3 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline bg-paper">
                  {calcBids.map((b) => {
                    const profitPerUser = Math.max(0, calcSellingPrice - b.unitCostMonthly);
                    const totalRevenue = calcSellingPrice * calcQuantity;
                    const totalProfit = profitPerUser * calcQuantity;
                    const marginPct = calcSellingPrice > 0 ? ((profitPerUser / calcSellingPrice) * 100).toFixed(1) : "0.0";

                    return (
                      <tr key={b.id} className={b.isBestValue ? "bg-amber-soft/30 font-semibold" : "hover:bg-paper-2/50"}>
                        <td className="p-3 font-bold text-ink flex items-center gap-1.5">
                          {b.isBestValue && <Icon name="award" size={14} className="text-amber-ink" />}
                          <span>{b.vendorName}</span>
                        </td>
                        <td className="p-3 font-mono font-bold text-ink">{rupee(b.unitCostMonthly)}/mo</td>
                        <td className="p-3 text-ink-3">{b.creditDays ? `${b.creditDays} Days Net` : "Prepaid"}</td>
                        <td className="p-3 text-right font-mono font-bold text-emerald-600">+{rupee(profitPerUser)}</td>
                        <td className="p-3 text-right font-mono text-ink">{rupee(totalRevenue)}</td>
                        <td className="p-3 text-right font-mono font-bold text-emerald-600">{rupee(totalProfit)}/mo</td>
                        <td className="p-3 text-right font-bold text-emerald-600">{marginPct}%</td>
                        <td className="p-3 text-center">
                          <Button
                            variant={b.isBestValue ? "primary" : "outline"}
                            size="sm"
                            onClick={() => handlePlacePo(b)}
                            className="text-xs py-1"
                          >
                            Select Vendor
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      )}

      {/* ── TAB 3: Active Sourcing RFQs (Requests for Quote) ─────────────── */}
      {activeTab === "rfqs" && (
        <div className="space-y-4">
          <div className="p-4 bg-paper border border-hairline rounded-xl space-y-1">
            <h3 className="font-bold text-sm text-ink flex items-center gap-2">
              <Icon name="cart" size={16} className="text-primary" />
              <span>Active Sourcing Requests (RFQs) for Sub-Resellers & Vendors</span>
            </h3>
            <p className="text-xs text-ink-3">
              Open procurement requests created for new client orders or bulk renewals. Vendors submit bids to win the PO!
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {rfqs.map((rfq) => (
              <Card key={rfq.id} className="p-5 space-y-4 bg-paper border-hairline shadow-2xs">
                <div className="flex items-center justify-between">
                  <Badge kind="outline" size="sm" className="font-mono text-xs">
                    {rfq.rfqCode}
                  </Badge>
                  <Badge
                    kind={rfq.status === "Open Bidding" ? "warning" : "success"}
                    size="sm"
                    className="font-bold text-[11px]"
                  >
                    {rfq.status}
                  </Badge>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-ink-3 font-semibold uppercase tracking-wider">Client Requirement</div>
                  <h4 className="font-bold text-sm text-ink">{rfq.clientName}</h4>
                  <div className="text-xs font-bold text-primary">{rfq.productSku}</div>
                </div>

                <div className="p-3 bg-paper-2/60 border border-hairline rounded-xl space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-ink-3">Required Quantity:</span>
                    <span className="font-bold text-ink">{rfq.requiredQuantity} Licenses</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-3">Target Budget / Unit:</span>
                    <span className="font-bold font-mono text-ink">{rupee(rfq.targetBudgetPerUnit)}/mo</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-3">Client Selling Price:</span>
                    <span className="font-bold font-mono text-emerald-600">{rupee(rfq.customerSellingPrice)}/mo</span>
                  </div>
                  <div className="flex justify-between pt-1 border-t border-hairline/60">
                    <span className="text-ink-3">Current Lowest Bid:</span>
                    <span className="font-bold font-mono text-amber-ink">
                      {rfq.lowestBidRate ? `${rupee(rfq.lowestBidRate)}/mo` : "No bids"}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-hairline">
                  <div className="text-xs font-bold text-amber-ink flex items-center gap-1">
                    <Icon name="users" size={14} />
                    <span>{rfq.bidsCount} Vendor Bids Submitted</span>
                  </div>

                  {rfq.status === "Open Bidding" ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleAcceptRfqBid(rfq)}
                      className="text-xs font-bold"
                    >
                      🏆 Accept Best Bid
                    </Button>
                  ) : (
                    <span className="text-xs font-bold text-emerald-600">✓ PO Dispatched</span>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── TAB 4: Vendor SLA & Reliability Scorecards ──────────────────── */}
      {activeTab === "scorecards" && (
        <div className="space-y-4">
          <div className="p-4 bg-paper border border-hairline rounded-xl space-y-1">
            <h3 className="font-bold text-sm text-ink flex items-center gap-2">
              <Icon name="award" size={16} className="text-amber-ink" />
              <span>Vendor SLA, Provisioning Speed & Reliability Scorecards</span>
            </h3>
            <p className="text-xs text-ink-3">
              Performance metrics for each Tier-1 Distributor & Sub-Reseller based on fulfillment speed, SLA adherence, and total profit margin saved.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {VENDOR_SCORECARDS.map((sc, idx) => (
              <Card key={idx} className="p-5 bg-paper border-hairline shadow-2xs space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <h4 className="font-bold text-base text-ink">{sc.vendorName}</h4>
                    <Badge kind="info" size="sm" className="mt-1 font-bold text-[10px]">
                      {sc.tierStatus}
                    </Badge>
                  </div>

                  <div className="text-right">
                    <div className="text-lg font-bold font-mono text-emerald-600">{sc.slaAdherencePct}%</div>
                    <div className="text-[10px] text-ink-3 uppercase tracking-wider font-bold">SLA Adherence</div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 p-3 bg-paper-2/60 border border-hairline rounded-xl text-xs text-center">
                  <div>
                    <div className="text-ink-3 text-[10px] uppercase font-bold">Orders Fulfilled</div>
                    <div className="font-bold font-mono text-ink mt-0.5">{sc.totalOrdersFulfilled}</div>
                  </div>
                  <div>
                    <div className="text-ink-3 text-[10px] uppercase font-bold">Avg Speed</div>
                    <div className="font-bold font-mono text-ink mt-0.5">{sc.avgProvisioningMinutes} Mins</div>
                  </div>
                  <div>
                    <div className="text-ink-3 text-[10px] uppercase font-bold">Margin Saved</div>
                    <div className="font-bold font-mono text-emerald-600 mt-0.5">{rupee(sc.marginSavingsGenerated)}</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── TAB 5: Submit New Vendor Quote Form ──────────────────────────── */}
      {activeTab === "addBid" && (
        <Card className="p-6 max-w-2xl mx-auto bg-paper border-hairline shadow-md space-y-6">
          <div>
            <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
              <Icon name="sparkles" size={16} />
              <span>Vendor Wholesale Rate Submission</span>
            </div>
            <h2 className="text-xl font-bold font-serif text-ink">Submit Vendor Rate Quote / Margin Bid</h2>
            <p className="text-xs text-ink-3 mt-1">
              Enter wholesale rate quotes offered by direct distributors or sub-resellers to compare margins and automate PO sourcing.
            </p>
          </div>

          <form onSubmit={handleAddBid} className="space-y-4">
            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Vendor / Sub-Reseller Name *
              </label>
              <Input
                required
                placeholder="e.g. Redington India, Ingram Micro, Savex, Crayon..."
                value={newVendorName}
                onChange={(e) => setNewVendorName(e.target.value)}
                className="bg-paper"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                  Vendor Partner Tier *
                </label>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as any)}
                  className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm focus:border-amber"
                >
                  <option value="Tier 1 CSP Distributor">Tier 1 CSP Distributor (Direct Google Partner)</option>
                  <option value="Direct Sub-Reseller">Direct Sub-Reseller / Regional Partner</option>
                  <option value="Authorized Regional Partner">Authorized Regional Partner</option>
                </select>
              </div>

              <div>
                <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                  Product License SKU *
                </label>
                <select
                  value={newProductSku}
                  onChange={(e) => setNewProductSku(e.target.value)}
                  className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm focus:border-amber font-semibold"
                >
                  <option value="Google Workspace Business Starter">Google Workspace Business Starter</option>
                  <option value="Google Workspace Business Standard">Google Workspace Business Standard</option>
                  <option value="Google Workspace Business Plus">Google Workspace Business Plus</option>
                  <option value="Microsoft 365 Business Basic">Microsoft 365 Business Basic</option>
                  <option value="Microsoft 365 Business Standard">Microsoft 365 Business Standard</option>
                  <option value="Zoho One License">Zoho One License</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                  Wholesale Unit Rate (₹/usr/mo) *
                </label>
                <Input
                  required
                  type="number"
                  placeholder="e.g. 120"
                  value={newMonthlyCost}
                  onChange={(e) => setNewMonthlyCost(e.target.value)}
                  className="bg-paper font-mono font-bold"
                />
              </div>

              <div>
                <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                  Payment Credit Terms *
                </label>
                <select
                  value={newCreditDays}
                  onChange={(e) => setNewCreditDays(e.target.value)}
                  className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm focus:border-amber"
                >
                  <option value="0">Prepaid (0 Days)</option>
                  <option value="15">15 Days Net Credit</option>
                  <option value="30">30 Days Net Credit</option>
                  <option value="45">45 Days Net Credit</option>
                </select>
              </div>

              <div>
                <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                  Provisioning Speed *
                </label>
                <select
                  value={newProvisioningTime}
                  onChange={(e) => setNewProvisioningTime(e.target.value)}
                  className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm focus:border-amber"
                >
                  <option value="Instant API (< 5 Mins)">Instant API (&lt; 5 Mins)</option>
                  <option value="30 Minutes">30 Minutes Turnaround</option>
                  <option value="Same Day">Same Day Delivery</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-ink-3 font-bold mb-1">
                Special Discount Notes / Volume Tiers
              </label>
              <textarea
                rows={3}
                placeholder="e.g. Extra 5% off for >100 licenses. Free migration support included."
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                className="w-full rounded-xl border border-hairline bg-paper px-3 py-2 text-sm focus:border-amber"
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="button" variant="outline" onClick={() => setActiveTab("comparison")} className="flex-1">
                Cancel
              </Button>
              <Button type="submit" variant="primary" icon="sparkles" className="flex-1 font-bold">
                🏆 Submit Rate & Update Matrix
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* ── TAB 6: Vendor COGS Bills & Ledger ───────────────────────────── */}
      {activeTab === "bills" && (
        <div className="space-y-4">
          <div className="p-4 bg-paper border border-hairline rounded-xl flex items-center justify-between">
            <div>
              <h3 className="font-bold text-sm text-ink">Vendor COGS Bills & Payment Ledger</h3>
              <p className="text-xs text-ink-3">Track invoices submitted by distributors and sub-resellers with payment status & TDS deductions.</p>
            </div>
            <Badge kind="info" size="sm" className="font-mono text-xs">
              Total Bills: {bills.length}
            </Badge>
          </div>

          <Card className="overflow-hidden border-hairline bg-paper shadow-2xs">
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-paper-2 text-ink-3 font-bold uppercase tracking-wider border-b border-hairline">
                  <tr>
                    <th className="p-3">Bill #</th>
                    <th className="p-3">Vendor / Supplier</th>
                    <th className="p-3">Product / Seats</th>
                    <th className="p-3 text-right">Bill Amount</th>
                    <th className="p-3 text-right">TDS (2%)</th>
                    <th className="p-3">Due Date</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {bills.map((b) => (
                    <tr key={b.id} className="hover:bg-paper-2/50 transition-all">
                      <td className="p-3 font-mono font-bold text-ink">{b.billNumber}</td>
                      <td className="p-3 font-bold text-ink">{b.vendorName}</td>
                      <td className="p-3 text-ink-2">{b.productSku}</td>
                      <td className="p-3 text-right font-mono font-bold text-ink">{rupee(b.amount)}</td>
                      <td className="p-3 text-right font-mono text-ink-3">{rupee(b.tdsAmount)}</td>
                      <td className="p-3 font-medium text-ink-3">{formatDate(b.dueDate)}</td>
                      <td className="p-3">
                        <Badge
                          kind={b.status === "Paid" ? "success" : b.status === "Overdue" ? "danger" : "warning"}
                          size="sm"
                          className="font-bold"
                        >
                          {b.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ── TAB 7: License Provisioning Keys ────────────────────────────── */}
      {activeTab === "keys" && (
        <Card className="p-6 bg-paper border-hairline shadow-2xs space-y-4">
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider">
            <Icon name="file" size={16} />
            <span>License Fulfillment & Partner Provisioning Keys</span>
          </div>

          <p className="text-xs text-ink-3">
            Sub-resellers & distributors log license activation links, Google CSP domain transfer tokens, and Partner IDs here upon PO fulfillment.
          </p>

          <div className="space-y-3">
            {bids.map((b) => (
              <div key={b.id} className="p-4 bg-paper-2/60 border border-hairline rounded-xl space-y-2">
                <div className="flex items-center justify-between text-xs border-b border-hairline pb-2">
                  <div>
                    <span className="font-bold text-ink">{b.vendorName}</span>
                    <span className="text-ink-3 ml-2">({b.productSku})</span>
                  </div>
                  <Badge kind="info" size="sm" className="font-mono text-xs">
                    Partner ID: {b.partnerId || "RED-99120"}
                  </Badge>
                </div>

                <div className="flex items-center gap-3">
                  <Input
                    readOnly
                    value={`https://admin.google.com/TransferToken?resellerId=${b.partnerId || "99182-IN"}`}
                    className="bg-paper text-xs font-mono"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(`https://admin.google.com/TransferToken?resellerId=${b.partnerId || "99182-IN"}`);
                      toast.success("Transfer Token link copied!");
                    }}
                    className="text-xs shrink-0"
                  >
                    📋 Copy Link
                  </Button>
                </div>

                {b.supportContact && (
                  <div className="text-[11px] text-ink-3 flex items-center gap-1 pt-1">
                    <Icon name="mail" size={12} />
                    <span>Support Desk: <b>{b.supportContact}</b></span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {editingBid && (
        <EditVendorCardModal
          bid={editingBid}
          onClose={() => setEditingBid(null)}
          onSave={handleSaveEditedBid}
        />
      )}
    </div>
  );
}
