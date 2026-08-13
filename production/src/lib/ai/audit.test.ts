import { describe, it, expect, vi, afterEach } from "vitest";
import { logAiDecision, formatGuardBlock } from "./audit";

type Client = Parameters<typeof logAiDecision>[0];
type RpcArgs = { p_action: string; p_entity: string; p_entity_id: string | null; p_label: string };
/** Minimal stand-in for the Supabase client — only `.rpc()` is used. */
const clientWith = (rpc: (fn: string, args: RpcArgs) => Promise<{ error: { message: string } | null }>) =>
  ({ rpc } as unknown as Client);

afterEach(() => vi.restoreAllMocks());

describe("logAiDecision", () => {
  it("calls log_activity with the decision", async () => {
    const rpc = vi.fn(async (_fn: string, _args: RpcArgs) => ({ error: null }));
    await logAiDecision(clientWith(rpc), {
      action: "ai_blocked", entity: "customers", entityId: "cus-1", label: "AI wrote ₹45,000",
    });
    expect(rpc).toHaveBeenCalledWith("log_activity", {
      p_action: "ai_blocked", p_entity: "customers", p_entity_id: "cus-1", p_label: "AI wrote ₹45,000",
    });
  });

  it("sends null rather than undefined when there is no entity id", async () => {
    const rpc = vi.fn(async (_fn: string, _args: RpcArgs) => ({ error: null }));
    await logAiDecision(clientWith(rpc), { action: "ai_fallback", entity: "leads", label: "x" });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_entity_id: null });
  });

  it("truncates the label to what the column accepts", async () => {
    const rpc = vi.fn(async (_fn: string, _args: RpcArgs) => ({ error: null }));
    await logAiDecision(clientWith(rpc), { action: "ai_blocked", entity: "leads", label: "x".repeat(500) });
    expect(rpc.mock.calls[0][1].p_label).toHaveLength(120);
  });

  // ── Auditing must never break the thing it audits ────────────────────────
  it("swallows an RPC error — the operator still gets their draft", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async (_fn: string, _args: RpcArgs) => ({ error: { message: "permission denied" } }));
    await expect(logAiDecision(clientWith(rpc), { action: "ai_blocked", entity: "leads", label: "x" }))
      .resolves.toBeUndefined();
  });

  it("swallows a thrown error too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn(async (_fn: string, _args: RpcArgs): Promise<{ error: null }> => { throw new Error("network down"); });
    await expect(logAiDecision(clientWith(rpc), { action: "ai_fallback", entity: "leads", label: "x" }))
      .resolves.toBeUndefined();
  });
});

describe("formatGuardBlock", () => {
  it("records BOTH what the model said and what it was allowed to say", () => {
    // The offending figure alone is unreadable six weeks later; the pair is the
    // whole story, and it is what distinguishes a real hallucination from the
    // guard mis-firing on a correct number written in an unexpected form.
    const s = formatGuardBlock(["₹45,000"], [4500]);
    expect(s).toContain("₹45,000");
    expect(s).toContain("₹4,500");
    expect(s).toContain("discarded");
  });

  it("groups Indian digits in the allowed figures", () => {
    expect(formatGuardBlock(["₹9,00,000"], [685000])).toContain("₹6,85,000");
  });

  it("says 'no amount' when the draft was allowed to mention none", () => {
    expect(formatGuardBlock(["₹500"], [])).toContain("no amount");
  });

  it("lists every violation", () => {
    const s = formatGuardBlock(["₹100", "₹300"], [200]);
    expect(s).toContain("₹100");
    expect(s).toContain("₹300");
  });

  it("stays inside the 120-char column budget for realistic input", () => {
    expect(formatGuardBlock(["₹45,000"], [4500]).length).toBeLessThanOrEqual(120);
  });
});
