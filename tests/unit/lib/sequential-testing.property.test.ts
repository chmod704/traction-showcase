/**
 * Property-based tests for src/lib/sequential-testing.ts — the mSPRT /
 * always-valid p-value engine that lets the executor peek-and-stop A/B tests
 * without inflating the false-positive rate.
 *
 * THE invariant that makes "always-valid" mean anything:
 *
 *   Under H0, the e-value process (e_t) is a non-negative supermartingale with
 *   E[e_0] = 1. By Ville's inequality, for ANY stopping time τ (including the
 *   adversarially-chosen "stop the instant it looks significant"):
 *
 *       P( sup_t e_t ≥ 1/α )  ≤  α
 *
 *   i.e. the probability of EVER falsely rejecting H0 across the whole stream
 *   is bounded by α — no matter how many times you peek. We verify this
 *   empirically: simulate many H0 trajectories, run the full batch test (which
 *   records a rejection if the threshold is crossed at any point), and assert
 *   the observed false-rejection rate stays within a small multiple of α.
 *
 * fast-check drives the simulation seed and the (p0, α, stream length) shape so
 * the type-I control is checked across many configurations, not one.
 *
 * ⚠️ MEASURED DEFECT (see missingOrNeeded in the handoff): the Bernoulli
 * implementation plugs the EMPIRICAL second moment (sumDiffSq) into the mixture
 * variance instead of the theoretical n·p0(1-p0). At a SYMMETRIC null p0=0.5
 * every (x-p0)² == 0.25 so sumDiffSq == n·p0(1-p0) exactly and the e-value is
 * well-calibrated. AWAY from symmetry the empirical second moment understates
 * the H0 variance, inflating the e-value and the type-I rate — measured FPR
 * climbs to ~0.27 at p0=0.2 and ~0.75 at p0=0.05 (vs nominal 0.05). So:
 *
 *   - We assert TRUE Ville-bound control (≤ 3·α) ONLY in the band p0∈[0.4,0.6]
 *     where the plug-in is approximately valid (measured worst-case 0.072 at
 *     α=0.05, 0.172 at α=0.1 — comfortably inside 3·α).
 *   - We then PIN the asymmetric-p0 inflation as a known, documented defect, so
 *     a regression that makes it worse fails AND a future fix that restores
 *     control is detected (the pinned test will start over-passing → revisit).
 *
 * The Normal test uses the exact closed form and IS controlled at all (mu0,σ²);
 * it is held to a tighter 2× band.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/lib/env", () => ({ env: {} }));

import {
  runBernoulliTest,
  runNormalTest,
  newSequentialState,
  stepBernoulli,
  stepNormal,
} from "@/lib/sequential-testing";

// splitmix32 — deterministic, seedable, decoupled from Math.random.
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return ((z ^ (z >>> 16)) >>> 0) / 4294967295;
  };
}
function gauss(draw: () => number): number {
  const u1 = draw() || 1e-9;
  const u2 = draw();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

describe("sequential-testing — Bernoulli mSPRT type-I error is controlled under H0 (symmetric band)", () => {
  it("false-rejection rate over many H0 streams stays ≤ 3·α for p0∈[0.4,0.6]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }), // master seed
        fc.constantFrom(0.4, 0.45, 0.5, 0.55, 0.6), // p0 in the well-calibrated band
        fc.constantFrom(0.05, 0.1), // α
        (masterSeed, p0, alpha) => {
          const TRIALS = 300;
          const STREAM = 250;
          let falseRejects = 0;
          for (let t = 0; t < TRIALS; t++) {
            const draw = rng(masterSeed * 7919 + t * 104729 + 1);
            const obs: (0 | 1)[] = [];
            for (let i = 0; i < STREAM; i++) obs.push(draw() < p0 ? 1 : 0);
            // Data drawn at exactly p0 ⇒ H0 is TRUE.
            const r = runBernoulliTest(obs, { p0, alpha });
            if (r.rejected) falseRejects++;
          }
          const fpr = falseRejects / TRIALS;
          expect(fpr).toBeLessThanOrEqual(3 * alpha);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("at p0=0.5 (the exactly-calibrated point) FPR is genuinely near nominal", () => {
    // Symmetric null ⇒ sumDiffSq == n·p0(1-p0) exactly ⇒ correct e-value.
    const TRIALS = 1200;
    const STREAM = 250;
    let falseRejects = 0;
    for (let t = 0; t < TRIALS; t++) {
      const draw = rng(t * 2246822519 + 17);
      const obs: (0 | 1)[] = [];
      for (let i = 0; i < STREAM; i++) obs.push(draw() < 0.5 ? 1 : 0);
      if (runBernoulliTest(obs, { p0: 0.5, alpha: 0.05 }).rejected) falseRejects++;
    }
    // Ville bound is 0.05; the empirical-variance plug-in adds a hair of slack.
    expect(falseRejects / TRIALS).toBeLessThanOrEqual(0.08);
  });
});

describe("sequential-testing — DOCUMENTED DEFECT: Bernoulli type-I inflates at asymmetric p0", () => {
  // This is a regression-pin, NOT a passing invariant. The empirical-variance
  // plug-in (V_t = Σ(x-p0)²) understates the H0 variance away from p0=0.5,
  // inflating the e-value. Measured FPR ≈ 0.27 at p0=0.2 and ≈ 0.75 at p0=0.05
  // (nominal α=0.05). We pin it so:
  //   (a) a regression that makes calibration WORSE (FPR > the ceiling) fails;
  //   (b) when the source is fixed (use n·p0(1-p0), canonical log-e), the FPR
  //       drops below the lower-bound here and this test starts failing on the
  //       LOWER assertion — a deliberate tripwire that says "defect fixed,
  //       tighten the real type-I test to cover all p0 and delete this pin."
  // See missingOrNeeded for the exact one-line source fix.
  it("p0=0.05 currently rejects under H0 far above nominal (inflation is real)", () => {
    const TRIALS = 1000;
    const STREAM = 250;
    let falseRejects = 0;
    for (let t = 0; t < TRIALS; t++) {
      const draw = rng(t * 40503 + 3);
      const obs: (0 | 1)[] = [];
      for (let i = 0; i < STREAM; i++) obs.push(draw() < 0.05 ? 1 : 0);
      if (runBernoulliTest(obs, { p0: 0.05, alpha: 0.05 }).rejected) falseRejects++;
    }
    const fpr = falseRejects / TRIALS;
    // Inflation is large and real: well above nominal, below total breakdown.
    expect(fpr).toBeGreaterThan(0.3); // TRIPWIRE: a source fix drops this → revisit
    expect(fpr).toBeLessThanOrEqual(0.95); // regression guard: don't get worse
  });
});

describe("sequential-testing — Normal mSPRT type-I error is controlled under H0", () => {
  it("false-rejection rate over many H0 streams stays ≤ 2·α (exact closed form)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.constantFrom(0, 50, 100), // mu0 (and the TRUE mean — H0 holds)
        fc.constantFrom(1, 9, 25), // sigma^2
        fc.constantFrom(0.05, 0.1), // α
        (masterSeed, mu0, sigmaSq, alpha) => {
          const TRIALS = 250;
          const STREAM = 200;
          const sigma = Math.sqrt(sigmaSq);
          let falseRejects = 0;
          for (let t = 0; t < TRIALS; t++) {
            const draw = rng(masterSeed * 6271 + t * 99991 + 3);
            const obs: number[] = [];
            for (let i = 0; i < STREAM; i++) obs.push(mu0 + sigma * gauss(draw));
            const r = runNormalTest(obs, { mu0, sigmaSq, alpha, mixtureVariance: 1.0 });
            if (r.rejected) falseRejects++;
          }
          const fpr = falseRejects / TRIALS;
          expect(fpr).toBeLessThanOrEqual(2 * alpha);
        },
      ),
      { numRuns: 30 },
    );
  });
});

describe("sequential-testing — power: a real, large effect is eventually detected", () => {
  it("Normal stream with a strong shift away from mu0 rejects with high probability", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.constantFrom(1, 4), // sigma^2 (small ⇒ strong signal)
        (masterSeed, sigmaSq) => {
          const TRIALS = 60;
          const STREAM = 300;
          const sigma = Math.sqrt(sigmaSq);
          const mu0 = 100;
          const trueMu = mu0 + 8 * sigma; // 8σ shift — overwhelming
          let rejects = 0;
          for (let t = 0; t < TRIALS; t++) {
            const draw = rng(masterSeed * 433 + t * 60013 + 5);
            const obs: number[] = [];
            for (let i = 0; i < STREAM; i++) obs.push(trueMu + sigma * gauss(draw));
            const r = runNormalTest(obs, { mu0, sigmaSq, alpha: 0.05, mixtureVariance: 10.0 });
            if (r.rejected) rejects++;
          }
          // A true 8σ effect over 300 obs must be caught essentially always.
          expect(rejects / TRIALS).toBeGreaterThanOrEqual(0.95);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("sequential-testing — always-valid p-value structural invariants", () => {
  it("p-value is in (0,1], e-value ≥ 0, and p ≈ 1/e at every step (Bernoulli)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }), // p0
        fc.double({ min: 0, max: 1, noNaN: true }), // true rate
        (seed, p0, trueRate) => {
          const draw = rng(seed);
          let s = newSequentialState();
          for (let i = 0; i < 120; i++) {
            const x: 0 | 1 = draw() < trueRate ? 1 : 0;
            const r = stepBernoulli(s, x, { p0 });
            s = r.state;
            expect(r.pValueAlwaysValid).toBeGreaterThan(0);
            expect(r.pValueAlwaysValid).toBeLessThanOrEqual(1);
            expect(r.eValue).toBeGreaterThanOrEqual(0);
            // p = min(1, 1/e) — verify the relationship the engine promises.
            const expectedP = Math.min(1, 1 / Math.max(1e-300, r.eValue));
            expect(r.pValueAlwaysValid).toBeCloseTo(expectedP, 9);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejected/futile flags are sticky — once set they never flip back (Normal)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.double({ min: -50, max: 50, noNaN: true }), // mu0
        fc.double({ min: 0.5, max: 20, noNaN: true }), // sigma^2
        (seed, mu0, sigmaSq) => {
          const draw = rng(seed);
          const sigma = Math.sqrt(sigmaSq);
          // Mix of null-ish and strongly-shifted observations to exercise toggling.
          let s = newSequentialState();
          let everRejected = false;
          let everFutile = false;
          for (let i = 0; i < 150; i++) {
            const shifted = i > 75; // flip to a big effect halfway through
            const x = (shifted ? mu0 + 6 * sigma : mu0) + sigma * gauss(draw);
            const r = stepNormal(s, x, { mu0, sigmaSq, alpha: 0.05, mixtureVariance: 5.0, futilityFloor: 1e-6 });
            s = r.state;
            if (s.rejected) everRejected = true;
            if (s.futile) everFutile = true;
            // Stickiness: a set flag stays set.
            if (everRejected) expect(s.rejected).toBe(true);
            if (everFutile) expect(s.futile).toBe(true);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe("sequential-testing — batch runner accounting", () => {
  it("totalObservations == stream length and stoppingPoint is within bounds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 200 }),
        (seed, len) => {
          const draw = rng(seed);
          const obs: (0 | 1)[] = Array.from({ length: len }, () => (draw() < 0.5 ? 1 : 0));
          const r = runBernoulliTest(obs, { p0: 0.5 });
          expect(r.totalObservations).toBe(len);
          if (r.stoppingPoint != null) {
            expect(r.stoppingPoint).toBeGreaterThanOrEqual(1);
            expect(r.stoppingPoint).toBeLessThanOrEqual(len);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("sequential-testing — invalid config throws", () => {
  it("rejects p0 outside (0,1) and non-positive sigmaSq", () => {
    expect(() => stepBernoulli(newSequentialState(), 1, { p0: 0 })).toThrow();
    expect(() => stepBernoulli(newSequentialState(), 0, { p0: 1 })).toThrow();
    expect(() => stepNormal(newSequentialState(), 1, { mu0: 0, sigmaSq: 0 })).toThrow();
    expect(() => stepNormal(newSequentialState(), 1, { mu0: 0, sigmaSq: -2 })).toThrow();
  });
});
