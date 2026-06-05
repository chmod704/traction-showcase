/**
 * KSCAN — the Knowledge-Scan contract (Phase 0).
 *
 * The schema IS the discipline. Every KSCAN node is an ATOMIC, FALSIFIABLE claim
 * (never a summary) that carries its origin, its five independent value-layer
 * scores, a composite value, a confidence (capped at PROJECTION until real
 * outcomes confirm it), a status on the promotion ladder, provenance, and a
 * half-life (marketing truth rots; storm tactics rot fast).
 *
 * Nothing here does I/O — pure types + pure scoring so the composite/kill/half-life
 * logic is unit-testable in isolation. The gauntlet (value-stack.ts), the ladder
 * (promotion.ts), and the store (store.ts) build on this contract.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Origin + status
// ─────────────────────────────────────────────────────────────────────────────

export type KscanSourceType =
  | "video_transcript"
  | "podcast_transcript"
  | "web_article"
  | "forum_thread"
  | "paper_pdf"
  | "case_study"
  | "competitor_content";

export interface KscanOrigin {
  /** ALWAYS exogenous for KSCAN — this is the external-knowledge lane. */
  origin: "exogenous";
  sourceUrl: string | null;
  sourceType: KscanSourceType;
  capturedAt: string; // ISO
  /** The exact source span the claim was extracted from (auditability). */
  sourceSpan?: string | null;
}

/**
 * The promotion ladder. A node only earns endogenous truth by climbing it on
 * REAL outcomes — never by more scraping.
 *   candidate      — distilled, not yet through the gauntlet.
 *   verified-prior — survived the gauntlet; a strong, testable HYPOTHESIS (still PROJECTION).
 *   testing        — selected for a live controlled test on real client spend.
 *   confirmed      — our own outcome data rendered it true (→ CALIBRATED).
 *   refuted        — killed (by the gauntlet OR by a real outcome).
 */
export type KscanStatus = "candidate" | "verified-prior" | "testing" | "confirmed" | "refuted";

// ─────────────────────────────────────────────────────────────────────────────
// The five value layers (each independent; each can alone kill the claim)
// ─────────────────────────────────────────────────────────────────────────────

export interface KscanLayerScores {
  /** L1 who-said-it (KG4 credibility tier → 0..1). */
  credibility: number;
  /** L2 how-they-know-it (evidence grade — sample size / controlled / bias). */
  evidenceGrade: number;
  /** L3 survived adversarial refutation (KG3 red-team → 0..1). */
  adversarialSurvival: number;
  /** L4 does it transfer to roofing (domain / sub-vertical / regulatory). */
  verticalFit: number;
  /** L5 independent corroboration (not an echo chamber) → 0..1. */
  corroboration: number;
}

/** A layer scoring below this floor KILLS the claim (multiplicative near-zero). */
export const KILL_FLOOR = 0.05;
/** Confidence ceiling for any un-confirmed (PROJECTION) node. Hypotheses, not truth. */
export const PROJECTION_CEILING = 0.25;

export const LAYER_ORDER: Array<keyof KscanLayerScores> = [
  "credibility", // cheapest (free, deterministic) → run first
  "evidenceGrade",
  "adversarialSurvival",
  "verticalFit",
  "corroboration",
];

export interface GauntletVerdict {
  /** Multiplicative composite of the five layers, 0..1 — the testability/EV rank. */
  value: number;
  /** Dead = a layer fell below KILL_FLOOR (or the composite rounds to ~0). */
  dead: boolean;
  /** Which layer killed it (the first below the floor), or null. */
  killedBy: keyof KscanLayerScores | null;
}

/**
 * Composite VALUE = credibility × evidenceGrade × adversarialSurvival ×
 * verticalFit × corroboration. Multiplicative by design: weak on ANY axis ⇒
 * near-zero overall. Any layer below KILL_FLOOR marks the claim dead.
 */
export function gauntletVerdict(layers: Partial<KscanLayerScores>): GauntletVerdict {
  let value = 1;
  let killedBy: keyof KscanLayerScores | null = null;
  for (const k of LAYER_ORDER) {
    const raw = layers[k];
    const s = typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : 0;
    if (s < KILL_FLOOR && killedBy === null) killedBy = k;
    value *= s;
  }
  const dead = killedBy !== null || value < KILL_FLOOR;
  return { value: round4(value), dead, killedBy };
}

/**
 * The confidence a verified-prior node is STORED with: the composite value,
 * hard-capped at the PROJECTION ceiling. A hypothesis can never present as
 * calibrated truth before a real outcome confirms it (see promotion.ts).
 */
export function priorConfidence(verdict: GauntletVerdict): number {
  if (verdict.dead) return 0;
  return Math.min(verdict.value, PROJECTION_CEILING);
}

// ─────────────────────────────────────────────────────────────────────────────
// Half-life — marketing truth rots; tactics rot faster than fundamentals
// ─────────────────────────────────────────────────────────────────────────────

export type KscanClaimType =
  | "storm_tactic" // rots in weeks
  | "channel_tactic" // platform/algorithm-dependent — months
  | "offer_structure" // seasons
  | "creative_principle" // ~a year
  | "buyer_psychology"; // fundamentals — years

const HALF_LIFE_DAYS: Record<KscanClaimType, number> = {
  storm_tactic: 21,
  channel_tactic: 120,
  offer_structure: 240,
  creative_principle: 365,
  buyer_psychology: 1095,
};

export function halfLifeDays(claimType: KscanClaimType): number {
  return HALF_LIFE_DAYS[claimType] ?? HALF_LIFE_DAYS.channel_tactic;
}

/**
 * Exponential confidence decay since last verification. A node whose decayed
 * confidence falls below `floor` should re-enter the gauntlet or expire.
 */
export function decayedConfidence(args: {
  confidence: number;
  claimType: KscanClaimType;
  ageDays: number;
}): number {
  const hl = halfLifeDays(args.claimType);
  const decay = Math.pow(0.5, Math.max(0, args.ageDays) / hl);
  return round4(clamp01(args.confidence) * decay);
}

// ─────────────────────────────────────────────────────────────────────────────
// The node
// ─────────────────────────────────────────────────────────────────────────────

export interface KscanNode {
  /** The atomic, falsifiable assertion (NEVER a summary). */
  claim: string;
  /** Supporting context / the mechanism. */
  detail: string | null;
  claimType: KscanClaimType;
  origin: KscanOrigin;
  layers: KscanLayerScores;
  verdict: GauntletVerdict;
  /** Stored confidence — capped at PROJECTION until confirmed. */
  confidence: number;
  status: KscanStatus;
  /** Roofing sub-vertical this applies to (storm-chaser / premium-reno / insurance-restoration / all). */
  subVertical: string | null;
  halfLifeDays: number;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
