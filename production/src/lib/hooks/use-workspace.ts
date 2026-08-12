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

  /**
   * Deterministic 100% Database Tenant Classification.
   * Zero random hash partitioning or guessing.
   */
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
      const ANUTECH_TENANT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42";

      // 1. Explicit Database tenant_id Ground Truth
      if (item.tenant_id) {
        if (EXCEL_TENANT_IDS.includes(item.tenant_id)) return true;
        if (item.tenant_id === ANUTECH_TENANT_ID) return false;
      }

      // 2. Explicit Keyword matching for legacy rows without tenant_id
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

      if (identifier.includes("excel technologies")) return false;
      if (identifier.includes("anutech")) return false;
      if (identifier.includes("excel") || identifier.includes("vera") || identifier.includes("veracious")) return true;

      // Default: Belongs 100% strictly to Master Distributor (Anutech Digital)
      return false;
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

      // Excel Technologies as a Sub-Reseller Account belongs to Anutech Digital's workspace
      if (identifier.includes("excel technologies")) {
        return workspace === "anutech" || (workspace as string) === "group";
      }

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

      if (identifier.includes("excel technologies")) {
        return { label: "Sub-Reseller Account", kind: "info" as const };
      }

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
