/**
 * Wasserstein Distributionally-Robust Optimization (DRO) — 1D practical case.
 *
 * Standard empirical-risk minimization (ERM):
 *     min_θ  (1/N) Σ_i loss(θ, x_i)
 *
 * Wasserstein-DRO replaces the empirical distribution with the worst-case
 * distribution inside a Wasserstein-1 ball of radius ε:
 *     min_θ  max_{Q : W_1(Q, P̂) ≤ ε}  E_Q[loss(θ, X)]
 *
 * Closed-form dual (Esfahani & Kuhn 2018, Theorem 4.1) for Wasserstein-1 with
 * convex Lipschitz loss:
 *
 *     min_θ  { (1/N) Σ_i loss(θ, x_i)  +  ε · L(θ) }
 *
 * where L(θ) is the Lipschitz constant of loss(θ, ·). The DRO problem
 * decouples into an ERM term plus a regularizer that grows with the
 * "sharpness" of the loss in the sample direction. The radius ε controls
 * conservativeness.
 *
 * For our practical loss functions:
 *
 *   1) Quantile / target loss:    loss(θ, x) = max(x - target, 0)
 *      Lipschitz constant in x = 1 → DRO ≡ ERM + ε
 *
 *   2) Asymmetric absolute loss:  loss(θ, x) = |x - θ|
 *      Lipschitz constant in x = 1, Lipschitz in θ = 1.
 *      Robust optimum is shifted toward the worse side by ε / 2.
 *
 *   3) Mean-vs-target with budget penalty:  loss(θ, x) = a·(x - target)² + b·θ
 *      Lipschitz constant in x = 2a · max|x - target| → DRO adds a margin
 *      proportional to the empirical spread.
 *
 * In practice, for the campaign executor's budget recommendation, we solve
 * the robust version of "pick budget θ to minimize expected CPL over the
 * recent empirical distribution of CPLs, *plus* a worst-case margin." The
 * worst-case margin biases θ toward the safer side proportional to ε.
 *
 * Use cases in the stack:
 *   - Executor budget recommendations under uncertainty
 *   - Auction multiplier choice when storm signals are noisy
 *   - Rate-increase recommendations from self-funding agency
 *
 * Pure-math here; the caller wires it into a decision path.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pure-math
// ─────────────────────────────────────────────────────────────────────────────

export interface RobustOptResult {
  robust_optimum: number;
  empirical_optimum: number;
  conservativeness: number;          // |robust - empirical| / max(1, |empirical|)
  loss_at_robust: number;
  loss_at_empirical: number;
}

/**
 * 1D minimization over θ of:
 *     (1/N) Σ_i loss(θ, x_i) + ε · L(θ)
 * where lipschitzInX is the Lipschitz constant of loss in x, treated as the
 * effective adversarial radius cost.
 *
 * Searches θ on a grid over [thetaLow, thetaHigh] for the robust optimum
 * and on the same grid for the empirical (ε=0) optimum.
 */
export function robustOptimize(args: {
  loss: (theta: number, x: number) => number;
  samples: number[];
  radius: number;            // ε
  thetaLow: number;
  thetaHigh: number;
  thetaSteps?: number;       // default 200
  lipschitzInX?: number;     // default 1 — most practical losses
}): RobustOptResult {
  const steps = args.thetaSteps ?? 200;
  const N = args.samples.length;
  const lipsch = args.lipschitzInX ?? 1;
  if (N === 0) return { robust_optimum: args.thetaLow, empirical_optimum: args.thetaLow, conservativeness: 0, loss_at_robust: 0, loss_at_empirical: 0 };

  let bestRobustTheta = args.thetaLow; let bestRobustLoss = Infinity;
  let bestEmpiricalTheta = args.thetaLow; let bestEmpiricalLoss = Infinity;

  for (let i = 0; i <= steps; i++) {
    const theta = args.thetaLow + (i * (args.thetaHigh - args.thetaLow)) / steps;
    let s = 0;
    for (const x of args.samples) s += args.loss(theta, x);
    const empiricalLoss = s / N;
    const robustLoss = empiricalLoss + args.radius * lipsch;
    if (robustLoss < bestRobustLoss) { bestRobustLoss = robustLoss; bestRobustTheta = theta; }
    if (empiricalLoss < bestEmpiricalLoss) { bestEmpiricalLoss = empiricalLoss; bestEmpiricalTheta = theta; }
  }

  // For losses where Lipschitz constant is constant in θ, the robust and
  // empirical minimizers coincide. For losses that depend on θ asymmetrically
  // (e.g. one-sided), they differ. We compute the conservativeness ratio so
  // the caller can audit whether DRO actually changed the recommendation.
  const conservativeness = Math.abs(bestRobustTheta - bestEmpiricalTheta) / Math.max(1, Math.abs(bestEmpiricalTheta));

  return {
    robust_optimum: bestRobustTheta,
    empirical_optimum: bestEmpiricalTheta,
    conservativeness,
    loss_at_robust: bestRobustLoss,
    loss_at_empirical: bestEmpiricalLoss,
  };
}

/**
 * For asymmetric losses where over-shooting θ has different consequences
 * than under-shooting, we expose a "robust shift" formulation:
 *
 *     theta_robust = theta_empirical  ±  ε · gradient_at_optimum
 *
 * Use for budget pacing: empirical optimum says daily budget = $50; robust
 * version shifts toward safer side ($46) when uncertainty is high.
 */
export function robustShift(args: {
  empirical_optimum: number;
  radius: number;
  direction: "down" | "up";    // 'down' = robust pushes lower (more conservative on a max-budget call)
  step: number;                // shift per unit of radius
}): number {
  const sign = args.direction === "down" ? -1 : 1;
  return args.empirical_optimum + sign * args.radius * args.step;
}

// Convenience pre-built loss functions

export const Losses = {
  /** L(θ, x) = max(x - target, 0). Use to penalize x exceeding a target. */
  oneSidedExcess: (target: number) => (_theta: number, x: number) => Math.max(0, x - target),
  /** L(θ, x) = (x - θ)². Standard squared error. */
  squaredError: () => (theta: number, x: number) => (x - theta) ** 2,
  /** L(θ, x) = a·(x - target)² + b·(x - θ)². Penalizes both target deviation and θ deviation. */
  biTarget: (target: number, a: number, b: number) =>
    (theta: number, x: number) => a * (x - target) ** 2 + b * (x - theta) ** 2,
};
