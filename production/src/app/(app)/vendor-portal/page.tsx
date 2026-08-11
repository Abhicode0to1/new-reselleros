"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { rupee, formatDate } from "@/lib/utils";
import { toast } from "sonner";

// ── Types ────────────────────────────────────────────────────────────────────

export interface VendorBid {
  id: string;
  vendorName: string;
  vendorCategory: "Tier 1 Distributor" | "Direct Sub-Reseller" | "Authorized Partner";
  productSku: string;
  unitCostMonthly: number;
  unitCostYearly: number;
  creditDays: number; // e.g. 0 = Prepaid, 30 = Net 30
  provisioningTime: string;
  rating: number; // e.g. 4.9
  isBestValue?: boolean;
  notes?: string;
  updatedAt: string;
}

export interface SourcingRfq {
  id: string;
  rfqCode: string;
  clientName: string;
  productSku: string;
  requiredQuantity: number;
  targetBudgetPerUnit: number;
  deadlineDate: string;
  status: "Open Bidding" | "PO Issued" | "Completed";
  bidsCount: number;
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
}

// ── Initial Mock Data ────────────────────────────────────────────────────────

const INITIAL_BIDS: VendorBid[] = [
  {
    id: "bid-1",
    vendorName: "Redington India Ltd",
    vendorCategory: "Tier 1 Distributor",
    productSku: "Google Workspace Business Starter",
    unitCostMonthly: 120,
    unitCostYearly: 1440,
    creditDays: 30,
    provisioningTime: "Instant API",
    rating: 4.9,
    isBestValue: true,
    notes: "Volume discount applied for >50 users. Net 30 credit.",
    updatedAt: "2026-08-10",
  },
  {
    id: "bid-2",
    vendorName: "Ingram Micro Cloud",
    vendorCategory: "Tier 1 Distributor",
    productSku: "Google Workspace Business Starter",
    unitCostMonthly: 125,
    unitCostYearly: 1500,
    creditDays: 15,
    provisioningTime: "1 Hour",
    rating: 4.8,
    isBestValue: false,
    notes: "Includes free setup migration assistance.",
    updatedAt: "2026-08-09",
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
    rating: 4.7,
    isBestValue: false,
    notes: "Special sub-reseller margin deal.",
    updatedAt: "2026-08-11",
  },
  {
    id: "bid-4",
    vendorName: "Crayon Software Experts",
    vendorCategory: "Tier 1 Distributor",
    productSku: "Google Workspace Business Standard",
    unitCostMonthly: 640,
    unitCostYearly: 7680,
    creditDays: 45,
    provisioningTime: "Instant API",
    rating: 4.9,
    isBestValue: true,
    notes: "Includes 2 TB Pooled Cloud Storage per user & Meet recording.",
    updatedAt: "2026-08-11",
  },
  {
    id: "bid-5",
    vendorName: "Redington India Ltd",
    vendorCategory: "Tier 1 Distributor",
    productSku: "Google Workspace Business Standard",
    unitCostMonthly: 660,
    unitCostYearly: 7920,
    creditDays: 30,
    provisioningTime: "Instant API",
    rating: 4.9,
    isBestValue: false,
    notes: "Standard CSP margin rate.",
    updatedAt: "2026-08-08",
  },
  {
    id: "bid-6",
    vendorName: "Tech Data India",
    vendorCategory: "Tier 1 Distributor",
    productSku: "Microsoft 365 Business Basic",
    unitCostMonthly: 115,
    unitCostYearly: 1380,
    creditDays: 30,
    provisioningTime: "Instant API",
    rating: 4.8,
    isBestValue: true,
    notes: "Includes M365 Admin Portal provisioning.",
    updatedAt: "2026-08-10",
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
    deadlineDate: "2026-08-15",
    status: "Open Bidding",
    bidsCount: 3,
  },
  {
    id: "rfq-2",
    rfqCode: "RFQ-2026-090",
    clientName: "Acme Logistics Solutions",
    productSku: "Google Workspace Business Standard",
    requiredQuantity: 45,
    targetBudgetPerUnit: 650,
    deadlineDate: "2026-08-18",
    status: "Open Bidding",
    bidsCount: 2,
  },
  {
    id: "rfq-3",
    rfqCode: "RFQ-2026-082",
    clientName: "Matrix Infotech",
    productSku: "Microsoft 365 Business Basic",
    requiredQuantity: 80,
    targetBudgetPerUnit: 120,
    deadlineDate: "2026-08-10",
    status: "PO Issued",
    bidsCount: 4,
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
  },
];

