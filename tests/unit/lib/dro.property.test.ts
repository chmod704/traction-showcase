/**
 * Property-based tests for src/lib/dro.ts — Wasserstein-DRO budget/auction
 * recommendations under uncertainty.
 *
 * SIGN CONVENTION (load-bearing — read before editing):
 *   robustOptimize MINIMIZES a *loss*. Its robust objective is the dual
 *   (Esfahani & Kuhn 2018):
 *       robust_loss(θ) = (1/N) Σ loss(θ, x_i)  +  ε · L
 *   so the robust loss is an UPPER BOUND on the empirical loss and is
 *   MONOTONE NON-DECREASING in the ambiguity radius ε. In utility/"value"
 *   terms (value = −loss) this is exactly the textbook statement that the
 *   robust VALUE ≤ expected value and is monotone NON-INCREASING in ε. Same
 *   theorem, dual sign. We assert it on the loss the code actually returns.
 *
 * The invariants:
 *   1. loss_at_robust ≥ loss_at_empirical for every ε ≥ 0  (robustness costs).
 *   2. loss_at_robust is monotone non-decreasing in ε.
 *   3. At ε = 0 the robust optimum coincides with the empirical optimum and
 *      the two losses are equal.
 *   4. robustShift moves strictly toward the conservative side by ε·step.
 */

import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/supabase", () => ({ supabase: { from: vi.fn() } }));
vi.mock("@/lib/env", () => ({ env: {} }));

import { robustOptimize, robustShift, Losses } from "@/lib/dro";

/** A finite, bounded sample vector — no NaN/Inf so the grid search is sane. */
const sampleArb = fc.array(fc.double({ min: -500, max: 500, noNaN: true }), {
  minLength: 1,
  maxLength: 80,
});

