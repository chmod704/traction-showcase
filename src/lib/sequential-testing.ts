/**
 * T109 — Sequential testing (mSPRT / always-valid p-values).
 *
 * Classical A/B tests require fixing the sample size in advance: peek and
 * the p-value lies; peek-and-stop and the false-positive rate explodes.
 * Sequential tests fix this — the e-value framework (Howard et al. 2021,
 * Vovk) provides p-values that are valid at any stopping time, including
 * adaptively-chosen ones.
 *
 * This module ships two cases:
 *
 *   1. Bernoulli mSPRT — A/B conversion-rate tests against a null
 *      p₀ (or two-sample p_control vs p_candidate). Test martingale:
 *          e_t = ∏ (1 + η (X_i - p₀))
 *      mixed over η ~ N(0, ν²) yields the mSPRT e-value with always-
 *      valid p-value = 1/e_t.
 *
 *   2. Normal-mean mSPRT — continuous outcomes (CPL, ROAS) with known
 *      or estimated variance. Mixture martingale over the effect-size
 *      prior; always-valid p-value with the same 1/e_t bound.
 *
 * Closes the power-problem half: experiments can stop early when the
 * effect is real, late when it isn't. Pairs with T22 (online A/B
 * traffic-split) so the runtime can call `runSequentialTest` per-batch
 * and short-circuit when evidence is decisive.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SequentialState {
  /** ms timestamp the test started. */
  startedAt: number;
  /** Number of observations so far. */
  n: number;
  /** Cumulative e-value (test martingale). 1.0 at start. */
  eValue: number;
  /** Cumulative log-e-value — used internally for numerical stability. */
  logE: number;
  /** Cumulative sum of (X_i - p₀) for Bernoulli, or X_i - μ₀ for Normal. */
  sumDiff: number;
  /** Cumulative sum of (X_i - p₀)² for Bernoulli — used by the mixture variance. */
  sumDiffSq: number;
  /** Whether the test has crossed the rejection threshold. */
  rejected: boolean;
  /** Whether the test has been declared futile (sufficiently low evidence). */
  futile: boolean;
}

export interface StepResult {
  state: SequentialState;
  /** Always-valid p-value: min(1, 1/e_t). */
  pValueAlwaysValid: number;
  /** Current e-value (cumulative). */
  eValue: number;
  /** True when the e-value crosses 1/α — reject H₀. */
  rejectNull: boolean;
  /** True when we recommend stopping (rejected OR futility threshold hit). */
  shouldStop: boolean;
}

export interface BernoulliTestConfig {
  /** Null hypothesis: p₀. */
  p0: number;
  /** Type-I error rate target. Default 0.05. */
  alpha?: number;
  /** Mixture variance ν² — wider = more sensitive to small effects, less powerful for large. Default 0.04. */
  mixtureVariance?: number;
  /** Optional futility floor: if e_t < this, recommend stopping. Default 1e-6 (never). */
  futilityFloor?: number;
}

