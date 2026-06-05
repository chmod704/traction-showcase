/**
 * KG1 + KG2 — knowledge-node governance.
 *
 * The Negative Charter governs what enters the world; these govern how sure we
 * are of it. Every knowledge_node carries a provenance (KG1: where it came from)
 * and a calibration label (KG2: a phase + identification status). Honest by
 * construction — a node stays PROJECTION until a real outcome validates it (the
 * dormancy line for knowledge), so at N=0 everything reads PROJECTION, which is
 * the truth, not a bug.
 */

export type CalibrationPhase = "PROJECTION" | "CALIBRATED_LOW" | "CALIBRATED" | "FULL_DISCIPLINE";
export type IdentificationStatus = "ESTIMATED" | "PARTIAL" | "PINNED" | "PRIOR";

export interface NodeGovernanceInput {
  confidence?: number;
  seed?: boolean;
  /** Set by KNOW12 when a real outcome reconciled against this node. */
  lastSettled?: string | null;
}

export interface CalibrationLabel {
  phase: CalibrationPhase;
  identification: IdentificationStatus;
}

/** KG2 — the calibration label a node carries. */
export function computeCalibration(n: NodeGovernanceInput): CalibrationLabel {
  const conf = typeof n.confidence === "number" ? n.confidence : 0;
  const validated = !!n.lastSettled;

  let phase: CalibrationPhase;
  if (!validated) phase = "PROJECTION";
  else if (conf < 0.6) phase = "CALIBRATED_LOW";
  else if (conf < 0.85) phase = "CALIBRATED";
  else phase = "FULL_DISCIPLINE";

  let identification: IdentificationStatus;
  if (n.seed) identification = "PRIOR"; // a hand-curated prior, not estimated from data
  else if (validated) identification = "ESTIMATED"; // confirmed against a real outcome
  else identification = "PARTIAL"; // extracted from a source, not yet outcome-confirmed

  return { phase, identification };
}

/** KG1 — the provenance a node carries: where it came from and when. The
 *  decision/outcome legs of the full chain live in ad_knowledge_provenance
 *  (KNOW5) + the KNOW12 confirmed_by/contradicted_by edges. */
export interface Provenance {
  source: string;
  capturedAt: string | null;
  asserter: string;
}

export function extractProvenance(attributes: Record<string, any> | null | undefined): Provenance {
  const a = attributes ?? {};
  const source = typeof a.source === "string" ? a.source : "unknown";
  const capturedAt = typeof a.capturedAt === "string" ? a.capturedAt : null;
  const asserter = a.seed ? "operator (seed)" : source;
  return { source, capturedAt, asserter };
}

export interface GovernanceSummary {
  total: number;
  byPhase: Record<CalibrationPhase, number>;
  byIdentification: Record<IdentificationStatus, number>;
}

export function emptyGovernanceSummary(): GovernanceSummary {
  return {
    total: 0,
    byPhase: { PROJECTION: 0, CALIBRATED_LOW: 0, CALIBRATED: 0, FULL_DISCIPLINE: 0 },
    byIdentification: { ESTIMATED: 0, PARTIAL: 0, PINNED: 0, PRIOR: 0 },
  };
}

/** Aggregate the calibration labels of a node set — the Cortex panel shows this. */
export function summarizeGovernance(
  nodes: Array<{ attributes?: Record<string, any> | null }>,
): GovernanceSummary {
  const out = emptyGovernanceSummary();
  out.total = nodes.length;
  for (const node of nodes) {
    const a = node.attributes ?? {};
    const label = computeCalibration({ confidence: a.confidence, seed: a.seed, lastSettled: a.last_settled });
    out.byPhase[label.phase]++;
    out.byIdentification[label.identification]++;
  }
  return out;
}
