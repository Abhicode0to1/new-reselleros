"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { FeedbackDialog } from "@/components/shared/feedback-dialog";

export function GlobalBugReporter() {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const dragStartRef = React.useRef<{ mouseX: number; mouseY: number; posX: number; posY: number } | null>(null);
  const isMovedRef = React.useRef(false);

  // Initialize position to bottom right on mount
  React.useEffect(() => {
    const saved = localStorage.getItem("resellersos_bug_reporter_pos");
    if (saved) {
      try {
        setPos(JSON.parse(saved));
        return;
      } catch (e) {
        // fallback
      }
    }
    // Default: 20px from bottom, 20px from right
    if (typeof window !== "undefined") {
      setPos({
        x: window.innerWidth - 180,
        y: window.innerHeight - 60,
      });
    }
  }, []);

  // Global Keyboard Shortcut: Ctrl + Shift + B or Cmd + Shift + B
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Drag Event Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    // Only left click
    if (e.button !== 0) return;
    setDragging(true);
    isMovedRef.current = false;
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: pos?.x ?? window.innerWidth - 180,
      posY: pos?.y ?? window.innerHeight - 60,
    };
  };

  const handleMouseMove = React.useCallback((e: MouseEvent) => {
    if (!dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.mouseX;
    const dy = e.clientY - dragStartRef.current.mouseY;

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      isMovedRef.current = true;
    }

    const newX = Math.max(10, Math.min(window.innerWidth - 160, dragStartRef.current.posX + dx));
    const newY = Math.max(10, Math.min(window.innerHeight - 50, dragStartRef.current.posY + dy));

    const nextPos = { x: newX, y: newY };
    setPos(nextPos);
  }, []);

  const handleMouseUp = React.useCallback(() => {
    if (dragStartRef.current && pos) {
      localStorage.setItem("resellersos_bug_reporter_pos", JSON.stringify(pos));
    }
    setDragging(false);
    dragStartRef.current = null;
  }, [pos]);

  React.useEffect(() => {
    if (dragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    } else {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, handleMouseMove, handleMouseUp]);

  const handleClick = (e: React.MouseEvent) => {
    if (isMovedRef.current) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    setOpen(true);
  };

  return (
    <>
      {/* Draggable Floating Action Button — Always on top (z-[9999]) */}
      <div
        style={
          pos
            ? { left: `${pos.x}px`, top: `${pos.y}px` }
            : { right: "20px", bottom: "20px" }
        }
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        className={`fixed z-[9999] select-none cursor-grab active:cursor-grabbing bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-3.5 py-2.5 rounded-full shadow-2xl transition-shadow flex items-center gap-2 border-2 border-white focus:outline-none ${
          dragging ? "scale-105 shadow-2xl opacity-90" : "hover:scale-105"
        }`}
        title="Drag to reposition · Click to Report Bug (Ctrl + Shift + B)"
      >
        <span className="cursor-grab text-rose-200 hover:text-white">
          <Icon name="sliders" size={13} />
        </span>
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-white"></span>
        </span>
        <Icon name="bug" size={15} />
        <span className="tracking-wide">Report Bug</span>
        <span className="hidden sm:inline-block text-[9px] bg-rose-800/80 px-1.5 py-0.5 rounded text-white font-mono">
          Ctrl+Shift+B
        </span>
      </div>

      {/* Global Feedback Dialog (z-[99999]) */}
      <FeedbackDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