describe("dro — robustness is never free: robust loss ≥ empirical loss", () => {
  it("loss_at_robust ≥ loss_at_empirical for any ε ≥ 0 (squared error)", () => {
    fc.assert(
      fc.property(
        sampleArb,
        fc.double({ min: 0, max: 100, noNaN: true }), // radius ε
        fc.double({ min: 0.1, max: 5, noNaN: true }), // lipschitzInX
        (samples, radius, lipsch) => {
          const r = robustOptimize({
            loss: Losses.squaredError(),
            samples,
            radius,
            thetaLow: -600,
            thetaHigh: 600,
            thetaSteps: 120,
            lipschitzInX: lipsch,
          });
          expect(r.loss_at_robust).toBeGreaterThanOrEqual(r.loss_at_empirical - 1e-9);
        },
      ),
      { numRuns: 250 },
    );
  });

  it("holds for the one-sided excess loss too", () => {
    fc.assert(
      fc.property(
        sampleArb,
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: -100, max: 100, noNaN: true }), // target
        (samples, radius, target) => {
          const r = robustOptimize({
            loss: Losses.oneSidedExcess(target),
            samples,
            radius,
            thetaLow: -200,
            thetaHigh: 200,
            thetaSteps: 100,
          });
          expect(r.loss_at_robust).toBeGreaterThanOrEqual(r.loss_at_empirical - 1e-9);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("dro — robust loss is monotone NON-DECREASING in the ambiguity radius ε", () => {
  it("increasing ε never lowers loss_at_robust (squared error)", () => {
    fc.assert(
      fc.property(
        sampleArb,
        fc.double({ min: 0, max: 50, noNaN: true }), // eps1
        fc.double({ min: 0, max: 50, noNaN: true }), // eps2
        fc.double({ min: 0.5, max: 3, noNaN: true }), // lipsch
        (samples, e1, e2, lipsch) => {
          const epsLow = Math.min(e1, e2);
          const epsHigh = Math.max(e1, e2);
          const common = {
            loss: Losses.squaredError(),
            samples,
            thetaLow: -600,
            thetaHigh: 600,
            thetaSteps: 100,
            lipschitzInX: lipsch,
          };
          const lo = robustOptimize({ ...common, radius: epsLow });
          const hi = robustOptimize({ ...common, radius: epsHigh });
          // Larger ambiguity ⇒ at least as conservative ⇒ at least as much loss.
          expect(hi.loss_at_robust).toBeGreaterThanOrEqual(lo.loss_at_robust - 1e-9);
        },
      ),
      { numRuns: 250 },
    );
  });

  it("the radius gap equals exactly ε·L (the dual regularizer)", () => {
    // The empirical optimum is invariant to ε (ε·L is an additive constant over
    // the same θ-grid), so the robust − empirical gap is exactly ε·L.
    fc.assert(
      fc.property(
        sampleArb,
        fc.double({ min: 0, max: 40, noNaN: true }),
        fc.double({ min: 0.25, max: 4, noNaN: true }),
        (samples, radius, lipsch) => {
          const r = robustOptimize({
            loss: Losses.squaredError(),
            samples,
            radius,
            thetaLow: -600,
            thetaHigh: 600,
            thetaSteps: 100,
            lipschitzInX: lipsch,
          });
          // robust loss − empirical loss == ε·L, and the argmin is unchanged.
          expect(r.loss_at_robust - r.loss_at_empirical).toBeCloseTo(radius * lipsch, 6);
          expect(r.robust_optimum).toBeCloseTo(r.empirical_optimum, 9);
        },
      ),
      { numRuns: 250 },
    );
  });
});

describe("dro — at ε = 0 robust collapses to empirical", () => {
  it("zero radius ⇒ identical optimum and identical loss", () => {
    fc.assert(
      fc.property(sampleArb, fc.double({ min: 0.1, max: 5, noNaN: true }), (samples, lipsch) => {
        const r = robustOptimize({
          loss: Losses.squaredError(),
          samples,
          radius: 0,
          thetaLow: -600,
          thetaHigh: 600,
          thetaSteps: 100,
          lipschitzInX: lipsch,
        });
        expect(r.robust_optimum).toBe(r.empirical_optimum);
        expect(r.loss_at_robust).toBeCloseTo(r.loss_at_empirical, 9);
        expect(r.conservativeness).toBe(0);
      }),
      { numRuns: 150 },
    );
  });
});

describe("dro — robustShift moves toward the conservative side by ε·step", () => {
  it("direction=down subtracts ε·step; direction=up adds it", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e4, max: 1e4, noNaN: true }), // empirical_optimum
        fc.double({ min: 0, max: 100, noNaN: true }), // radius
        fc.double({ min: 0, max: 100, noNaN: true }), // step
        (emp, radius, step) => {
          const down = robustShift({ empirical_optimum: emp, radius, direction: "down", step });
          const up = robustShift({ empirical_optimum: emp, radius, direction: "up", step });
          expect(down).toBeCloseTo(emp - radius * step, 6);
          expect(up).toBeCloseTo(emp + radius * step, 6);
          // Conservative ("down") is always ≤ the empirical optimum.
          expect(down).toBeLessThanOrEqual(emp + 1e-9);
          expect(up).toBeGreaterThanOrEqual(emp - 1e-9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a larger radius shifts strictly further from the empirical optimum", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0.01, max: 20, noNaN: true }), // positive step
        (emp, r1, r2, step) => {
          const rLow = Math.min(r1, r2);
          const rHigh = Math.max(r1, r2);
          const distLow = Math.abs(robustShift({ empirical_optimum: emp, radius: rLow, direction: "down", step }) - emp);
          const distHigh = Math.abs(robustShift({ empirical_optimum: emp, radius: rHigh, direction: "down", step }) - emp);
          expect(distHigh).toBeGreaterThanOrEqual(distLow - 1e-9);
        },
      ),
      { numRuns: 250 },
    );
  });
});

describe("dro — empty / degenerate inputs", () => {
  it("empty sample set returns a safe zero-loss result pinned to thetaLow", () => {
    const r = robustOptimize({
      loss: Losses.squaredError(),
      samples: [],
      radius: 5,
      thetaLow: 10,
      thetaHigh: 100,
    });
    expect(r.robust_optimum).toBe(10);
    expect(r.empirical_optimum).toBe(10);
    expect(r.loss_at_robust).toBe(0);
    expect(r.loss_at_empirical).toBe(0);
    expect(r.conservativeness).toBe(0);
  });

  it("conservativeness is always ≥ 0 and finite for valid inputs", () => {
    fc.assert(
      fc.property(sampleArb, fc.double({ min: 0, max: 30, noNaN: true }), (samples, radius) => {
        const r = robustOptimize({
          loss: Losses.biTarget(0, 1, 1),
          samples,
          radius,
          thetaLow: -600,
          thetaHigh: 600,
          thetaSteps: 80,
        });
        expect(Number.isFinite(r.conservativeness)).toBe(true);
        expect(r.conservativeness).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });
});
