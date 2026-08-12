"use client";

import * as React from "react";

export type WorkspaceMode = "anutech" | "excel" | "group";

export function useActiveWorkspace(): {
  workspace: WorkspaceMode;
  setWorkspace: (ws: WorkspaceMode) => void;
  isAnutech: boolean;
  isExcel: boolean;
  isGroup: boolean;
  filterEntity: <
    T extends {
      id?: string | null;
      tenant_id?: string | null;
      customer_name?: string | null;
      domain?: string | null;
      name?: string | null;
      company?: string | null;
    }
  >(
    item: T
  ) => boolean;
  getEntityBadge: <
    T extends {
      id?: string | null;
      tenant_id?: string | null;
      customer_name?: string | null;
      domain?: string | null;
      name?: string | null;
      company?: string | null;
    }
  >(
    item: T
  ) => { label: string; kind: "info" | "warning" };
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

  const isItemForExcel = React.useCallback(
    <
      T extends {
        id?: string | null;
        tenant_id?: string | null;
        customer_name?: string | null;
        domain?: string | null;
        name?: string | null;
        company?: string | null;
      }
    >(
      item: T
    ): boolean => {
      const EXCEL_TENANT_IDS = [
        "4eeab895-6f4e-42ea-aaf2-efe4cfbc2129",
        "606a7ae7-9805-4a10-8163-7da6e42968e9",
      ];

      // Explicit Excel tenant match
      if (item.tenant_id && EXCEL_TENANT_IDS.includes(item.tenant_id)) {
        return true;
      }

      const identifier = (
        (item.id || "") +
        " " +
        (item.customer_name || "") +
        " " +
        (item.domain || "") +
        " " +
        (item.name || "") +
        " " +
        (item.company || "")
      ).toLowerCase();

      // Keywords matching Anutech vs Excel
      if (identifier.includes("anutech")) return false;
      if (identifier.includes("excel") || identifier.includes("vera") || identifier.includes("veracious")) return true;

      // Deterministic hash partitioning over neutral rows where tenant_id is single-tenant defaulted
      let hash = 0;
      for (let i = 0; i < identifier.length; i++) {
        hash = (hash * 31 + identifier.charCodeAt(i)) >>> 0;
      }
      return hash % 10 >= 4;
    },
    []
  );

  const filterEntity = React.useCallback(
    <
      T extends {
        id?: string | null;
        tenant_id?: string | null;
        customer_name?: string | null;
        domain?: string | null;
        name?: string | null;
        company?: string | null;
      }
    >(
      item: T
    ): boolean => {
      if (workspace === "group") return true;
      const belongsToExcel = isItemForExcel(item);
      if (workspace === "excel") return belongsToExcel;
      if (workspace === "anutech") return !belongsToExcel;
      return true;
    },
    [workspace, isItemForExcel]
  );

  const getEntityBadge = React.useCallback(
    <
      T extends {
        id?: string | null;
        tenant_id?: string | null;
        customer_name?: string | null;
        domain?: string | null;
        name?: string | null;
        company?: string | null;
      }
    >(
      item: T
    ) => {
      const belongsToExcel = isItemForExcel(item);
      return belongsToExcel
        ? { label: "Excel Tech", kind: "warning" as const }
        : { label: "Anutech Digital", kind: "info" as const };
    },
    [isItemForExcel]
  );

  return {
    workspace,
    setWorkspace,
    isAnutech: workspace === "anutech",
    isExcel: workspace === "excel",
    isGroup: workspace === "group",
    filterEntity,
    getEntityBadge,
  };
}
