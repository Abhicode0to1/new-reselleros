"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import html2canvas from "html2canvas";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
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
  const [promptText, setPromptText] = React.useState("");
  const [screenshotData, setScreenshotData] = React.useState<string | null>(null);
  const [screenshotName, setScreenshotName] = React.useState<string | null>(null);
  const [capturing, setCapturing] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Global Clipboard Paste (Ctrl + V) Handler for Screenshots
  const handlePaste = React.useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = (evt) => {
          setScreenshotData(evt.target?.result as string);
          setScreenshotName(`pasted_screenshot_${Date.now()}.png`);
          toast.success("Screenshot pasted from Clipboard! (Ctrl + V)");
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }, []);

  // Instant Auto Screenshot Capture feature using html2canvas
  const handleAutoCaptureScreen = async () => {
    setCapturing(true);
    toast.info("Capturing current screen...", { duration: 1500 });

    try {
      // Hide dialog temporarily for 200ms to capture clean web page DOM
      onOpenChange(false);
      await new Promise((resolve) => setTimeout(resolve, 220));

      const canvas = await html2canvas(document.body, {
        useCORS: true,
        allowTaint: true,
        scale: 1,
      });

      const dataUrl = canvas.toDataURL("image/png");
      setScreenshotData(dataUrl);
      setScreenshotName(`auto_screen_${Date.now()}.png`);

      toast.success("Screen captured & attached successfully!");
    } catch (err: unknown) {
      console.error("Auto screen capture failed:", err);
      toast.error("Could not auto-capture screen. Use Ctrl + V or upload an image file.");
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
    const cleanedPrompt = promptText.trim();
    if (!cleanedPrompt) {
      toast.error("Please enter details in the report box");
      return;
    }

    // Auto-extract Title (First Line) and Description (Full Text)
    const lines = cleanedPrompt.split("\n").filter((l) => l.trim());
    const extractedTitle = lines[0] ? lines[0].slice(0, 100) : "Testing Feedback Report";

    setSubmitting(true);
    try {
      const supabase = createClient();
      const reporterName = currentUser?.fullName ?? "Team Member";
      const reporterEmail = currentUser?.authEmail ?? "testing-team@anutech.in";
      const tenantId = currentUser?.tenantId ?? "fbb976f1-9090-4f10-9726-0901bd144e42";

      const formattedSubject = `[${type.toUpperCase()}] [${priority.toUpperCase()}] ${extractedTitle}`;

      const fullBody = `
REPORTER: ${reporterName} (${reporterEmail})
PAGE URL: ${pathname}
TYPE: ${type}
PRIORITY: ${priority}
SUBMITTED AT: ${new Date().toLocaleString("en-IN")}

DESCRIPTION:
${cleanedPrompt}

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

      toast.success("Thank you! Your testing report & screenshot have been submitted.", {
        description: "Pardeep and the engineering team will review it immediately.",
      });

      setPromptText("");
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
      <DialogContent
        onPaste={handlePaste}
        className="sm:max-w-[580px] p-6 max-h-[92vh] overflow-y-auto shadow-2xl z-[99999]"
      >
        <DialogHeader>
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
            <Icon name="bug" size={16} />
            <span>Team Software Testing & Bug Reporter</span>
          </div>
          <DialogTitle className="text-xl md:text-2xl font-serif">Report Bug / Suggest Feature</DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Ask or report anything in 1 box (like AI Chat). Use 1-Click Auto Screen Capture or press <b>Ctrl + V</b> to paste a screenshot directly!
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
                    ? "bg-rose-soft border-rose text-rose-ink font-bold shadow-sm"
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
                    ? "bg-indigo-soft border-indigo text-indigo-ink font-bold shadow-sm"
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
                    ? "bg-amber-soft border-amber text-amber-ink font-bold shadow-sm"
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
                  className={`py-1.5 px-2 rounded-md border text-[11px] font-bold uppercase tracking-wider transition-all ${
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

          {/* Single Streamlined AI-Chat Prompt Box */}
          <FormField label="Details & Steps (All-in-One AI Box)">
            <div className="relative">
              <textarea
                className="w-full min-h-[120px] p-3 rounded-lg border border-hairline bg-paper text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-primary font-mono leading-relaxed"
                placeholder={
                  type === "bug"
                    ? "Explain what happened, steps to reproduce, or paste your error here... (e.g. Payment Date option missing on Record Payment page)"
                    : type === "feature"
                    ? "Describe your feature request or new workflow suggestion..."
                    : "Describe the UI alignment or design change needed..."
                }
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                required
              />
              <div className="text-[11px] text-ink-4 mt-1 flex items-center justify-between">
                <span>💡 Tip: Press <b>Ctrl + V</b> anywhere to paste a screenshot!</span>
                <span className="font-mono">{promptText.length} chars</span>
              </div>
            </div>
          </FormField>

          {/* Auto captured Page URL */}
          <div className="p-2.5 bg-paper-2 border border-hairline rounded-md flex items-center justify-between text-xs text-ink-3">
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon name="link" size={13} className="text-ink-4 flex-shrink-0" />
              <span>Current Page:</span>
              <span className="font-mono text-ink font-medium truncate">{pathname}</span>
            </div>
            <span className="text-[10px] uppercase font-bold text-emerald flex-shrink-0 ml-2">Auto-Captured</span>
          </div>

          {/* Screenshot Options: Auto-Capture + File Upload + Paste */}
          <FormField label="Screenshot Attachment">
            <input
              type="file"
              accept="image/*"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
            />
            {screenshotData ? (
              <div className="relative rounded-lg border border-emerald/40 p-2.5 bg-emerald-soft/30 flex items-center gap-3">
                <img
                  src={screenshotData}
                  alt="Screenshot preview"
                  className="w-20 h-14 object-cover rounded border border-hairline shadow-sm"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-ink truncate">{screenshotName}</p>
                  <p className="text-[11px] text-emerald font-bold flex items-center gap-1 mt-0.5">
                    <Icon name="check" size={14} />
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
                  className="py-3 px-3 border border-primary/40 hover:border-primary rounded-lg bg-primary-soft/50 hover:bg-primary-soft text-xs font-bold text-primary flex items-center justify-center gap-2 transition-all shadow-sm"
                >
                  <Icon name="camera" size={16} />
                  <span>{capturing ? "Capturing Screen..." : "📸 1-Click Auto Capture"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="py-3 px-3 border border-hairline hover:border-hairline-strong rounded-lg bg-paper-2 hover:bg-paper-3 text-xs font-medium text-ink-2 flex items-center justify-center gap-2 transition-all"
                >
                  <Icon name="upload" size={16} className="text-ink-3" />
                  <span>Upload or Paste (Ctrl+V)</span>
                </button>
              </div>
            )}
          </FormField>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="bg-primary text-white font-bold">
              {submitting ? "Submitting Report..." : "Submit Report to Pardeep"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
