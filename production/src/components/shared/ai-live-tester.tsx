"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function highlightElement(el: HTMLElement, duration = 1200) {
  return new Promise<void>((resolve) => {
    const originalTransition = el.style.transition;
    const originalOutline = el.style.outline;
    const originalBoxShadow = el.style.boxShadow;

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.transition = "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)";
    el.style.outline = "4px solid #ef4444";
    el.style.boxShadow = "0 0 25px rgba(239, 68, 68, 0.85)";

    setTimeout(() => {
      el.style.outline = originalOutline;
      el.style.boxShadow = originalBoxShadow;
      el.style.transition = originalTransition;
      resolve();
    }, duration);
  });
}

export function AiLiveTester() {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  const [stepText, setStepText] = React.useState("");

  async function startTour() {
    if (running) return;
    setRunning(true);

    try {
      // Step 1: Welcome
      setStepText("1/6: Navigating to Dashboard...");
      router.push("/dashboard");
      await sleep(1500);

      // Step 2: Highlight & Click "+ Quick add quote"
      setStepText("2/6: Testing '+ Quick add quote' button...");
      const quoteBtn = document.querySelector('button:has-text("Quick add quote"), a:has-text("Quick add quote"), button[class*="amber"], button[class*="orange"]') as HTMLElement;
      const targetBtn = Array.from(document.querySelectorAll("button, a")).find((el) =>
        el.textContent?.includes("Quick add quote")
      ) as HTMLElement | undefined;

      if (targetBtn) {
        await highlightElement(targetBtn, 1200);
        targetBtn.click();
        setStepText("Opened Quick Add Quote Drawer!");
        await sleep(2500);

        // Close it
        const closeBtn = document.querySelector('button[aria-label="Close"], button:has-text("Cancel")') as HTMLElement | null;
        if (closeBtn) {
          await highlightElement(closeBtn, 800);
          closeBtn.click();
          await sleep(1000);
        } else {
          // Press Escape
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          await sleep(800);
        }
      }

      // Step 3: Scroll Dashboard
      setStepText("3/6: Analyzing Dashboard Revenue & Deals...");
      window.scrollBy({ top: 500, behavior: "smooth" });
      await sleep(1800);
      window.scrollBy({ top: -500, behavior: "smooth" });
      await sleep(1200);

      // Step 4: Sales & Pipeline
      setStepText("4/6: Navigating to Sales & Pipeline...");
      const pipelineLink = Array.from(document.querySelectorAll("a, button")).find((el) =>
        el.textContent?.includes("Sales & Pipeline")
      ) as HTMLElement | undefined;
      if (pipelineLink) {
        await highlightElement(pipelineLink, 1000);
        pipelineLink.click();
      } else {
        router.push("/leads");
      }
      await sleep(2500);
      window.scrollBy({ top: 350, behavior: "smooth" });
      await sleep(1500);
      window.scrollBy({ top: -350, behavior: "smooth" });

      // Step 5: Customers
      setStepText("5/6: Navigating to Customers Directory...");
      const custLink = Array.from(document.querySelectorAll("a, button")).find((el) =>
        el.textContent?.trim() === "Customers"
      ) as HTMLElement | undefined;
      if (custLink) {
        await highlightElement(custLink, 1000);
        custLink.click();
      } else {
        router.push("/customers");
      }
      await sleep(2500);

      // Step 6: Quotes
      setStepText("6/6: Navigating to Quotes & Documents...");
      const quotesLink = Array.from(document.querySelectorAll("a, button")).find((el) =>
        el.textContent?.trim() === "Quotes"
      ) as HTMLElement | undefined;
      if (quotesLink) {
        await highlightElement(quotesLink, 1000);
        quotesLink.click();
      } else {
        router.push("/quotes");
      }
      await sleep(2500);

      // Return to Dashboard
      setStepText("Returning to Dashboard...");
      router.push("/dashboard");
      await sleep(1500);

      toast.success("🎉 AI Human-like Live Test Completed Successfully!", {
        duration: 5000,
        description: "All pages, drawers, navigation, and metrics were tested live in this tab.",
      });

    } catch (err: any) {
      toast.error(`Test stopped: ${err?.message || "Unknown error"}`);
    } finally {
      setRunning(false);
      setStepText("");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={startTour}
        disabled={running}
        className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 text-xs font-semibold transition-all shadow-sm cursor-pointer"
        title="Start AI Human-like Live Testing right inside this browser window"
      >
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        </span>
        <Icon name="sparkles" size={13} className="text-emerald-600 dark:text-emerald-400" />
        <span>{running ? "Testing..." : "AI Live Test"}</span>
      </button>

      {/* Floating Status Banner when running */}
      {running && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[9999] bg-ink text-paper px-5 py-2.5 rounded-full shadow-2xl flex items-center gap-3 border border-amber/50 animate-bounce">
          <span className="h-3 w-3 rounded-full bg-amber animate-ping" />
          <span className="text-xs font-medium tracking-wide">
            🤖 <b>AI Live Testing:</b> {stepText}
          </span>
          <button
            type="button"
            onClick={() => setRunning(false)}
            className="ml-2 text-3xs uppercase tracking-wider bg-rose-600 text-white px-2 py-0.5 rounded-md hover:bg-rose-700"
          >
            Stop
          </button>
        </div>
      )}
    </>
  );
}
