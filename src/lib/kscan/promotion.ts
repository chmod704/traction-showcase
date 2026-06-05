/**
 * KSCAN Phase 4 — THE PROMOTION LADDER (how exogenous becomes endogenous).
 *
 * This is the part that confers truth — and the part a competitor scraping
 * YouTube can NEVER copy, because it requires the live outcome loop:
 *
 *   candidate ──gauntlet──▶ verified-prior ──select──▶ testing ──real outcome──▶ confirmed | refuted
 *
 * The invariant: a node's confidence can exceed PROJECTION_CEILING ONLY when a
 * REAL outcome has confirmed it (status === "confirmed"). More scraping never
 * raises confidence past PROJECTION — only our own roofing dollars do. Pure +
 * total so the ladder rules are unit-tested without I/O.
 */

import {
  PROJECTION_CEILING,
  priorConfidence,
  type GauntletVerdict,
  type KscanStatus,
} from "./schema";
import type { CalibrationPhase } from "@/lib/knowledge/governance";

export interface LadderResult {
  status: KscanStatus;
  confidence: number;
  calibration: CalibrationPhase;
}

/** Gauntlet verdict → the first ladder rung. Dead ⇒ refuted; survived ⇒ verified-prior (PROJECTION). */
export function promoteFromGauntlet(verdict: GauntletVerdict): LadderResult {
  if (verdict.dead) {
    return { status: "refuted", confidence: 0, calibration: "PROJECTION" };
  }
  return {
    status: "verified-prior",
    confidence: priorConfidence(verdict), // capped at PROJECTION_CEILING
    calibration: "PROJECTION",
  };
}

/**
 * Select a verified-prior for a live controlled test. Only a verified-prior is
 * eligible (you don't spend real money testing a dead or already-settled claim).
 * Confidence is unchanged — testing doesn't confer truth, the OUTCOME does.
 */
export function selectForTesting(current: { status: KscanStatus; confidence: number }): LadderResult {
  if (current.status !== "verified-prior") {
    return { status: current.status, confidence: current.confidence, calibration: "PROJECTION" };
  }
  return { status: "testing", confidence: Math.min(current.confidence, PROJECTION_CEILING), calibration: "PROJECTION" };
}

export interface OutcomeVerdict {
  /** A REAL, settled outcome from live spend (the only thing that confers truth). */
  settled: true;
  confirmed: boolean;
  /** Measured confidence from the outcome (e.g. incrementality posterior). 0..1. */
  measuredConfidence: number;
}

/**
 * Settle a `testing` node against a REAL outcome. This is the ONLY transition
 * that can lift confidence above PROJECTION_CEILING — and only on confirmation.
 * A refutation by outcome kills the node regardless of how good the gauntlet was.
 */
export function settleFromOutcome(
  current: { status: KscanStatus },
  outcome: OutcomeVerdict,
): LadderResult {
  // Only a node actually under test can be settled by an outcome.
  if (current.status !== "testing") {
    return { status: current.status, confidence: 0, calibration: "PROJECTION" };
  }
  if (!outcome.confirmed) {
    return { status: "refuted", confidence: 0, calibration: "PROJECTION" };
  }
  const conf = clamp01(outcome.measuredConfidence);
  // CONFIRMED by real data → confidence may now exceed PROJECTION; calibration graduates.
  const calibration: CalibrationPhase = conf < 0.6 ? "CALIBRATED_LOW" : conf < 0.85 ? "CALIBRATED" : "FULL_DISCIPLINE";
  return { status: "confirmed", confidence: conf, calibration };
}

/**
 * THE INVARIANT enforcer. Given a status + a desired confidence, return the
 * confidence the node is ALLOWED to carry. Anything not "confirmed" is hard-capped
 * at PROJECTION_CEILING — no scraping, no gauntlet score, nothing can push an
 * unconfirmed claim past the hypothesis ceiling.
 */
export function enforceConfidenceCeiling(status: KscanStatus, confidence: number): number {
  const c = clamp01(confidence);
  return status === "confirmed" ? c : Math.min(c, PROJECTION_CEILING);
}

/**
 * Injection discipline: a node may inject as TRUSTED guidance only when confirmed.
 * Everything below confirmed injects (if at all) as a clearly-labeled hypothesis,
 * never as guidance — the agent must always know whether it stands on proof or a guess.
 */
export function injectionMode(status: KscanStatus): "guidance" | "hypothesis" | "withheld" {
  if (status === "confirmed") return "guidance";
  if (status === "verified-prior" || status === "testing") return "hypothesis";
  return "withheld"; // candidate / refuted never inject
}

function clamp01(n: number): number {
  return typeof n === "number" && Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0;
}
