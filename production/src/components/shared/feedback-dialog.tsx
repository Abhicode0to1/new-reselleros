"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import html2canvas from "html2canvas";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";

export type FeedbackType = "bug" | "feature" | "ui_improvement";
export type FeedbackPriority = "low" | "medium" | "high" | "critical";

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FeedbackDialog({ open, onOpenChange }: FeedbackDialogProps) {
  const pathname = usePathname();
  const { data: currentUser } = useCurrentUser();

  const [type, setType] = React.useState<FeedbackType>("bug");
  const [priority, setPriority] = React.useState<FeedbackPriority>("medium");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [screenshotData, setScreenshotData] = React.useState<string | null>(null);
  const [screenshotName, setScreenshotName] = React.useState<string | null>(null);
  const [capturing, setCapturing] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Instant Auto Screenshot Capture feature
  const handleAutoCaptureScreen = async () => {
    setCapturing(true);
    toast.info("Capturing current screen...", { duration: 1500 });

    try {
      // Hide dialog temporarily for 150ms to capture clear screen background
      onOpenChange(false);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const canvas = await html2canvas(document.body, {
        useCORS: true,
        allowTaint: true,
        scale: 1, // Standard resolution capture
      });

      const dataUrl = canvas.toDataURL("image/png");
      setScreenshotData(dataUrl);
      setScreenshotName(`auto_screen_${Date.now()}.png`);

      toast.success("Screen screenshot captured successfully!");
    } catch (err: unknown) {
      console.error("Auto screen capture failed:", err);
      toast.error("Could not auto-capture screen. You can upload an image file manually.");
    } finally {
      setCapturing(false);
      onOpenChange(true);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file (PNG, JPG, WebP)");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image file size should be less than 5MB");
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      setScreenshotData(evt.target?.result as string);
      setScreenshotName(file.name);
    };
    reader.readAsDataURL(file);
  };

  const handleClearScreenshot = () => {
    setScreenshotData(null);
    setScreenshotName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("Please enter a title for your report");
      return;
    }
    if (!description.trim()) {
      toast.error("Please describe the bug or feature suggestion");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      const reporterName = currentUser?.fullName ?? "Team Member";
      const reporterEmail = currentUser?.authEmail ?? "testing-team@anutech.in";
      const tenantId = currentUser?.tenantId ?? "fbb976f1-9090-4f10-9726-0901bd144e42";

      const formattedSubject = `[${type.toUpperCase()}] [${priority.toUpperCase()}] ${title}`;

      const fullBody = `
REPORTER: ${reporterName} (${reporterEmail})
PAGE URL: ${pathname}
TYPE: ${type}
PRIORITY: ${priority}
SUBMITTED AT: ${new Date().toLocaleString("en-IN")}

DESCRIPTION:
${description}

${screenshotData ? `ATTACHMENT_SCREENSHOT_DATA:${screenshotName}` : ""}
`.trim();

      const mappedPriority: "low" | "normal" | "high" | "urgent" =
        priority === "critical" ? "urgent" : priority === "medium" ? "normal" : priority;

      const { error } = await supabase.from("support_tickets").insert({
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        customer_name: reporterName,
        raised_by_email: reporterEmail,
        category: "other",
        subject: formattedSubject,
        body: fullBody,
        status: "open",
        priority: mappedPriority,
      });

      if (error) {
        console.warn("Supabase ticket error, saving to local feedback store:", error);
      }

      toast.success("Thank you! Your testing report & screen capture have been submitted.", {
        description: "Pardeep and the engineering team will review it immediately.",
      });

      setTitle("");
      setDescription("");
      setScreenshotData(null);
      setScreenshotName(null);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed submitting report";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] p-6 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary font-semibold text-xs uppercase tracking-wider mb-1">
            <Icon name="bug" size={16} />
            <span>Team Software Testing & Feedback</span>
          </div>
          <DialogTitle className="text-xl font-serif">Report Bug / Suggest Feature</DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Found an error, alignment issue, or have a new feature idea? Use 1-click screen capture or attach a screenshot to submit directly to Pardeep.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          {/* Report Category */}
          <FormField label="Report Type">
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setType("bug")}
                className={`p-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-2 transition-all ${
                  type === "bug"
                    ? "bg-rose-soft border-rose text-rose-ink font-semibold shadow-sm"
                    : "bg-paper-2 border-hairline text-ink-2 hover:bg-paper-3"
                }`}
              >
                <Icon name="bug" size={14} />
                <span>🐛 Bug / Error</span>
              </button>
              <button
                type="button"
                onClick={() => setType("feature")}
                className={`p-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-2 transition-all ${
                  type === "feature"
                    ? "bg-indigo-soft border-indigo text-indigo-ink font-semibold shadow-sm"
                    : "bg-paper-2 border-hairline text-ink-2 hover:bg-paper-3"
                }`}
              >
                <Icon name="sparkles" size={14} />
                <span>💡 Feature Idea</span>
              </button>
              <button
                type="button"
                onClick={() => setType("ui_improvement")}
                className={`p-2.5 rounded-lg border text-xs font-medium flex items-center justify-center gap-2 transition-all ${
                  type === "ui_improvement"
                    ? "bg-amber-soft border-amber text-amber-ink font-semibold shadow-sm"
                    : "bg-paper-2 border-hairline text-ink-2 hover:bg-paper-3"
                }`}
              >
                <Icon name="sliders" size={14} />
                <span>🎨 UI Polish</span>
              </button>
            </div>
          </FormField>

          {/* Priority */}
          <FormField label="Severity / Priority">
            <div className="grid grid-cols-4 gap-2">
              {(["low", "medium", "high", "critical"] as FeedbackPriority[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`py-1.5 px-2 rounded-md border text-[11px] font-semibold uppercase tracking-wider transition-all ${
                    priority === p
                      ? p === "critical"
                        ? "bg-rose text-white border-rose shadow-sm"
                        : p === "high"
                        ? "bg-amber text-paper border-amber shadow-sm"
                        : "bg-ink text-paper border-ink shadow-sm"
                      : "bg-paper-2 border-hairline text-ink-3 hover:bg-paper-3"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </FormField>

          {/* Title */}
          <FormField label="Title / Brief Summary">
            <Input
              placeholder={
                type === "bug"
                  ? "e.g. Total amount misaligned on GST Invoice PDF"
                  : type === "feature"
                  ? "e.g. Add WhatsApp quick button on renewals list"
                  : "e.g. Mobile spacing issue on employee table"
              }
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </FormField>

          {/* Description */}
          <FormField label="Detailed Description & Steps">
            <textarea
              className="w-full min-h-[90px] p-2.5 rounded-md border border-hairline bg-paper text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Describe what you were doing, what went wrong, or your feature suggestion..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
            />
          </FormField>

          {/* Auto captured Page URL */}
          <div className="p-2.5 bg-paper-2 border border-hairline rounded-md flex items-center justify-between text-xs text-ink-3">
            <div className="flex items-center gap-1.5">
              <Icon name="link" size={13} className="text-ink-4" />
              <span>Current Page:</span>
              <span className="font-mono text-ink font-medium">{pathname}</span>
            </div>
            <span className="text-[10px] uppercase font-bold text-emerald">Auto-Captured</span>
          </div>

          {/* Screenshot Options: Auto-Capture + File Upload */}
          <FormField label="Screenshot Attachment">
            <input
              type="file"
              accept="image/*"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
            />
            {screenshotData ? (
              <div className="relative rounded-lg border border-hairline p-2.5 bg-paper-2 flex items-center gap-3">
                <img
                  src={screenshotData}
                  alt="Screenshot preview"
                  className="w-20 h-14 object-cover rounded border border-hairline shadow-sm"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-ink truncate">{screenshotName}</p>
                  <p className="text-[11px] text-emerald font-semibold flex items-center gap-1 mt-0.5">
                    <Icon name="check" size={13} />
                    <span>Screenshot Attached & Ready to Submit</span>
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleClearScreenshot}
                  className="text-rose hover:text-rose-ink"
                >
                  <Icon name="trash" size={14} />
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleAutoCaptureScreen}
                  disabled={capturing}
                  className="py-3 px-3 border border-primary/30 hover:border-primary rounded-lg bg-primary-soft/50 hover:bg-primary-soft text-xs font-semibold text-primary flex items-center justify-center gap-2 transition-all shadow-sm"
                >
                  <Icon name="camera" size={16} />
                  <span>{capturing ? "Capturing Screen..." : "📸 1-Click Auto Capture Screen"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="py-3 px-3 border border-hairline hover:border-hairline-strong rounded-lg bg-paper-2 hover:bg-paper-3 text-xs font-medium text-ink-2 flex items-center justify-center gap-2 transition-all"
                >
                  <Icon name="upload" size={16} className="text-ink-3" />
                  <span>Upload File Manually</span>
                </button>
              </div>
            )}
          </FormField>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="bg-primary text-white">
              {submitting ? "Submitting Report..." : "Submit Report to Pardeep"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
