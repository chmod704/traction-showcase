import { describe, it, expect } from "vitest";
import {
  gauntletVerdict,
  priorConfidence,
  decayedConfidence,
  halfLifeDays,
  PROJECTION_CEILING,
  KILL_FLOOR,
  type KscanLayerScores,
} from "@/lib/kscan/schema";

const strong: KscanLayerScores = {
  credibility: 0.85,
  evidenceGrade: 0.8,
  adversarialSurvival: 0.9,
  verticalFit: 0.8,
  corroboration: 0.6,
};

describe("gauntletVerdict — multiplicative composite", () => {
  it("multiplies all five layers", () => {
    const v = gauntletVerdict(strong);
    expect(v.value).toBeCloseTo(0.85 * 0.8 * 0.9 * 0.8 * 0.6, 3);
    expect(v.dead).toBe(false);
    expect(v.killedBy).toBeNull();
  });

  it("ANY layer below the kill floor kills the claim + names the killer", () => {
    const v = gauntletVerdict({ ...strong, verticalFit: 0.02 });
    expect(v.dead).toBe(true);
    expect(v.killedBy).toBe("verticalFit");
  });

  it("names the FIRST below-floor layer in cheap-first order", () => {
    const v = gauntletVerdict({ ...strong, evidenceGrade: 0.01, verticalFit: 0.01 });
    expect(v.killedBy).toBe("evidenceGrade");
  });

  it("a missing layer is treated as zero (fail-closed)", () => {
    const v = gauntletVerdict({ credibility: 0.8 });
    expect(v.dead).toBe(true);
  });
});

describe("priorConfidence — capped at PROJECTION", () => {
  it("caps a strong composite at the PROJECTION ceiling", () => {
    expect(priorConfidence({ value: 0.5, dead: false, killedBy: null })).toBe(PROJECTION_CEILING);
  });
  it("passes a weak composite through (below the ceiling)", () => {
    expect(priorConfidence({ value: 0.12, dead: false, killedBy: null })).toBe(0.12);
  });
  it("a dead claim has zero confidence", () => {
    expect(priorConfidence({ value: 0.3, dead: true, killedBy: "evidenceGrade" })).toBe(0);
  });
});

describe("decayedConfidence — half-life", () => {
  it("halves confidence after exactly one half-life", () => {
    const hl = halfLifeDays("storm_tactic");
    expect(decayedConfidence({ confidence: 0.2, claimType: "storm_tactic", ageDays: hl })).toBeCloseTo(0.1, 3);
  });
  it("storm tactics rot far faster than buyer psychology", () => {
    expect(halfLifeDays("storm_tactic")).toBeLessThan(halfLifeDays("buyer_psychology"));
  });
  it("KILL_FLOOR + PROJECTION_CEILING are the documented bounds", () => {
    expect(KILL_FLOOR).toBe(0.05);
    expect(PROJECTION_CEILING).toBe(0.25);
  });
});