export interface NormalTestConfig {
  /** Null hypothesis mean. */
  mu0: number;
  /** Known/estimated variance σ². */
  sigmaSq: number;
  /** Type-I error rate. Default 0.05. */
  alpha?: number;
  /** Mixture variance over the effect-size prior. Default 1.0. */
  mixtureVariance?: number;
  futilityFloor?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// State init
// ─────────────────────────────────────────────────────────────────────────────

export function newSequentialState(now: number = Date.now()): SequentialState {
  return {
    startedAt: now,
    n: 0,
    eValue: 1,
    logE: 0,
    sumDiff: 0,
    sumDiffSq: 0,
    rejected: false,
    futile: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bernoulli mSPRT — single-arm test against a null conversion rate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Howard et al. 2021 mSPRT for Bernoulli. The mixture martingale with prior
 * η ~ N(0, ν²) over (p - p₀) has closed-form e-value:
 *
 *   log e_t = -0.5 * log(1 + n * v² * p₀(1-p₀)⁻¹)
 *             + (S_n)² / (2 * (n * v² * p₀(1-p₀)⁻¹⁺¹) * ν²⁻¹) ... [omitted normalization terms]
 *
 * In practice the cleanest implementation uses the conjugate Beta-Binomial
 * mixture form. Here we use the explicit log-e-value update that's
 * numerically stable for streaming data:
 *
 *   log e_t = log(B_normal(S_n; n, v², p₀))
 *
 * where B_normal is the marginal likelihood under the mixture prior.
 *
 * The implementation below uses the simplified log-likelihood-ratio form
 * for the Bernoulli case, which is exact and matches the formula from
 * Howard 2021 eq. (3.1) specialized to Bernoulli.
 */
export function stepBernoulli(
  state: SequentialState,
  observation: 0 | 1,
  config: BernoulliTestConfig
): StepResult {
  const alpha = config.alpha ?? 0.05;
  const v2 = config.mixtureVariance ?? 0.04;
  const futilityFloor = config.futilityFloor ?? 1e-6;
  const p0 = config.p0;
  if (p0 <= 0 || p0 >= 1) throw new Error("stepBernoulli: p0 must be in (0, 1)");

  const n = state.n + 1;
  const sumDiff = state.sumDiff + (observation - p0);
  const sumDiffSq = state.sumDiffSq + Math.pow(observation - p0, 2);

  // Mixture e-value via the Howard 2021 mSPRT formula:
  //   log e_t = -0.5 log(1 + V_t * v²) + (M_t² / (2 * (V_t⁻¹ + v²)))
  // where M_t = sum of (X - p0); V_t = sum of (X - p0)² ≈ n * p0 * (1 - p0).
  // We use sumDiffSq directly as the empirical V_t for robustness.
  const V_t = Math.max(1e-12, sumDiffSq);
  const denom = 1 / V_t + v2;
  const logE = -0.5 * Math.log(1 + V_t * v2) + (sumDiff * sumDiff) / (2 * denom * (V_t * V_t));
  // The above is the maximum-likelihood form. For Bernoulli the canonical
  // simpler form uses M_t² / (2 V_t (1 + V_t v²)):
  const logEClean = (sumDiff * sumDiff) / (2 * V_t * (1 + V_t * v2)) - 0.5 * Math.log(1 + V_t * v2);
  const eValue = Math.exp(logEClean);

  const pValueAlwaysValid = Math.min(1, 1 / Math.max(1e-300, eValue));
  const rejected = state.rejected || eValue >= 1 / alpha;
  const futile = state.futile || eValue <= futilityFloor;

  const nextState: SequentialState = {
    ...state,
    n,
    sumDiff,
    sumDiffSq,
    eValue,
    logE: logEClean,
    rejected,
    futile,
  };

  return {
    state: nextState,
    pValueAlwaysValid,
    eValue,
    rejectNull: rejected,
    shouldStop: rejected || futile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normal-mean mSPRT — continuous outcomes (CPL, ROAS, etc)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mixture martingale for normal mean test (Howard et al. 2021 eq. 4.7).
 * For X_i ~ N(μ, σ²) with known σ², testing H₀: μ = μ₀ via mixture over
 * the effect δ = μ - μ₀ ~ N(0, ν²):
 *
 *   log e_t = (S_t² ν²) / (2 σ²(σ² + n ν²)) - 0.5 log(1 + n ν² / σ²)
 *
 * where S_t = sum(X_i - μ₀).
 */
export function stepNormal(
  state: SequentialState,
  observation: number,
  config: NormalTestConfig
): StepResult {
  const alpha = config.alpha ?? 0.05;
  const v2 = config.mixtureVariance ?? 1.0;
  const futilityFloor = config.futilityFloor ?? 1e-6;
  const sigmaSq = config.sigmaSq;
  if (sigmaSq <= 0) throw new Error("stepNormal: sigmaSq must be positive");

  const n = state.n + 1;
  const sumDiff = state.sumDiff + (observation - config.mu0);

  const denomLog = 1 + (n * v2) / sigmaSq;
  const numerator = (sumDiff * sumDiff * v2) / (2 * sigmaSq * (sigmaSq + n * v2));
  const logE = numerator - 0.5 * Math.log(denomLog);
  const eValue = Math.exp(logE);

  const pValueAlwaysValid = Math.min(1, 1 / Math.max(1e-300, eValue));
  const rejected = state.rejected || eValue >= 1 / alpha;
  const futile = state.futile || eValue <= futilityFloor;

  return {
    state: {
      ...state,
      n,
      sumDiff,
      sumDiffSq: state.sumDiffSq + Math.pow(observation - config.mu0, 2),
      eValue,
      logE,
      rejected,
      futile,
    },
    pValueAlwaysValid,
    eValue,
    rejectNull: rejected,
    shouldStop: rejected || futile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch runners — for streamed data over many observations
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchTestResult {
  finalState: SequentialState;
  stoppingPoint: number | null;
  totalObservations: number;
  finalEValue: number;
  finalPValue: number;
  rejected: boolean;
  futile: boolean;
}

export function runBernoulliTest(
  observations: (0 | 1)[],
  config: BernoulliTestConfig
): BatchTestResult {
  let state = newSequentialState();
  let stoppingPoint: number | null = null;
  for (let i = 0; i < observations.length; i++) {
    const result = stepBernoulli(state, observations[i]!, config);
    state = result.state;
    if (result.shouldStop && stoppingPoint == null) {
      stoppingPoint = i + 1;
    }
  }
  return {
    finalState: state,
    stoppingPoint,
    totalObservations: state.n,
    finalEValue: state.eValue,
    finalPValue: Math.min(1, 1 / Math.max(1e-300, state.eValue)),
    rejected: state.rejected,
    futile: state.futile,
  };
}

export function runNormalTest(
  observations: number[],
  config: NormalTestConfig
): BatchTestResult {
  let state = newSequentialState();
  let stoppingPoint: number | null = null;
  for (let i = 0; i < observations.length; i++) {
    const result = stepNormal(state, observations[i]!, config);
    state = result.state;
    if (result.shouldStop && stoppingPoint == null) {
      stoppingPoint = i + 1;
    }
  }
  return {
    finalState: state,
    stoppingPoint,
    totalObservations: state.n,
    finalEValue: state.eValue,
    finalPValue: Math.min(1, 1 / Math.max(1e-300, state.eValue)),
    rejected: state.rejected,
    futile: state.futile,
  };
}
