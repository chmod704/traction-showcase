/**
 * JARVIS — the 3-tier action-policy gate (J8 keystone).
 *
 * This is the safety wall every JARVIS lane builds to. JARVIS will be wired to
 * real send-email / SMS / spend; this file is the single place that decides,
 * for any tool, whether it may fire autonomously, fire with a live confirmation
 * (or park for batch approval offline), or whether it can NEVER auto-fire and
 * must be performed by a human.
 *
 * THE CONTRACT (Dean's decided safety wall):
 *
 *   TIER 0 — AUTONOMOUS (no approval).
 *     read / navigate / screenshot / snapshot / recall / DRAFT. Zero side-effects.
 *
 *   TIER 1 — PER-ACTION APPROVAL.
 *     Normal irreversible: send a drafted email to a KNOWN contact, pause/adjust
 *     an adset within a budget cap, book an inspection. Requires a confirmation
 *     token (live nod) OR, offline, parks in needs_review for batch approval
 *     (draft-and-park).
 *
 *   TIER 2 — PROPOSE-ONLY / HUMAN-FINAL-CLICK (the hard wall).
 *     The catastrophic class — billing/payment changes, spend above a threshold,
 *     anything OUTSIDE the domain+action allowlist, destructive/irreversible
 *     deletes, un-consented consumer messaging (TCPA). CANNOT auto-fire even with
 *     a token. JARVIS prepares + proposes; a human performs the final action.
 *
 * FAIL-CLOSED everywhere: an UNKNOWN tool is treated as TIER 2 propose-only.
 * `assertActionAllowed` NEVER throws — it returns the verdict so a caller can
 * surface it; throwing on the hot path would be a way for a bug to *skip* the
 * gate. The verdict object is the gate.
 *
 * This gate is defense-in-DEPTH layer #1. The tools themselves ALSO self-reject
 * (J8: `canSendNow` inside send-sms, recipient allow-list inside send-email,
 * side-effect markers before "done") so a tool firing on a path that forgot to
 * call this gate still fails closed. Two independent layers, not one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The interface — every lane (gate + dispatcher) builds to THIS exact shape.
// ─────────────────────────────────────────────────────────────────────────────

export type ActionTier = 0 | 1 | 2;

export interface ActionPolicyResult {
  /** Whether the action may proceed AT ALL right now. Tier 2 is ALWAYS false. */
  allowed: boolean;
  /** The classified tier. */
  tier: ActionTier;
  /** Tier 1 without a live confirmation token requires approval (or a park). */
  requiresApproval: boolean;
  /** Tier 2: JARVIS prepares + proposes; a human performs the final action. */
  proposeOnly: boolean;
  /** Plain-language reason for the verdict (audit + UI surface). */
  reason: string;
}

export interface ClassifyResult {
  tier: ActionTier;
  /** A coarse action class for journaling / audit (e.g. "consumer_messaging"). */
  actionClass: string;
}