// ── Main Page Component ──────────────────────────────────────────────────────

export default function VendorPortalPage() {
  const [activeTab, setActiveTab] = React.useState<"comparison" | "addBid" | "rfqs" | "bills" | "keys">("comparison");
  const [bids, setBids] = React.useState<VendorBid[]>(INITIAL_BIDS);
  const [rfqs, setRfqs] = React.useState<SourcingRfq[]>(INITIAL_RFQS);
  const [bills] = React.useState<VendorBillItem[]>(INITIAL_BILLS);
  const [selectedSku, setSelectedSku] = React.useState<string>("All");

  // Form State for New Vendor Quote Bid
  const [newVendorName, setNewVendorName] = React.useState("");
  const [newCategory, setNewCategory] = React.useState<VendorBid["vendorCategory"]>("Direct Sub-Reseller");
  const [newProductSku, setNewProductSku] = React.useState("Google Workspace Business Starter");
  const [newMonthlyCost, setNewMonthlyCost] = React.useState("");
  const [newCreditDays, setNewCreditDays] = React.useState("30");
  const [newProvisioningTime, setNewProvisioningTime] = React.useState("Instant API");
  const [newNotes, setNewNotes] = React.useState("");

  // Product SKUs for filtering
  const skus = React.useMemo(() => {
    const list = Array.from(new Set(bids.map((b) => b.productSku)));
    return ["All", ...list];
  }, [bids]);

  // Filtered Bids
  const filteredBids = React.useMemo(() => {
    if (selectedSku === "All") return bids;
    return bids.filter((b) => b.productSku === selectedSku);
  }, [bids, selectedSku]);

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
      rating: 4.8,
      notes: newNotes.trim() || undefined,
      updatedAt: new Date().toISOString().split("T")[0],
    };

    // Update bids array & check best value flag
    setBids((prev) => {
      const updated = [newBidItem, ...prev];
      // Recalculate best value per SKU
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

  return (
    <div className="space-y-6 pb-12 max-w-7xl mx-auto px-4 sm:px-6">
      {/* ── Page Title & Action Header ───────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
            <Icon name="sparkles" size={16} />
            <span>ResellerOS Sub-Reseller & Vendor Marketplace</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-ink">
            Vendor Portal & Wholesale Rate Bidding Hub
          </h1>
          <p className="text-xs sm:text-sm text-ink-3 mt-1">
            Compare wholesale unit rates from Tier-1 Distributors & Sub-Resellers. Sourcing deals with maximum profit margins!
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            icon="sparkles"
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
          <span>🏆 Wholesale Rate Comparison & Bids</span>
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
          {/* SKU Filter Bar */}
          <div className="flex items-center justify-between flex-wrap gap-3 bg-paper p-3 border border-hairline rounded-xl shadow-2xs">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-ink-3 uppercase tracking-wider">Filter Product SKU:</span>
              <div className="flex flex-wrap gap-1.5">
                {skus.map((sku) => (
                  <button
                    key={sku}
                    type="button"
                    onClick={() => setSelectedSku(sku)}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
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

            <div className="text-xs text-ink-3">
              Showing <b>{filteredBids.length}</b> vendor rate bids
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
                    <span>🏆 Best Price & Margin Deal</span>
                  </div>
                )}

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
                        <span>{bid.rating} Rating</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 bg-paper-2/60 border border-hairline rounded-xl space-y-1.5">
                    <div className="text-xs font-bold text-primary">{bid.productSku}</div>
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-ink-3">Wholesale Rate:</span>
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

                <div className="pt-3 border-t border-hairline flex items-center justify-between gap-2">
                  <div className="text-[11px] text-ink-3 flex items-center gap-1">
                    <Icon name="clock" size={13} />
                    <span>Time: <b>{bid.provisioningTime}</b></span>
                  </div>

                  <Button
                    variant={bid.isBestValue ? "primary" : "outline"}
                    size="sm"
                    icon="cart"
                    onClick={() => handlePlacePo(bid)}
                    className="text-xs font-bold"
                  >
                    🛒 Place PO
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ── TAB 2: Active Sourcing RFQs (Requests for Quote) ─────────────── */}
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

                <div className="p-3 bg-paper-2/60 border border-hairline rounded-xl space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-ink-3">Required Quantity:</span>
                    <span className="font-bold text-ink">{rfq.requiredQuantity} Licenses</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-3">Target Budget / Unit:</span>
                    <span className="font-bold font-mono text-ink">{rupee(rfq.targetBudgetPerUnit)}/mo</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-3">Deadline:</span>
                    <span className="font-semibold text-rose-600">{formatDate(rfq.deadlineDate)}</span>
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

      {/* ── TAB 3: Submit New Vendor Quote Form ──────────────────────────── */}
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
                  <option value="Tier 1 Distributor">Tier 1 Distributor (Direct CSP)</option>
                  <option value="Direct Sub-Reseller">Direct Sub-Reseller / Partner</option>
                  <option value="Authorized Partner">Authorized Regional Partner</option>
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
                  <option value="Instant API">Instant API Auto-Provision</option>
                  <option value="1 Hour">1 Hour Turnaround</option>
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

      {/* ── TAB 4: Vendor COGS Bills & Ledger ───────────────────────────── */}
      {activeTab === "bills" && (
        <div className="space-y-4">
          <div className="p-4 bg-paper border border-hairline rounded-xl flex items-center justify-between">
            <div>
              <h3 className="font-bold text-sm text-ink">Vendor COGS Bills & Payment Ledger</h3>
              <p className="text-xs text-ink-3">Track invoices submitted by distributors and sub-resellers with payment status.</p>
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

      {/* ── TAB 5: License Provisioning Keys ────────────────────────────── */}
      {activeTab === "keys" && (
        <Card className="p-6 bg-paper border-hairline shadow-2xs space-y-4">
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider">
            <Icon name="file" size={16} />
            <span>License Fulfillment & Partner Provisioning Keys</span>
          </div>

          <p className="text-xs text-ink-3">
            Sub-resellers & distributors log license activation links, Google CSP domain transfer tokens, and Partner IDs here upon PO fulfillment.
          </p>

          <div className="p-4 bg-paper-2/60 border border-hairline rounded-xl space-y-3">
            <div className="flex items-center justify-between text-xs border-b border-hairline pb-2">
              <div>
                <span className="font-bold text-ink">Google Workspace Transfer Token Desk</span>
                <p className="text-[11px] text-ink-3">For transferring existing domains under sub-reseller console.</p>
              </div>
              <Badge kind="info" size="sm" className="font-mono text-xs">Partner ID: 99182-IN</Badge>
            </div>

            <div className="flex items-center gap-3">
              <Input
                readOnly
                value="https://admin.google.com/TransferToken?resellerId=99182-IN"
                className="bg-paper text-xs font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText("https://admin.google.com/TransferToken?resellerId=99182-IN");
                  toast.success("Transfer Token link copied!");
                }}
                className="text-xs shrink-0"
              >
                📋 Copy Link
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
