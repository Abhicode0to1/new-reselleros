"use client";
/**
 * Every dialog Sales & Pipeline can open from its rows, toolbar or the topbar's quick
 * actions. Moved verbatim out of (app)/leads/page.tsx (S35, 28 Sep 2026); the open/closed
 * state stays in the page. The heavy ones are still loaded only when opened.
 */
import * as React from "react";
import dynamic from "next/dynamic";
import { MergeLeadsDialog } from "@/components/features/leads/merge-leads-dialog";
import { QuickAddLeadForm } from "@/components/features/leads/quick-add-lead-form";
import { ShareFormSheet, ENQUIRY_SHARE } from "@/components/features/leads/share-form-sheet";
import { WhatsAppActionDialog } from "@/components/shared/whatsapp-action-dialog";
import { rupee } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";

/* Dialogs nobody sees on first paint are loaded when opened (27 Sep 2026): the Sales &
   Pipeline page carried ~4,000 lines of dialog code into every load. */
const AddLeadForm = dynamic(() => import("@/components/features/leads/add-lead-form").then((m) => m.AddLeadForm), { ssr: false });
const ImportCsvDialog = dynamic(() => import("@/components/features/leads/import-csv-dialog").then((m) => m.ImportCsvDialog), { ssr: false });
const AddTaskDialog = dynamic(() => import("@/components/features/tasks/add-task-dialog").then((m) => m.AddTaskDialog), { ssr: false });
const ProjectQuoteFromLead = dynamic(() => import("@/components/features/leads/project-quote-from-lead").then((m) => m.ProjectQuoteFromLead), { ssr: false });
const CampaignComposerDialog = dynamic(() => import("@/components/features/campaigns/campaign-composer-dialog"), { ssr: false });
const GoogleContactsImportDialog = dynamic(() => import("@/components/features/contacts/google-contacts-import-dialog"), { ssr: false });
const StartTrialDialog = dynamic(() => import("@/components/features/leads/start-trial-dialog"), { ssr: false });

export interface LeadsPageDialogsProps {
  followUpLead: Lead | null;
  setFollowUpLead: (l: Lead | null) => void;
  waLead: Lead | null;
  setWaLead: (l: Lead | null) => void;
  mergeCluster: Lead[] | null;
  setMergeCluster: (c: Lead[] | null) => void;
  projectQuoteLead: Lead | null;
  closeProjectQuote: () => void;
  addOpen: boolean;
  setAddOpen: (open: boolean) => void;
  editingLead: Lead | null;
  setEditingLead: (l: Lead | null) => void;
  isDealsPage: boolean;
  quickOpen: boolean;
  setQuickOpen: (open: boolean) => void;
  trialOpen: boolean;
  setTrialOpen: (open: boolean) => void;
  callLog: { dialog: React.ReactNode };
  campaignOpen: boolean;
  setCampaignOpen: (open: boolean) => void;
  googleImportOpen: boolean;
  setGoogleImportOpen: (open: boolean) => void;
  csvImportOpen: boolean;
  setCsvImportOpen: (open: boolean) => void;
  refetch: () => unknown;
  shareOpen: boolean;
  setShareOpen: (open: boolean) => void;
}

export function LeadsPageDialogs({
  followUpLead, setFollowUpLead, waLead, setWaLead, mergeCluster, setMergeCluster, projectQuoteLead,
  closeProjectQuote, addOpen, setAddOpen, editingLead, setEditingLead, isDealsPage, quickOpen,
  setQuickOpen, trialOpen, setTrialOpen, callLog, campaignOpen, setCampaignOpen, googleImportOpen,
  setGoogleImportOpen, csvImportOpen, setCsvImportOpen, refetch, shareOpen, setShareOpen,
}: LeadsPageDialogsProps) {
  return (
    <>
      {/* Row "Follow-up" quick action → schedule a task linked to this lead */}
      {followUpLead && (
        <AddTaskDialog
          open
          onOpenChange={(o) => { if (!o) setFollowUpLead(null); }}
          linkLabel={followUpLead.company}
          linkTo={{ lead_id: followUpLead.id }}
        />
      )}

      {/* WhatsApp Action & Templates Dialog */}
      {waLead && (
        <WhatsAppActionDialog
          open
          onOpenChange={(o) => { if (!o) setWaLead(null); }}
          phone={waLead.contact_phone}
          recipientName={waLead.contact_name}
          companyName={waLead.company}
          category="quote"
          vars={{
            productName: waLead.plan || "Cloud Service",
            seats: waLead.seats || 10,
            amount: waLead.value ? rupee(waLead.value) : undefined,
          }}
        />
      )}

      {/* Merge duplicates — opened from a row's "Duplicate?" flag */}
      {mergeCluster && mergeCluster.length > 1 && (
        <MergeLeadsDialog cluster={mergeCluster} onClose={() => setMergeCluster(null)} />
      )}

      <ProjectQuoteFromLead lead={projectQuoteLead} onClose={closeProjectQuote} />

      {/* Add / Edit lead modal */}
      <AddLeadForm
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) setEditingLead(null);
        }}
        editingLead={editingLead}
        // On the Deal Pipeline, "Add Deal" creates a NEW record straight in the
        // pipeline (stage "quote") so it actually shows up here.
        defaultStage={isDealsPage ? "quote" : undefined}
      />

      {/* Quick add — 4-field minimal lead capture (company + contact only). */}
      <QuickAddLeadForm
        open={quickOpen}
        onOpenChange={setQuickOpen}
      />

      <StartTrialDialog open={trialOpen} onOpenChange={setTrialOpen} />

      {/* Call queue ka "Call log" isme khulta hai — wahi popup jo drawer aur row me hai. */}
      {callLog.dialog}

      <CampaignComposerDialog open={campaignOpen} onOpenChange={setCampaignOpen} />

      <GoogleContactsImportDialog open={googleImportOpen} onOpenChange={setGoogleImportOpen} />

      {/* CSV bulk upload — 4-field minimal capture, matches Quick form. */}
      <ImportCsvDialog
        open={csvImportOpen}
        onOpenChange={setCsvImportOpen}
        onImportComplete={() => refetch()}
      />

      {/* Share the public enquiry form — collect a prospect's details, auto-creates a lead. */}
      {shareOpen && <ShareFormSheet target={ENQUIRY_SHARE} onClose={() => setShareOpen(false)} />}
    </>
  );
}
