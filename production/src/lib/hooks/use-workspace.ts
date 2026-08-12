"use client";

import * as React from "react";

export type WorkspaceMode = "anutech" | "excel" | "group";

export function useActiveWorkspace(): {
  workspace: WorkspaceMode;
  setWorkspace: (ws: WorkspaceMode) => void;
  isAnutech: boolean;
  isExcel: boolean;
  isGroup: boolean;
  filterEntity: <T extends { customer_name?: string | null; domain?: string | null; name?: string | null; company?: string | null }>(
    item: T
  ) => boolean;
} {
  const [workspace, setWorkspaceState] = React.useState<WorkspaceMode>("anutech");

  React.useEffect(() => {
    const sync = () => {
      if (typeof window !== "undefined") {
        const saved = localStorage.getItem("resellersos_active_workspace");
        if (saved === "excel" || saved === "group" || saved === "anutech") {
          setWorkspaceState(saved as WorkspaceMode);
        }
      }
    };

    sync();

    const handleCustomEvent = (e: Event) => {
      const customEvent = e as CustomEvent<WorkspaceMode>;
      if (customEvent.detail) {
        setWorkspaceState(customEvent.detail);
      } else {
        sync();
      }
    };

    window.addEventListener("storage", sync);
    window.addEventListener("resellersos-workspace-change", handleCustomEvent);

    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("resellersos-workspace-change", handleCustomEvent);
    };
  }, []);

  const setWorkspace = React.useCallback((ws: WorkspaceMode) => {
    setWorkspaceState(ws);
    if (typeof window !== "undefined") {
      localStorage.setItem("resellersos_active_workspace", ws);
      window.dispatchEvent(new CustomEvent("resellersos-workspace-change", { detail: ws }));
    }
  }, []);

  const filterEntity = React.useCallback(
    <T extends { customer_name?: string | null; domain?: string | null; name?: string | null; company?: string | null }>(
      item: T
    ): boolean => {
      if (workspace === "group") return true;

      const identifier = (
        (item.customer_name || "") +
        " " +
        (item.domain || "") +
        " " +
        (item.name || "") +
        " " +
        (item.company || "")
      ).toLowerCase();

      const isAnutechItem = identifier.includes("anutech");
      const isExcelItem = identifier.includes("excel") || identifier.includes("vera") || identifier.includes("veracious");

      if (workspace === "anutech") {
        return !isExcelItem || isAnutechItem;
      }

      if (workspace === "excel") {
        return !isAnutechItem;
      }

      return true;
    },
    [workspace]
  );

  return {
    workspace,
    setWorkspace,
    isAnutech: workspace === "anutech",
    isExcel: workspace === "excel",
    isGroup: workspace === "group",
    filterEntity,
  };
}
