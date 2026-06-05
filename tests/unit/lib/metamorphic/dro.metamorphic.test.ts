/**
 * METAMORPHIC tests for src/lib/dro.ts — Wasserstein-DRO budget/auction
 * recommendations under uncertainty.
 *
 * SIGN CONVENTION (load-bearing — read before editing): robustOptimize
 * MINIMIZES a loss. Its robust objective is the Esfahani & Kuhn (2018) dual
 *     robust_loss(θ) = (1/N) Σ loss(θ, x_i) + ε·L
 * so the robust LOSS is an upper bound on the empirical loss and is monotone
 * NON-DECREASING in the ambiguity radius ε (more pessimism). In value terms
 * (value = −loss) the robust VALUE is non-increasing in ε — same theorem, dual
 * sign. We assert on the loss the code actually returns.
 *
 * The metamorphic relations (relations between RELATED calls, not single-call
 * invariants):
 *
 *   MR1 — RADIUS MONOTONICITY (more pessimism): increasing ε weakly WORSENS
 *         (raises) the robust objective. Asserted as an ordered pair on the
 *         same sample/loss, sweeping ε.
 *
 *   MR2 — RADIUS-0 == NOMINAL: at ε = 0 the robust objective and optimum equal
 *         the empirical (non-robust) objective and optimum exactly.
 *
 *   MR3 — PERMUTATION INVARIANCE (relabeling equally-weighted scenarios): the
 *         empirical mean loss is invariant to the ORDER of the samples, so a
 *         shuffled sample set yields the same robust optimum, empirical optimum,
 *         and both losses.
 *
 *   MR4 — DUPLICATION INVARIANCE (replicating every scenario k× keeps weights
 *         equal): tiling the sample list k times leaves the (uniformly-weighted)
 *         empirical mean — and thus every output — unchanged.
 *
 *   MR5 — LIPSCHITZ-CONSTANT LINEARITY: the robust−empirical gap is exactly
 *         ε·L, so scaling L by c scales the gap by c (the argmin is unchanged
 *         for a θ-constant regularizer).
 *
 *   MR6 — robustShift ADDITIVITY/EQUIVARIANCE: shifting the empirical optimum
 *         by δ shifts the robust-shifted output by the same δ; and the two
 *         directions are reflections about the empirical optimum.
 *
 * fast-check + a seeded mulberry32 shuffle keep every relation deterministic.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/lib/env", () => ({ env: {} }));

import { robustOptimize, robustShift, Losses, type RobustOptResult } from "@/lib/dro";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Fisher-Yates shuffle with a seeded RNG. */
function shuffle<T>(xs: T[], rng: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const sampleArb = fc.array(fc.double({ min: -400, max: 400, noNaN: true }), { minLength: 1, maxLength: 60 });

const COMMON = { thetaLow: -600, thetaHigh: 600, thetaSteps: 100 } as const;

describe("dro METAMORPHIC — MR1 radius monotonicity (more ambiguity ⇒ at least as pessimistic)", () => {
  it("a strictly larger ε never lowers the robust objective", () => {
    fc.assert(
      fc.property(
        sampleArb,
        fc.double({ min: 0, max: 40, noNaN: true }), // ε base
        fc.double({ min: 0, max: 40, noNaN: true }), // ε bump
        fc.double({ min: 0.25, max: 4, noNaN: true }), // L
        (samples, e0, bump, lipsch) => {
          const common = { loss: Losses.squaredError(), samples, lipschitzInX: lipsch, ...COMMON };
          const lo = robustOptimize({ ...common, radius: e0 });
          const hi = robustOptimize({ ...common, radius: e0 + bump });
          expect(hi.loss_at_robust).toBeGreaterThanOrEqual(lo.loss_at_robust - 1e-9);
        },
      ),
      { numRuns: 250 },
    );
  });

  it("the robust objective sweeps monotonically across an increasing ε ladder", () => {
    fc.assert(
      fc.property(sampleArb, fc.double({ min: 0.5, max: 3, noNaN: true }), (samples, lipsch) => {
        const ladder = [0, 1, 2, 5, 10, 25];
        let prev = -Infinity;
        for (const radius of ladder) {
          const r = robustOptimize({ loss: Losses.squaredError(), samples, radius, lipschitzInX: lipsch, ...COMMON });
          expect(r.loss_at_robust).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = r.loss_at_robust;
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe("dro METAMORPHIC — MR2 radius 0 equals the nominal (non-robust) problem", () => {
  it("ε = 0 ⇒ robust optimum & loss equal the empirical optimum & loss", () => {
    fc.assert(
      fc.property(sampleArb, fc.double({ min: 0.1, max: 5, noNaN: true }), (samples, lipsch) => {
        const r = robustOptimize({ loss: Losses.squaredError(), samples, radius: 0, lipschitzInX: lipsch, ...COMMON });
        expect(r.robust_optimum).toBe(r.empirical_optimum);
        expect(r.loss_at_robust).toBeCloseTo(r.loss_at_empirical, 9);
        expect(r.conservativeness).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});

describe("dro METAMORPHIC — MR3 permutation invariance (relabeling equally-weighted scenarios)", () => {
  it("shuffling the sample order leaves every output identical", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }), // shuffle seed
        fc.array(fc.double({ min: -400, max: 400, noNaN: true }), { minLength: 2, maxLength: 60 }),
        fc.double({ min: 0, max: 30, noNaN: true }),
        fc.double({ min: 0.25, max: 4, noNaN: true }),
        (seed, samples, radius, lipsch) => {
          const reordered = shuffle(samples, mulberry32(seed));
          const a = robustOptimize({ loss: Losses.squaredError(), samples, radius, lipschitzInX: lipsch, ...COMMON });
          const b = robustOptimize({ loss: Losses.squaredError(), samples: reordered, radius, lipschitzInX: lipsch, ...COMMON });
          // The uniform empirical mean is permutation-symmetric.
          expect(b.empirical_optimum).toBe(a.empirical_optimum);
          expect(b.robust_optimum).toBe(a.robust_optimum);
          expect(b.loss_at_empirical).toBeCloseTo(a.loss_at_empirical, 9);
          expect(b.loss_at_robust).toBeCloseTo(a.loss_at_robust, 9);
        },
      ),
      { numRuns: 250 },
    );
  });
});

describe("dro METAMORPHIC — MR4 duplication invariance (equal-weight replication)", () => {
  it("tiling every scenario k× leaves the uniformly-weighted objective unchanged", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -200, max: 200, noNaN: true }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 2, max: 5 }), // replication factor k
        fc.double({ min: 0, max: 20, noNaN: true }),
        fc.double({ min: 0.5, max: 3, noNaN: true }),
        (samples, k, radius, lipsch) => {
          const tiled: number[] = [];
          for (let i = 0; i < k; i++) tiled.push(...samples);
          const common = { loss: Losses.squaredError(), radius, lipschitzInX: lipsch, ...COMMON };
          const base = robustOptimize({ ...common, samples });
          const dup = robustOptimize({ ...common, samples: tiled });
          // Mean over k identical copies == mean over one copy.
          expect(dup.empirical_optimum).toBe(base.empirical_optimum);
          expect(dup.robust_optimum).toBe(base.robust_optimum);
          expect(dup.loss_at_empirical).toBeCloseTo(base.loss_at_empirical, 8);
          expect(dup.loss_at_robust).toBeCloseTo(base.loss_at_robust, 8);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("dro METAMORPHIC — MR5 Lipschitz-constant linearity of the robustness gap", () => {
  it("scaling L by c scales the robust−empirical gap by c (argmin unchanged)", () => {
    fc.assert(
      fc.property(
        sampleArb,
        fc.double({ min: 0.01, max: 30, noNaN: true }), // ε
        fc.double({ min: 0.25, max: 3, noNaN: true }), // base L
        fc.double({ min: 1.1, max: 5, noNaN: true }), // multiplier c
        (samples, radius, lipsch, c) => {
          const common = { loss: Losses.squaredError(), samples, radius, ...COMMON };
          const base = robustOptimize({ ...common, lipschitzInX: lipsch });
          const scaled = robustOptimize({ ...common, lipschitzInX: lipsch * c });
          const gapBase = base.loss_at_robust - base.loss_at_empirical; // == ε·L
          const gapScaled = scaled.loss_at_robust - scaled.loss_at_empirical; // == ε·L·c
          expect(gapScaled).toBeCloseTo(c * gapBase, 5);
          // The regularizer is θ-constant ⇒ the argmin does not move with L.
          expect(scaled.empirical_optimum).toBe(base.empirical_optimum);
          expect(scaled.robust_optimum).toBe(base.robust_optimum);
        },
      ),
      { numRuns: 250 },
    );
  });
});

describe("dro METAMORPHIC — MR6 robustShift equivariance & reflection", () => {
  it("shifting the empirical optimum by δ shifts the output by δ (both directions)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e4, max: 1e4, noNaN: true }), // emp
        fc.double({ min: -1e4, max: 1e4, noNaN: true }), // δ
        fc.double({ min: 0, max: 50, noNaN: true }), // radius
        fc.double({ min: 0, max: 50, noNaN: true }), // step
        fc.constantFrom("up" as const, "down" as const),
        (emp, delta, radius, step, direction) => {
          const a = robustShift({ empirical_optimum: emp, radius, direction, step });
          const b = robustShift({ empirical_optimum: emp + delta, radius, direction, step });
          expect(b - a).toBeCloseTo(delta, 5);
        },
      ),
      { numRuns: 250 },
    );
  });

  it("up and down are mirror images about the empirical optimum (symmetry)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (emp, radius, step) => {
          const down = robustShift({ empirical_optimum: emp, radius, direction: "down", step });
          const up = robustShift({ empirical_optimum: emp, radius, direction: "up", step });
          // (up + down)/2 == emp ⇒ the two shifts are symmetric about emp.
          expect((up + down) / 2).toBeCloseTo(emp, 5);
        },
      ),
      { numRuns: 250 },
    );
  });
});
