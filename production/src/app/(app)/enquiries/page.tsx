/**
 * Outlook-Style CRM Sales Email Suite — /enquiries
 *
 * Microsoft Outlook 3-Pane Email Hub:
 *   - Pane 1: Folders & Smart Filters (All, Untriaged, Converted Leads, Thread Replies, Skipped)
 *   - Pane 2: Email Threads List (Search bar, Sender avatars, Relative timestamps, Badges)
 *   - Pane 3: Rich Email Reading Pane + AI Gemini Draft Assistant + Instant CRM Actions
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { formatDate } from "@/lib/utils";
import { useInboundEmails, useConvertInboundToLead } from "@/lib/queries/inbound-emails";
import { inboundStatusMeta, canConvertToLead } from "@/lib/inbound/status";
import type { InboundEmailRow } from "@/lib/supabase/database.types";
import { toast } from "sonner";

type FilterFolder = "all" | "untriaged" | "leads" | "appended" | "skipped";

function StatusBadge({ status }: { status: string }) {
  const meta = inboundStatusMeta(status);
  return <Badge kind={meta.kind} dot>{meta.label}</Badge>;
}

function senderLabel(e: InboundEmailRow): string {
  return e.from_name?.trim() || e.from_email || "Unknown sender";
}

function senderInitials(e: InboundEmailRow): string {
  const name = senderLabel(e);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export default function EnquiriesOutlookPage() {
  const { data: rows, isLoading, error, refetch } = useInboundEmails();
  const convert = useConvertInboundToLead();

  const [activeFolder, setActiveFolder] = React.useState<FilterFolder>("all");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  // AI Reply State
  const [isAiDrafting, setIsAiDrafting] = React.useState(false);
  const [aiDraft, setAiDraft] = React.useState<{ subject: string; message: string } | null>(null);
  const [showReplyComposer, setShowReplyComposer] = React.useState(false);

  // Folder Counts & Stats
  const totals = React.useMemo(() => {
    const list = rows ?? [];
    return {
      total:     list.length,
      untriaged: list.filter((r) => r.status === "received" && !r.lead_id).length,
      leads:     list.filter((r) => !!r.lead_id).length,
      appended:  list.filter((r) => r.status === "appended_to_lead").length,
      skipped:   list.filter((r) => r.status === "skipped_non_enquiry").length,
    };
  }, [rows]);

  // Filtered Threads
  const filteredRows = React.useMemo(() => {
    let list = rows ?? [];

    // Apply Folder Filter
    if (activeFolder === "untriaged") {
      list = list.filter((r) => r.status === "received" && !r.lead_id);
    } else if (activeFolder === "leads") {
      list = list.filter((r) => !!r.lead_id);
    } else if (activeFolder === "appended") {
      list = list.filter((r) => r.status === "appended_to_lead");
    } else if (activeFolder === "skipped") {
      list = list.filter((r) => r.status === "skipped_non_enquiry");
    }

    // Apply Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((r) =>
        (r.from_name ?? "").toLowerCase().includes(q) ||
        (r.from_email ?? "").toLowerCase().includes(q) ||
        (r.subject ?? "").toLowerCase().includes(q) ||
        (r.body_text ?? "").toLowerCase().includes(q)
      );
    }

    return list;
  }, [rows, activeFolder, searchQuery]);

  // Auto-select first item if none selected or filter changes
  React.useEffect(() => {
    if (filteredRows.length > 0) {
      if (!selectedId || !filteredRows.some((r) => r.id === selectedId)) {
        setSelectedId(filteredRows[0].id);
      }
    } else {
      setSelectedId(null);
    }
  }, [filteredRows, selectedId]);

  // Currently Selected Thread
  const selectedThread = React.useMemo(
    () => (rows ?? []).find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  );

  // Clear AI draft when thread changes
  React.useEffect(() => {
    setAiDraft(null);
    setShowReplyComposer(false);
  }, [selectedId]);

  async function handleConvert(id: string) {
    await convert.mutateAsync(id);
  }

  // Generate AI Draft
  async function handleGenerateAiReply() {
    if (!selectedThread) return;
    setIsAiDrafting(true);
    setShowReplyComposer(true);

    try {
      const emailAddr = selectedThread.from_email || "customer@domain.com";
      const recipientName = (selectedThread.from_name || emailAddr).split("@")[0];
      const subject = selectedThread.subject ? `Re: ${selectedThread.subject.replace(/^Re:\s*/i, "")}` : "Reply regarding your enquiry";
      
      const response = await fetch("/api/ai/draft-followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: selectedThread.lead_id || undefined,
          channel: "email",
          purpose: "followup",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setAiDraft({
          subject: data.subject || subject,
          message: data.message || `Hi ${recipientName},\n\nThank you for reaching out regarding ${selectedThread.subject || "your enquiry"}.\n\nWe have received your requirements and our solutions team is preparing the details for you.\n\nBest regards,\nSales Team`,
        });
      } else {
        // Fallback Draft
        setAiDraft({
          subject,
          message: `Hi ${recipientName},\n\nThank you for getting in touch with us regarding ${selectedThread.subject || "your requirement"}.\n\nWe would be glad to assist you with our cloud license and software solutions. When would be a good time to connect over a brief call?\n\nBest regards,\nSales Team`,
        });
      }
    } catch {
      toast.error("Could not generate AI draft, using standard template.");
      setAiDraft({
        subject: selectedThread?.subject ? `Re: ${selectedThread.subject}` : "Enquiry Response",
        message: `Hi ${selectedThread?.from_name || "there"},\n\nThank you for reaching out. We have logged your enquiry and will assist you shortly.\n\nBest regards,`,
      });
    } finally {
      setIsAiDrafting(false);
    }
  }

  function handleCopyReply() {
    if (!aiDraft) return;
    const fullText = `Subject: ${aiDraft.subject}\n\n${aiDraft.message}`;
    navigator.clipboard.writeText(fullText);
    toast.success("AI draft response copied to clipboard!");
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1400px] mx-auto flex flex-col h-[calc(100vh-80px)]">
      {/* Top Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Sales CRM</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber/10 text-amber font-medium">Outlook Suite</span>
          </div>
          <h1 className="font-serif text-2xl md:text-3xl font-bold leading-tight">Sales Email Suite</h1>
        </div>

        {/* Stat Summary */}
        {!isLoading && !error && rows && rows.length > 0 && (
          <StatStrip
            className="py-1 px-3 border border-hairline bg-paper rounded-lg"
            items={[
              { label: "Untriaged", value: String(totals.untriaged), tone: totals.untriaged > 0 ? "amber" : undefined },
              { label: "Leads Created", value: String(totals.leads), tone: "emerald" },
              { label: "Total Mails", value: String(totals.total) },
            ]}
          />
        )}
      </div>

      {error && (
        <EmptyState
          icon="alert"
          title="Could not load email inbox"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {isLoading && (
        <Card flush className="flex-1 p-6 space-y-4">
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-3 gap-4 h-full">
            <Skeleton className="h-full w-full" />
            <Skeleton className="h-full w-full" />
            <Skeleton className="h-full w-full" />
          </div>
        </Card>
      )}

      {!isLoading && !error && rows && (
        <div className="flex-1 flex flex-col md:flex-row border border-hairline rounded-xl bg-paper overflow-hidden shadow-sm min-h-[550px] md:min-h-0">
          
          {/* ========================================================================= */}
          {/* PANE 1: FOLDERS & SMART FILTERS */}
          {/* ========================================================================= */}
          <div className="w-full md:w-48 lg:w-56 border-b md:border-b-0 md:border-r border-hairline bg-paper-2/30 flex flex-col p-3 shrink-0">
            <p className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold px-2 mb-2">Mail Folders</p>
            
            <nav className="space-y-1 flex-1">
              <button
                type="button"
                onClick={() => setActiveFolder("all")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "all" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="mail" size={15} />
                  <span>All Inbound</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">
                  {totals.total}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("untriaged")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "untriaged" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="inbox" size={15} />
                  <span>New to Triage</span>
                </div>
                {totals.untriaged > 0 ? (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-amber text-white font-semibold">
                    {totals.untriaged}
                  </span>
                ) : (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">0</span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("leads")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "leads" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="target" size={15} />
                  <span>Converted Leads</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">
                  {totals.leads}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("appended")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "appended" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="refresh" size={15} />
                  <span>Thread Replies</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">
                  {totals.appended}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("skipped")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "skipped" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="x" size={15} />
                  <span>Skipped / Spam</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">
                  {totals.skipped}
                </span>
              </button>
            </nav>

            <div className="mt-auto p-3 rounded-lg border border-hairline bg-paper text-xs text-ink-3 space-y-1">
              <div className="flex items-center gap-1.5 font-medium text-ink">
                <Icon name="sparkles" size={14} className="text-amber" />
                <span>AI Auto-Triage</span>
              </div>
              <p className="text-[11px] leading-tight">
                Gemini automatically extracts prospect details &amp; auto-creates leads for genuine enquiries.
              </p>
            </div>
          </div>

          {/* ========================================================================= */}
          {/* PANE 2: EMAIL THREADS LIST */}
          {/* ========================================================================= */}
          <div className="w-full md:w-64 lg:w-80 border-b md:border-b-0 md:border-r border-hairline bg-paper flex flex-col shrink-0">
            {/* Search Header */}
            <div className="p-3 border-b border-hairline bg-paper-2/20">
              <Input
                placeholder="Search subject or sender..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 text-xs bg-paper"
              />
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto divide-y divide-hairline">
              {filteredRows.length === 0 ? (
                <div className="p-8 text-center text-xs text-ink-3">
                  No emails match this filter.
                </div>
              ) : (
                filteredRows.map((e) => {
                  const isSelected = e.id === selectedId;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setSelectedId(e.id)}
                      className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1.5 relative ${
                        isSelected
                          ? "bg-amber/10 border-l-4 border-amber pl-2.5"
                          : "hover:bg-paper-2/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-6 h-6 rounded-full bg-paper-2 border border-hairline flex items-center justify-center text-[10px] font-bold text-ink-2 shrink-0">
                            {senderInitials(e)}
                          </div>
                          <span className="font-semibold text-xs text-ink truncate">
                            {senderLabel(e)}
                          </span>
                        </div>
                        <span className="text-[10px] text-ink-3 shrink-0">
                          {formatDate(e.created_at, "relative")}
                        </span>
                      </div>

                      <p className="text-xs font-medium text-ink-2 truncate">
                        {e.subject?.trim() || "(no subject)"}
                      </p>

                      <p className="text-[11px] text-ink-3 line-clamp-1">
                        {e.body_text?.trim() || "No preview body text"}
                      </p>

                      <div className="flex items-center justify-between gap-2 mt-1">
                        <StatusBadge status={e.status} />
                        {e.from_email && (
                          <span className="text-[10px] text-ink-3 truncate max-w-[120px]">
                            {e.from_email.split("@")[1]}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* ========================================================================= */}
          {/* PANE 3: READING PANE & CRM COPILOT */}
          {/* ========================================================================= */}
          <div className="flex-1 bg-paper flex flex-col min-w-0 overflow-y-auto">
            {!selectedThread ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <EmptyState
                  icon="mail"
                  title="No email selected"
                  body="Select an email thread from the middle pane to view message details, generate AI replies, or convert to a lead."
                />
              </div>
            ) : (
              <div className="flex-1 flex flex-col p-6 space-y-6">
                
                {/* Email Header Bar */}
                <div className="border-b border-hairline pb-4 space-y-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <h2 className="text-xl font-bold text-ink leading-tight">
                        {selectedThread.subject?.trim() || "(no subject)"}
                      </h2>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className="text-xs font-semibold text-ink">
                          {senderLabel(selectedThread)}
                        </span>
                        {selectedThread.from_email && (
                          <span className="text-xs text-ink-3">
                            &lt;{selectedThread.from_email}&gt;
                          </span>
                        )}
                        <span className="text-xs text-ink-3">· {formatDate(selectedThread.created_at, "long")}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <StatusBadge status={selectedThread.status} />
                    </div>
                  </div>

                  {/* Top Action Toolbar */}
                  <div className="flex items-center gap-2 pt-2 flex-wrap">
                    {selectedThread.lead_id ? (
                      <Button asChild variant="outline" icon="target">
                        <Link href={"/leads" as never}>View in Leads</Link>
                      </Button>
                    ) : canConvertToLead(selectedThread) ? (
                      <Button
                        variant="primary"
                        icon="plus"
                        loading={convert.isPending}
                        onClick={() => handleConvert(selectedThread.id)}
                      >
                        Convert to Lead
                      </Button>
                    ) : null}

                    <Button
                      variant="outline"
                      icon="sparkles"
                      loading={isAiDrafting}
                      onClick={handleGenerateAiReply}
                    >
                      {aiDraft ? "Regenerate AI Reply" : "Draft AI Reply"}
                    </Button>

                    <Button
                      asChild
                      variant="ghost"
                      icon="file"
                    >
                      <Link href={`/quotes/new?contact_email=${encodeURIComponent(selectedThread.from_email ?? "")}` as never}>
                        Create Quote
                      </Link>
                    </Button>
                  </div>
                </div>

                {/* Email Body Message */}
                <div className="flex-1 bg-paper-2/20 border border-hairline rounded-xl p-5 overflow-y-auto">
                  <div className="flex items-center justify-between text-xs text-ink-3 mb-3 border-b border-hairline/60 pb-2">
                    <span className="font-semibold uppercase tracking-wider text-[10px]">Email Body</span>
                    <span>Captured via Inbound Webhook</span>
                  </div>

                  {selectedThread.body_text?.trim() ? (
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm text-ink leading-relaxed">
                      {selectedThread.body_text}
                    </pre>
                  ) : selectedThread.body_html?.trim() ? (
                    <div className="p-4 rounded-lg border border-amber/30 bg-amber/5 text-xs text-ink-2">
                      <p className="font-semibold text-amber-dark mb-1">HTML-Only Mail Received</p>
                      <p>This email was sent in HTML-only format. Plain-text view is unavailable to prevent XSS security issues.</p>
                    </div>
                  ) : (
                    <p className="text-sm text-ink-3 italic">No body text captured for this email.</p>
                  )}
                </div>

                {/* AI Gemini Auto-Reply Draft Assistant */}
                {showReplyComposer && (
                  <div className="border border-amber/30 bg-amber/5 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs font-semibold text-amber-dark">
                        <Icon name="sparkles" size={15} />
                        <span>Gemini AI Reply Assistant</span>
                      </div>
                      <Button variant="ghost" icon="x" onClick={() => setShowReplyComposer(false)}>
                        Close
                      </Button>
                    </div>

                    {isAiDrafting ? (
                      <div className="py-6 text-center space-y-2">
                        <Skeleton className="h-4 w-48 mx-auto" />
                        <Skeleton className="h-16 w-full" />
                      </div>
                    ) : aiDraft ? (
                      <div className="space-y-3">
                        <div>
                          <label className="text-[11px] font-semibold text-ink-3 block mb-1">Subject</label>
                          <Input
                            value={aiDraft.subject}
                            onChange={(e) => setAiDraft({ ...aiDraft, subject: e.target.value })}
                            className="bg-paper text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-ink-3 block mb-1">AI Response Text</label>
                          <textarea
                            rows={5}
                            value={aiDraft.message}
                            onChange={(e) => setAiDraft({ ...aiDraft, message: e.target.value })}
                            className="w-full text-xs font-sans p-3 rounded-lg border border-hairline bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-amber"
                          />
                        </div>

                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className="text-[11px] text-ink-3">Review &amp; edit draft before sending.</span>
                          <div className="flex items-center gap-2">
                            <Button variant="outline" icon="file" onClick={handleCopyReply}>
                              Copy Reply Text
                            </Button>
                            <Button
                              asChild
                              variant="primary"
                              icon="mail"
                            >
                              <a href={`mailto:${selectedThread.from_email}?subject=${encodeURIComponent(aiDraft.subject)}&body=${encodeURIComponent(aiDraft.message)}`}>
                                Send Email
                              </a>
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* Prospect Meta Details Footer */}
                <div className="p-3 border border-hairline rounded-lg bg-paper-2/40 flex items-center justify-between text-xs text-ink-3 flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Icon name="info" size={14} />
                    <span>Sender: <strong>{selectedThread.from_email || "Unknown"}</strong></span>
                  </div>
                  <div>
                    <span>Message ID: <code className="text-[10px]">{selectedThread.message_id.slice(0, 24)}...</code></span>
                  </div>
                </div>

              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