export interface AssertActionInput {
  /** The tool name as registered in src/tools/index.ts (or any string — unknown → tier 2). */
  tool: string;
  /** Optional runtime context that can ESCALATE a tier (e.g. spend amount, recipient domain). */
  ctx?: Record<string, unknown>;
  /** Did a human provide a live confirmation token (the "nod")? */
  hasConfirmation?: boolean;
  /** Is JARVIS online/attended right now? Offline tier-1 parks for batch approval. */
  online?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier map — covers every tool in src/tools/index.ts by name.
//
// Mapping rationale:
//   TIER 0 (read/draft, zero side-effect): supabase_select, web_search, the
//     cortex/vault READS, market context, metric reads, apollo search, image
//     generation (a draft asset), creative-asset draft writes.
//   TIER 1 (normal irreversible w/ approval): send_email, send_sms,
//     schedule_inspection, the campaign create/adjust tools, slack posts,
//     prospect/kpi writes, request_approval (it IS the approval primitive).
//   TIER 2 (the hard wall — NEVER auto-fire): nothing in the static tool set is
//     hard-coded tier 2 by name today, but the CONTEXT escalators below promote a
//     tier-1 tool to tier 2 when it crosses a catastrophic threshold (spend over
//     cap, billing/payment, un-allowlisted domain, destructive delete). And any
//     tool NOT in this map is tier 2 by fail-closed default.
// ─────────────────────────────────────────────────────────────────────────────

interface ToolPolicy {
  tier: ActionTier;
  actionClass: string;
}

const TOOL_POLICY: Record<string, ToolPolicy> = {
  // ── TIER 0 — autonomous, zero side-effects (reads / drafts) ────────────────
  supabase_select: { tier: 0, actionClass: "read" },
  web_search: { tier: 0, actionClass: "read" },
  get_market_context: { tier: 0, actionClass: "read" },
  get_google_metrics: { tier: 0, actionClass: "read" },
  clients_list: { tier: 0, actionClass: "read" },
  read_vault_file: { tier: 0, actionClass: "read" },
  vault_recent_commits: { tier: 0, actionClass: "read" },
  apollo_search: { tier: 0, actionClass: "read" },
  // generate_image / write_creative_asset are DRAFTS — they mint a reversible
  // internal asset, never an external side-effect, so they are tier 0.
  generate_image: { tier: 0, actionClass: "draft" },
  write_creative_asset: { tier: 0, actionClass: "draft" },

  // ── TIER 1 — normal irreversible, per-action approval ──────────────────────
  // External consumer/contact messaging — irreversible, known-contact only.
  send_email: { tier: 1, actionClass: "comms_email" },
  send_sms: { tier: 1, actionClass: "consumer_messaging" },
  // Booking a real appointment (durable + calendar write).
  schedule_inspection: { tier: 1, actionClass: "booking" },
  // Campaign creation / spend-shaping — within a budget cap. Ships PAUSED, but
  // creating live ad structure is irreversible enough to gate per-action.
  create_facebook_campaign: { tier: 1, actionClass: "campaign_create" },
  create_google_campaign: { tier: 1, actionClass: "campaign_create" },
  // Internal durable writes that move judgment / external Slack.
  post_to_slack: { tier: 1, actionClass: "notify" },
  upsert_prospect: { tier: 1, actionClass: "crm_write" },
  write_client_kpi: { tier: 1, actionClass: "data_write" },
  supabase_upsert: { tier: 1, actionClass: "data_write" },
  write_vault_file: { tier: 1, actionClass: "vault_write" },
  append_vault_file: { tier: 1, actionClass: "vault_write" },
  commit_vault: { tier: 1, actionClass: "vault_write" },
  publish_event: { tier: 1, actionClass: "event_publish" },
  log_decision: { tier: 1, actionClass: "data_write" },
  // request_approval IS the human-in-loop primitive — it can be issued to ask
  // for a nod. It never performs the underlying action itself.
  request_approval: { tier: 1, actionClass: "approval_request" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Context escalators — the catastrophic class (TIER 2 hard wall).
//
// These promote an otherwise tier-0/1 tool to tier 2 when the *context* of the
// call crosses a catastrophic threshold. Fail-closed: when in doubt, escalate.
// Order matters — first match wins, most-catastrophic first.
// ─────────────────────────────────────────────────────────────────────────────

/** Spend over this many cents ($500) can never auto-fire — human final click. */
export const SPEND_HARD_CAP_CENTS = 50_000;

/** Default email recipient allow-list domains (owner-ops). Extend via ctx.allowedDomains. */
const DEFAULT_ALLOWED_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "tractionroofing.com",
  "traction.agency",
]);

/** Tokens in a tool name / actionClass that mark the destructive/billing class. */
const TIER2_NAME_PATTERNS: RegExp[] = [
  /\bbilling\b/i,
  /\bpayment\b/i,
  /\bcharge\b/i,
  /\brefund\b/i,
  /\bpayout\b/i,
  /\bcancel[_-]?subscription\b/i,
  /\b(delete|destroy|drop|purge|wipe|truncate)\b/i,
];

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function emailDomain(addr: unknown): string | null {
  if (typeof addr !== "string") return null;
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  return addr.slice(at + 1).trim().toLowerCase() || null;
}

/**
 * Decide whether the CONTEXT of a call escalates it to the tier-2 hard wall.
 * Returns the escalated actionClass + reason, or null if no escalation.
 */
function tier2Escalation(
  tool: string,
  baseClass: string,
  ctx?: Record<string, unknown>
): { actionClass: string; reason: string } | null {
  // 1. Tool name / action class matches the destructive / billing class.
  for (const re of TIER2_NAME_PATTERNS) {
    if (re.test(tool) || re.test(baseClass)) {
      return {
        actionClass: "catastrophic_class",
        reason: `Tool/class matches the catastrophic pattern (${re.source}) — human final click required.`,
      };
    }
  }
  if (!ctx) return null;

  // 2. Explicit spend amount over the hard cap.
  const spendCents =
    num(ctx.spendCents) ??
    num(ctx.amountCents) ??
    (num(ctx.spend) != null ? (num(ctx.spend) as number) * 100 : null) ??
    (num(ctx.amount) != null ? (num(ctx.amount) as number) * 100 : null) ??
    (num(ctx.budgetCents) != null ? (num(ctx.budgetCents) as number) : null) ??
    (num(ctx.dailyBudget) != null ? (num(ctx.dailyBudget) as number) * 100 : null);
  if (spendCents != null && spendCents > SPEND_HARD_CAP_CENTS) {
    return {
      actionClass: "spend_over_cap",
      reason: `Spend ${spendCents}¢ exceeds the $${(SPEND_HARD_CAP_CENTS / 100).toFixed(
        0
      )} hard cap — human final click required.`,
    };
  }

  // 3. Explicit catastrophic flags a caller may set.
  if (ctx.billing === true || ctx.payment === true || ctx.destructive === true) {
    return {
      actionClass: "catastrophic_class",
      reason: "Context flagged billing/payment/destructive — human final click required.",
    };
  }

  // 4. Email to an un-allowlisted recipient domain = outside the domain allowlist.
  if (tool === "send_email") {
    const allowed = new Set<string>(DEFAULT_ALLOWED_EMAIL_DOMAINS);
    const extra = ctx.allowedDomains;
    if (Array.isArray(extra)) for (const d of extra) if (typeof d === "string") allowed.add(d.toLowerCase());
    // Allow an explicit known-contact override (a vetted recipient on file).
    const knownContact = ctx.knownContact === true || ctx.recipientKnown === true;
    const dom = emailDomain(ctx.to ?? ctx.recipient ?? ctx.email);
    if (dom != null && !allowed.has(dom) && !knownContact) {
      return {
        actionClass: "external_unallowlisted",
        reason: `Email recipient domain "${dom}" is outside the allow-list and not a known contact — human final click required.`,
      };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// classifyTool — the pure tier lookup (+ context escalation).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a tool into its action tier + action class. Fail-closed: a tool not
 * in the policy map is TIER 2 (propose-only) by default. Context can ESCALATE a
 * tier-0/1 tool to tier 2, but NEVER de-escalates below the static map.
 */
export function classifyTool(
  toolName: string,
  ctx?: Record<string, unknown>
): ClassifyResult {
  const base = TOOL_POLICY[toolName];

  // Unknown tool → fail closed at the hard wall.
  if (!base) {
    return { tier: 2, actionClass: "unknown_tool" };
  }

  // Context escalation can only RAISE the tier to 2, never lower it.
  const esc = tier2Escalation(toolName, base.actionClass, ctx);
  if (esc) {
    return { tier: 2, actionClass: esc.actionClass };
  }

  return { tier: base.tier, actionClass: base.actionClass };
}

// ─────────────────────────────────────────────────────────────────────────────
// assertActionAllowed — the verdict. NEVER throws.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce the policy verdict for an action. NEVER throws — returns the verdict
 * object. Fail-closed semantics:
 *
 *   - tier 0          → allowed, no approval.
 *   - tier 1 + token  → allowed (the live nod was given).
 *   - tier 1, no token, online  → requiresApproval (ask for the nod now).
 *   - tier 1, no token, offline → requiresApproval (park in needs_review for batch).
 *   - tier 2          → proposeOnly, allowed:false ALWAYS (even with a token).
 *   - unknown tool    → tier 2 (handled by classifyTool fail-closed).
 */
export function assertActionAllowed(input: AssertActionInput): ActionPolicyResult {
  const { tool, ctx, hasConfirmation = false, online = true } = input ?? ({} as AssertActionInput);

  // Defensive: a missing/blank tool name is itself an unknown tool → tier 2.
  const toolName = typeof tool === "string" ? tool : "";
  const { tier, actionClass } = classifyTool(toolName, ctx);

  // ── TIER 2 — the hard wall. ALWAYS propose-only, ALWAYS not-allowed. ────────
  if (tier === 2) {
    const why =
      actionClass === "unknown_tool"
        ? `Unknown tool "${toolName}" — fail-closed to propose-only. A human must perform any unrecognized action.`
        : `${actionClass}: this is the catastrophic class — JARVIS proposes, a human performs the final action. A confirmation token does NOT unlock it.`;
    return {
      allowed: false,
      tier: 2,
      requiresApproval: true,
      proposeOnly: true,
      reason: why,
    };
  }

  // ── TIER 0 — autonomous. ───────────────────────────────────────────────────
  if (tier === 0) {
    return {
      allowed: true,
      tier: 0,
      requiresApproval: false,
      proposeOnly: false,
      reason: `${actionClass}: tier-0 autonomous (read/draft, zero side-effects).`,
    };
  }

  // ── TIER 1 — per-action approval. ──────────────────────────────────────────
  if (hasConfirmation) {
    return {
      allowed: true,
      tier: 1,
      requiresApproval: false,
      proposeOnly: false,
      reason: `${actionClass}: tier-1 irreversible — confirmation token present, proceeding.`,
    };
  }

  // No token. Requires approval either way; the SHAPE differs online vs offline.
  return {
    allowed: false,
    tier: 1,
    requiresApproval: true,
    proposeOnly: false,
    reason: online
      ? `${actionClass}: tier-1 irreversible — requires a live confirmation (the nod) before it fires.`
      : `${actionClass}: tier-1 irreversible — offline, parking in needs_review for batch approval (draft-and-park).`,
  };
}
