/**
 * Packages — TanStack Query hooks (2 Oct 2026). Read for everyone in the tenant;
 * save/delete go through RLS (owner/manager). Saves are one RPC so a package is never
 * left without its parts (save_package, migration 20261002170000).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { PackageRow, PackageItemRow } from "@/lib/packages/price";

export function usePackages(opts?: { includeInactive?: boolean }) {
  return useQuery({
    queryKey: ["packages", opts?.includeInactive ?? false],
    queryFn: async (): Promise<PackageRow[]> => {
      const supabase = createClient();
      let q = supabase
        .from("packages")
        .select("id, name, pitch, discount_pct, is_active, sort_order, package_items(item_id, qty_mode, fixed_qty, optional, sort_order)")
        .order("sort_order")
        .order("name");
      if (!opts?.includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        pitch: p.pitch,
        discount_pct: Number(p.discount_pct) || 0,
        is_active: p.is_active,
        sort_order: p.sort_order,
        items: ((p.package_items ?? []) as PackageItemRow[]).slice().sort((a, b) => a.sort_order - b.sort_order),
      }));
    },
    staleTime: 5 * 60 * 1000,
  });
}

export interface PackageDraft {
  id: string | null;
  name: string;
  pitch: string;
  discount_pct: number;
  is_active: boolean;
  items: Array<Pick<PackageItemRow, "item_id" | "qty_mode" | "fixed_qty" | "optional">>;
}

export function useSavePackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (d: PackageDraft) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("save_package", {
        p_id: d.id,
        p_name: d.name,
        p_pitch: d.pitch,
        p_discount_pct: d.discount_pct,
        p_is_active: d.is_active,
        p_items: d.items.map((i) => ({
          item_id: i.item_id,
          qty_mode: i.qty_mode,
          fixed_qty: i.qty_mode === "fixed" ? Math.max(1, i.fixed_qty ?? 1) : null,
          optional: i.optional,
        })),
      });
      if (error) throw error;
      return data as unknown as string;
    },
    onSuccess: (_id, d) => {
      qc.invalidateQueries({ queryKey: ["packages"] });
      toast.success(d.id ? "Package saved" : "Package created");
    },
    onError: (err) => toast.error(friendlyPackageError((err as Error).message)),
  });
}

export function useDeletePackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("packages").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["packages"] });
      toast.success("Package deleted");
    },
    onError: (err) => toast.error(friendlyPackageError((err as Error).message)),
  });
}

/** Database refusals in words a person can act on. */
export function friendlyPackageError(msg: string): string {
  if (/row-level security|42501|permission denied/i.test(msg)) return "Only an owner or manager can change packages.";
  if (/packages_tenant_id_name_key|duplicate key/i.test(msg)) return "A package with this name already exists.";
  if (/at least one item/i.test(msg)) return "Add at least one item to the package.";
  if (/discount_pct/i.test(msg)) return "Package discount can be at most 30%.";
  return msg;
}
