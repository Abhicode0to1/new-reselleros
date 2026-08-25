/**
 * /mobile — "Install ResellerOS as an app" guide.
 *
 * Targets all 3 device classes:
 *   - iPhone / iPad (Safari) — Share → Add to Home Screen
 *   - Android (Chrome) — menu → Install app (also fires the
 *     beforeinstallprompt event we hook into below)
 *   - Desktop (Chrome / Edge) — address-bar install icon
 *
 * Detects the device on mount and highlights the relevant section.
 *
 * For Android + desktop browsers that support the install prompt, we
 * capture the deferred event and expose a one-tap install button.
 * iOS doesn't support beforeinstallprompt — there we just show
 * step-by-step instructions.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { APP_NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";

// Pages the operator can preview in the phone-frame iframe.
// Flattened from APP_NAV — every page they navigate to in the sidebar
// is previewable. /mobile itself is excluded to avoid infinite frames.
const PREVIEWABLE_PAGES = APP_NAV.flatMap((s) => s.items)
  .filter((i) => i.href !== "/mobile");

const TABS: TabBarItem[] = [
  { id: "install", label: "How to install" },
  { id: "preview", label: "Mobile preview" },
];

// BeforeInstallPromptEvent isn't in stock TS lib yet — type it ourselves.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type DeviceClass = "ios" | "android" | "desktop";

function detectDevice(): DeviceClass {
  if (typeof window === "undefined") return "desktop";
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
  if (/android/.test(ua)) return "android";
  return "desktop";
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS exposes navigator.standalone; everyone else uses display-mode media query.
  // iOS-only API not in the lib.dom.d.ts types; cast through unknown.
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const mediaStandalone = window.matchMedia("(display-mode: standalone)").matches;
  return iosStandalone || mediaStandalone;
}

export default function MobilePwaPage() {
  const { isMobile } = useBreakpoint();
  const [tab, setTab] = React.useState<string>("install");
  const [previewPath, setPreviewPath] = React.useState<string>("/dashboard");
  const [previewKey, setPreviewKey] = React.useState(0); // bump to force reload
  const [device, setDevice] = React.useState<DeviceClass>("desktop");
  const [installed, setInstalled] = React.useState(false);
  const [installPrompt, setInstallPrompt] = React.useState<BeforeInstallPromptEvent | null>(null);
  // Holds the runtime origin, only populated after mount — avoids
  // SSR hydration mismatch (server has no window.location).
  const [appOrigin, setAppOrigin] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDevice(detectDevice());
    setInstalled(isStandalone());
    setAppOrigin(window.location.origin);

    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  async function handleInstall() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === "accepted") {
      setInstalled(true);
      setInstallPrompt(null);
    }
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[900px] mx-auto">
      {/* Header */}
      <div className="mb-4">
        <p className="text-xs uppercase tracking-widest text-ink-3 font-semibold mb-1">System</p>
        <h1 className="font-serif text-3xl md:text-4xl text-ink leading-tight">Mobile (PWA)</h1>
        <p className="text-sm text-ink-3 mt-1">
          Install as an app or preview how ResellerOS looks on a phone — without picking yours up.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="mb-6">
        <TabBar items={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === "install" && <>

      {/* Already installed banner */}
      {installed && (
        <Card className="mb-5 border-emerald/40 bg-emerald-soft/30">
          <div className="flex items-center gap-3">
            <Icon name="check_circle" size={20} className="text-emerald" />
            <div>
              <p className="font-medium text-ink">You&apos;re already running the installed app — great.</p>
              <p className="text-xs text-ink-3 mt-0.5">
                ResellerOS is in standalone mode. Your home-screen icon opens this app directly.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Why install */}
      <Card className="mb-5">
        <h2 className="font-serif text-xl text-ink mb-3">Why install?</h2>
        <ul className="space-y-2 text-sm text-ink-2">
          {[
            { icon: "home",        text: "Home-screen icon — one tap to open, no browser bar" },
            { icon: "zap",         text: "Faster launch — opens instantly, no URL to type" },
            { icon: "smartphone",  text: "Looks like a native app — full-screen, branded splash" },
            { icon: "bell",        text: "Push notifications (coming soon) — never miss a renewal" },
            { icon: "shield",      text: "Same security — works only over HTTPS, your session stays signed in" },
          ].map((row, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <Icon name={row.icon} size={16} className="text-amber-ink mt-0.5 shrink-0" />
              <span>{row.text}</span>
            </li>
          ))}
        </ul>
      </Card>

      {/* One-tap install (Android / Desktop Chrome) */}
      {installPrompt && !installed && (
        <Card className="mb-5 border-amber/40 bg-amber-soft/20">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="font-medium text-ink">Your browser supports one-tap install.</p>
              <p className="text-xs text-ink-3 mt-0.5">
                Tap the button — ResellerOS will be added to your apps.
              </p>
            </div>
            <Button variant="primary" icon="download" onClick={handleInstall}>
              Install now
            </Button>
          </div>
        </Card>
      )}

      {/* Device-specific instructions */}
      <div className="space-y-4">
        <InstallSection
          deviceId="ios"
          active={device === "ios"}
          title="iPhone / iPad"
          subtitle="Safari only — Chrome on iOS doesn't support PWA install"
          steps={[
            "Open ResellerOS in Safari (not Chrome — Chrome on iOS uses Safari engine but blocks install).",
            "Tap the Share button (the square-with-up-arrow icon) at the bottom of the screen.",
            "Scroll down and tap \"Add to Home Screen\".",
            "Confirm the name (ResellerOS) and tap \"Add\".",
            "Find the ResellerOS icon on your home screen — tap to launch the app full-screen.",
          ]}
        />
        <InstallSection
          deviceId="android"
          active={device === "android"}
          title="Android"
          subtitle="Chrome, Edge, Samsung Internet all supported"
          steps={[
            "Open ResellerOS in Chrome.",
            "Tap the three-dot menu (top-right).",
            "Tap \"Install app\" or \"Add to Home screen\".",
            "Confirm install — Chrome creates a real Android app shortcut.",
            "Open the app from your home screen or app drawer.",
          ]}
        />
        <InstallSection
          deviceId="desktop"
          active={device === "desktop"}
          title="Laptop / Desktop"
          subtitle="Chrome, Edge, Brave on Windows / macOS / Linux"
          steps={[
            "Open ResellerOS in Chrome or Edge.",
            "Look for the install icon (small computer-with-down-arrow) in the right side of the address bar.",
            "Click it and confirm \"Install\".",
            "ResellerOS opens in its own window with its own taskbar / Dock icon.",
            "Pin to Start menu / Dock for one-click launch.",
          ]}
        />
      </div>

      {/* QR code shortcut for opening on phone */}
      {!isMobile && (
        <Card className="mt-6">
          <div className="flex items-center gap-4">
            <div className="shrink-0">
              {/* Simple QR placeholder — server-side QR generation lands in Phase 2.
                  For now, the URL is the actionable info. */}
              <div className="h-20 w-20 rounded-md border-2 border-dashed border-hairline grid place-items-center bg-paper-2">
                <Icon name="smartphone" size={24} className="text-ink-3" />
              </div>
            </div>
            <div>
              <p className="font-medium text-ink">Open on your phone</p>
              <p className="text-xs text-ink-3 mt-0.5">
                On your phone, open the same URL you&apos;re viewing here:
              </p>
              <p className="font-mono text-xs text-ink-2 mt-1 break-all">
                {appOrigin ?? "…"}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Troubleshooting */}
      <Card className="mt-6">
        <h2 className="font-serif text-xl text-ink mb-3">Troubleshooting</h2>
        <div className="space-y-3 text-sm text-ink-2">
          <Issue
            q="I don't see the install option."
            a="Your browser may not support PWA installs (e.g., Firefox on iOS, in-app browsers like WhatsApp/LinkedIn). Open the link in Chrome (Android) or Safari (iOS / iPadOS)."
          />
          <Issue
            q="The icon shows a generic image instead of the ResellerOS logo."
            a="Sometimes the cache holds onto an older icon. Clear your browser cache, remove the home-screen icon, and re-install."
          />
          <Issue
            q="Does install work offline?"
            a="The install puts the icon on your home screen. Full offline support (cached data) comes in Phase 2. Right now you still need an internet connection to open the app."
          />
          <Issue
            q="Is this an actual app on the Play Store / App Store?"
            a="No — it's a Progressive Web App. Same code as the web version, but it runs full-screen with its own icon. No store download, no review delay, and updates are instant (just refresh)."
          />
        </div>
      </Card>
      </>}

      {tab === "preview" && (
        <div className="space-y-4">
          {/* Page picker + reload control */}
          <Card>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-[240px]">
                <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">
                  Preview page
                </p>
                <Select value={previewPath} onValueChange={setPreviewPath}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PREVIEWABLE_PAGES.map((p) => (
                      <SelectItem key={p.id} value={p.href}>
                        {p.label} <span className="font-mono text-ink-3">· {p.href}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2 pb-px">
                <Button
                  variant="default"
                  size="sm"
                  icon="refresh"
                  onClick={() => setPreviewKey((k) => k + 1)}
                  title="Reload the preview"
                >
                  Reload
                </Button>
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  iconRight="external"
                  title="Open in a real new tab"
                >
                  <a href={previewPath} target="_blank" rel="noreferrer">Open</a>
                </Button>
              </div>
            </div>
            <p className="mt-3 text-2xs text-ink-3">
              Renders the live app inside an iPhone-sized frame (375×812). Same code, same auth — what you tap inside the frame is real.
            </p>
          </Card>

          {/* Phone frame */}
          <div className="flex justify-center">
            <PhoneFrame>
              <iframe
                key={previewKey}
                src={previewPath}
                title={`Mobile preview of ${previewPath}`}
                className="block w-full h-full border-0 bg-paper"
                // Allow same-origin so the iframe shares auth cookies — operator
                // sees the real app, not a redirect-to-login screen.
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
              />
            </PhoneFrame>
          </div>

          <p className="text-center text-xs text-ink-3">
            Tip: shrink your browser window or hit <kbd className="px-1 py-0.5 rounded border border-hairline font-mono text-3xs">F12</kbd> → Device Toolbar for an even more realistic test.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Phone frame mockup ──────────────────────────────────────────────────────
// A simple iPhone-styled wrapper around the iframe so the preview feels
// like looking at a real device, not just a narrow column. Notch + rounded
// bezel + speaker grille — all CSS, no images.

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "relative bg-ink rounded-[42px] shadow-2xl",
        // External device border (titanium look)
        "p-3 ring-1 ring-ink/20",
      )}
      style={{ width: 393, height: 852 }} // iPhone 14 Pro outer
    >
      {/* Inner screen — content slot */}
      <div className="relative overflow-hidden rounded-[30px] bg-paper" style={{ width: 369, height: 828 }}>
        {/* Dynamic Island */}
        <div className="absolute left-1/2 top-2 -translate-x-1/2 z-10 h-7 w-24 rounded-full bg-ink pointer-events-none" />
        {/* The iframe fills the screen area */}
        <div className="absolute inset-0">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function InstallSection({
  deviceId,
  active,
  title,
  subtitle,
  steps,
}: {
  deviceId: DeviceClass;
  active: boolean;
  title: string;
  subtitle: string;
  steps: string[];
}) {
  const iconMap: Record<DeviceClass, string> = {
    ios:     "smartphone",
    android: "smartphone",
    desktop: "package",
  };
  return (
    <Card className={active ? "border-amber/50 ring-1 ring-amber/30" : undefined}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-md grid place-items-center bg-paper-2 text-ink-2">
            <Icon name={iconMap[deviceId]} size={16} />
          </div>
          <div>
            <h3 className="font-serif text-lg text-ink leading-tight">{title}</h3>
            <p className="text-xs text-ink-3">{subtitle}</p>
          </div>
        </div>
        {active && <Badge kind="warning" dot>Your device</Badge>}
      </div>
      <ol className="space-y-2 text-sm text-ink-2">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2.5">
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber/15 text-amber-ink text-2xs font-semibold tabular-nums">
              {i + 1}
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Issue({ q, a }: { q: string; a: string }) {
  return (
    <div className="border-l-2 border-hairline pl-3">
      <p className="font-medium text-ink-2">{q}</p>
      <p className="text-xs text-ink-3 mt-0.5">{a}</p>
    </div>
  );
}
