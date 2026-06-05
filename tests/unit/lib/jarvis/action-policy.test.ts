import { describe, it, expect } from "vitest";
import {
  classifyTool,
  assertActionAllowed,
  SPEND_HARD_CAP_CENTS,
  type ActionPolicyResult,
} from "@/lib/jarvis/action-policy";

/**
 * The 3-tier action-policy gate — the JARVIS safety keystone. These tests are
 * the contract: the catastrophic class can NEVER auto-fire, unknown tools fail
 * closed to propose-only, and tier-1 sends without a token are blocked/parked.
 */
describe("action-policy — classifyTool", () => {
  it("classifies reads as tier 0 (autonomous)", () => {
    expect(classifyTool("supabase_select").tier).toBe(0);
    expect(classifyTool("web_search").tier).toBe(0);
    expect(classifyTool("get_market_context").tier).toBe(0);
    expect(classifyTool("clients_list").tier).toBe(0);
    expect(classifyTool("read_vault_file").tier).toBe(0);
  });

  it("classifies drafts (no external side-effect) as tier 0", () => {
    expect(classifyTool("generate_image").tier).toBe(0);
    expect(classifyTool("write_creative_asset").tier).toBe(0);
  });

  it("classifies normal irreversible sends as tier 1", () => {
    expect(classifyTool("send_email").tier).toBe(1);
    expect(classifyTool("send_sms").tier).toBe(1);
    expect(classifyTool("schedule_inspection").tier).toBe(1);
    expect(classifyTool("create_facebook_campaign").tier).toBe(1);
    expect(classifyTool("create_google_campaign").tier).toBe(1);
  });

  it("FAIL-CLOSED: an UNKNOWN tool is tier 2 (propose-only)", () => {
    const c = classifyTool("rm_rf_prod");
    expect(c.tier).toBe(2);
    expect(c.actionClass).toBe("unknown_tool");
  });

  // NOTE (showcase): the full repo also has a registry-drift guard here that
  // imports the entire @/tools registry to assert every tool has an explicit
  // tier. It's omitted from this standalone slice (the registry isn't shipped);
  // the gate logic below is fully self-contained and proven.
});

describe("action-policy — context escalation to the tier-2 hard wall", () => {
  it("escalates a name/class matching billing/payment to tier 2", () => {
    expect(classifyTool("change_billing").tier).toBe(2);
    expect(classifyTool("issue_refund").tier).toBe(2);
    expect(classifyTool("delete_account").tier).toBe(2);
  });

  it("escalates a tier-1 campaign tool to tier 2 when spend exceeds the hard cap", () => {
    const under = classifyTool("create_facebook_campaign", { spendCents: SPEND_HARD_CAP_CENTS - 1 });
    expect(under.tier).toBe(1);
    const over = classifyTool("create_facebook_campaign", { spendCents: SPEND_HARD_CAP_CENTS + 1 });
    expect(over.tier).toBe(2);
    expect(over.actionClass).toBe("spend_over_cap");
  });

  it("escalates send_email to tier 2 for an un-allowlisted external domain", () => {
    const internal = classifyTool("send_email", { to: "dean@tractionroofing.com" });
    expect(internal.tier).toBe(1);
    const external = classifyTool("send_email", { to: "stranger@randomdomain.xyz" });
    expect(external.tier).toBe(2);
    expect(external.actionClass).toBe("external_unallowlisted");
  });

  it("a known-contact override keeps an external email at tier 1", () => {
    const c = classifyTool("send_email", { to: "stranger@randomdomain.xyz", knownContact: true });
    expect(c.tier).toBe(1);
  });

  it("context NEVER de-escalates a tier-1 tool below 1", () => {
    // schedule_inspection with benign context stays tier 1.
    expect(classifyTool("schedule_inspection", { foo: "bar" }).tier).toBe(1);
  });
});

describe("action-policy — assertActionAllowed (the verdict, NEVER throws)", () => {
  it("tier 0 → allowed, no approval", () => {
    const r = assertActionAllowed({ tool: "supabase_select" });
    expect(r).toMatchObject<Partial<ActionPolicyResult>>({
      allowed: true,
      tier: 0,
      requiresApproval: false,
      proposeOnly: false,
    });
  });

  it("tier 1 WITH a confirmation token → allowed", () => {
    const r = assertActionAllowed({ tool: "send_email", ctx: { to: "dean@tractionroofing.com" }, hasConfirmation: true });
    expect(r.allowed).toBe(true);
    expect(r.tier).toBe(1);
    expect(r.requiresApproval).toBe(false);
  });

  it("ADVERSARIAL: a tier-1 send WITHOUT a token is blocked (online → requires live nod)", () => {
    const r = assertActionAllowed({ tool: "send_email", ctx: { to: "dean@tractionroofing.com" }, online: true });
    expect(r.allowed).toBe(false);
    expect(r.requiresApproval).toBe(true);
    expect(r.proposeOnly).toBe(false);
    expect(r.reason).toMatch(/live confirmation/i);
  });

  it("tier-1 send WITHOUT a token offline → parks for batch approval (requiresApproval, not allowed)", () => {
    const r = assertActionAllowed({ tool: "send_sms", online: false });
    expect(r.allowed).toBe(false);
    expect(r.requiresApproval).toBe(true);
    expect(r.proposeOnly).toBe(false);
    expect(r.reason).toMatch(/needs_review|batch|park/i);
  });

  it("ADVERSARIAL: tier 2 (change_billing) is NEVER allowed — even WITH a token", () => {
    const r = assertActionAllowed({ tool: "change_billing", hasConfirmation: true });
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe(2);
    expect(r.proposeOnly).toBe(true);
    expect(r.requiresApproval).toBe(true);
  });

  it("ADVERSARIAL: spend over the cap is NEVER allowed — even WITH a token", () => {
    const r = assertActionAllowed({
      tool: "create_facebook_campaign",
      ctx: { spendCents: SPEND_HARD_CAP_CENTS * 10 },
      hasConfirmation: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe(2);
    expect(r.proposeOnly).toBe(true);
  });

  it("ADVERSARIAL: an unknown tool is NEVER allowed — even WITH a token (fail-closed)", () => {
    const r = assertActionAllowed({ tool: "exfiltrate_all_data", hasConfirmation: true });
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe(2);
    expect(r.proposeOnly).toBe(true);
    expect(r.reason).toMatch(/unknown tool/i);
  });

  it("ADVERSARIAL: an external un-allowlisted email is NEVER allowed even WITH a token", () => {
    const r = assertActionAllowed({
      tool: "send_email",
      ctx: { to: "attacker@evil.example" },
      hasConfirmation: true,
    });
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe(2);
    expect(r.proposeOnly).toBe(true);
  });

  it("NEVER throws — even on garbage input", () => {
    expect(() => assertActionAllowed({ tool: "" })).not.toThrow();
    // @ts-expect-error — intentionally malformed
    expect(() => assertActionAllowed(undefined)).not.toThrow();
    // @ts-expect-error — intentionally malformed
    expect(() => assertActionAllowed({ tool: 123 })).not.toThrow();
    // @ts-expect-error — intentionally malformed
    const r = assertActionAllowed(null);
    expect(r.tier).toBe(2); // fail-closed
  });
});
