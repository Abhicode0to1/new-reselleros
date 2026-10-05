"use client";

/**
 * Full-screen image viewer with zoom (5 Oct 2026, Pardeep: "image par click karne par larger
 * view dikhna chahiye — original size tak chota bada preview kar sakein").
 *
 * Its own Radix dialog, so it opens above another dialog (Report Bug) and covers the whole
 * screen instead of being boxed inside it. Fit = whole image on screen; 100% = real pixels;
 * zoom from 25% to 400%. Mouse wheel (with Ctrl, or alone) zooms, + / − / 0 keys work, a
 * click on the image toggles Fit ↔ 100%, and a zoomed image scrolls / drags.
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Icon } from "@/components/ui/icon";

const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

export function ImageViewer({ src, name, onClose }: { src: string | null; name?: string; onClose: () => void }) {
  /** null = fit to screen; a number = scale of the image's real size */
  const [zoom, setZoom] = React.useState<number | null>(null);
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null);
  const [fitScale, setFitScale] = React.useState(1);
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{ x: number; y: number; l: number; t: number; moved: boolean } | null>(null);
  const justDragged = React.useRef(false);

  React.useEffect(() => { setZoom(null); setNatural(null); }, [src]);

  // What "Fit" means in numbers, so − / + step from where the picture really is.
  React.useEffect(() => {
    if (!natural || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    setFitScale(Math.min(1, (r.width - 32) / natural.w, (r.height - 32) / natural.h));
  }, [natural, zoom]);

  const current = zoom ?? fitScale;
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? STEPS.find((s) => s > current + 0.001) : [...STEPS].reverse().find((s) => s < current - 0.001);
    setZoom(next ?? (dir > 0 ? STEPS[STEPS.length - 1] : STEPS[0]));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "+" || e.key === "=") { e.preventDefault(); step(1); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); step(-1); }
    else if (e.key === "0") { e.preventDefault(); setZoom(null); }
    else if (e.key === "1") { e.preventDefault(); setZoom(1); }
  };

  /* Native, non-passive wheel listener: React's onWheel is passive, so it could not stop
     Ctrl+wheel from zooming the whole browser page instead of the picture. */
  const stepRef = React.useRef(step);
  stepRef.current = step;
  const zoomedRef = React.useRef(zoom !== null);
  zoomedRef.current = zoom !== null;
  const [box, setBox] = React.useState<HTMLDivElement | null>(null);
  // Stable ref callback: an inline one re-runs every render (null, then the node) and would
  // set state in a loop.
  const setBoxRef = React.useCallback((el: HTMLDivElement | null) => { boxRef.current = el; setBox(el); }, []);
  React.useEffect(() => {
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && zoomedRef.current) return; // zoomed: a plain wheel scrolls the picture
      e.preventDefault();
      stepRef.current(e.deltaY < 0 ? 1 : -1);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [box]);

  const btn = "h-9 min-w-9 px-2 rounded-md flex items-center justify-center text-sm font-semibold text-white/90 hover:bg-white/15 disabled:opacity-40";

  return (
    <DialogPrimitive.Root open={!!src} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100000] bg-black/95" />
        <DialogPrimitive.Content
          onKeyDown={onKey}
          aria-describedby={undefined}
          className="fixed inset-0 z-[100001] flex flex-col outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{name ? `Screenshot: ${name}` : "Screenshot"}</DialogPrimitive.Title>
          <div className="flex items-center gap-1 px-3 py-2 bg-black/60 text-white" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))" }}>
            <span className="text-xs text-white/70 truncate mr-auto">{name}</span>
            <button type="button" className={btn} onClick={() => step(-1)} disabled={current <= STEPS[0] + 0.001} aria-label="Zoom out">−</button>
            <span className="w-14 text-center text-xs tabular-nums" aria-live="polite">{Math.round(current * 100)}%</span>
            <button type="button" className={btn} onClick={() => step(1)} disabled={current >= STEPS[STEPS.length - 1] - 0.001} aria-label="Zoom in">+</button>
            <button type="button" className={`${btn} text-xs ${zoom === null ? "bg-white/15" : ""}`} onClick={() => setZoom(null)}>Fit</button>
            <button type="button" className={`${btn} text-xs ${zoom === 1 ? "bg-white/15" : ""}`} onClick={() => setZoom(1)}>100%</button>
            <DialogPrimitive.Close className={btn} aria-label="Close"><Icon name="x" size={18} /></DialogPrimitive.Close>
          </div>
          <div
            ref={setBoxRef}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
            onPointerDown={(e) => {
              if (zoom === null || !boxRef.current) return;
              drag.current = { x: e.clientX, y: e.clientY, l: boxRef.current.scrollLeft, t: boxRef.current.scrollTop, moved: false };
            }}
            onPointerMove={(e) => {
              const d = drag.current, b = boxRef.current;
              if (!d || !b) return;
              if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
              b.scrollLeft = d.l - (e.clientX - d.x);
              b.scrollTop = d.t - (e.clientY - d.y);
            }}
            onPointerUp={() => { justDragged.current = !!drag.current?.moved; drag.current = null; }}
            onPointerLeave={() => { drag.current = null; }}
            className={`flex-1 overflow-auto ${zoom === null ? "flex items-center justify-center" : "grid place-items-center"} p-4 ${zoom !== null ? "cursor-grab active:cursor-grabbing" : ""}`}
          >
            {src && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={name ?? "Screenshot"}
                draggable={false}
                onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                onClick={() => { if (justDragged.current) { justDragged.current = false; return; } setZoom((z) => (z === null ? 1 : null)); }}
                title={zoom === null ? "Click for 100%" : "Click to fit"}
                style={zoom === null || !natural
                  ? { maxWidth: "100%", maxHeight: "100%", cursor: "zoom-in" }
                  : { width: natural.w * zoom, height: natural.h * zoom, maxWidth: "none", cursor: "zoom-out" }}
                className="rounded shadow-2xl bg-white select-none"
              />
            )}
          </div>
          <p className="text-center text-2xs text-white/60 py-1.5 bg-black/60">Scroll or + / − to zoom · 0 = fit · 1 = 100% · Esc to close</p>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
