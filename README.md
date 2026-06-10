# Traction Agents — Showcase

[![CI](https://github.com/chmod704/traction-showcase/actions/workflows/ci.yml/badge.svg)](https://github.com/chmod704/traction-showcase/actions/workflows/ci.yml)

A **curated, runnable slice** of Traction Agents v2: an automated marketing + operations system for roofing contractors. This repo ships five self-contained artifacts from the larger (private) system — each paired with the **green test that proves it**. It's a serious applied system, honestly scoped (see the calibration line below) — not a frontier-model project.

```bash
npm install
npm test        # 76 tests, all green — clone it and run it yourself
npm run typecheck
```

`TypeScript · Vitest · fast-check` — zero runtime services required; every test here is pure and self-contained.

## Why this repo exists

The full system is large (≈3,625 tests across 358 files, 22 agents, 135 scheduled jobs, 144 migrations) and **private**. Rather than dump 559 modules, this is a deliberately small set of the pieces that best demonstrate the engineering discipline — security, epistemic honesty, and verification rigor — that the whole system is built to. Each one runs on its own.

## The calibration line (read this first)

Everything here is proven **as code that executes correctly against its contract in a green test** — not as a business outcome. The parent system has **0 production clients**; confidence in any outcome is capped at `PROJECTION` (≤ 0.25) until real spend settles, and **that ceiling is enforced in code** (see the KSCAN promotion ladder below). The honesty is the design: the system cannot present certainty it hasn't earned.

## The five artifacts

| Artifact | What it proves | Code · Test |
|---|---|---|
| **3-tier fail-closed action gate** | An autonomous agent's hands default to **deny**: unknown tools fail closed to TIER 2 (propose-only — cannot auto-fire even with a confirmation token); TIER 1 needs per-action approval; TIER 0 is autonomous. | [`action-policy.ts`](src/lib/jarvis/action-policy.ts) · [test (18)](tests/unit/lib/jarvis/action-policy.test.ts) |
| **SSRF URL guard** | The shared guard that a contractor-webhook deliverer and an agent's browser hand both use — rejects `file://`, localhost, RFC-1918, IPv6 loopback/ULA, and the cloud-metadata endpoint. | [`url-guard.ts`](src/lib/security/url-guard.ts) · [test](tests/unit/lib/security/url-guard.test.ts) |
| **KSCAN value gauntlet** | A claim's worth is the **multiplicative** product of five independent layers — any layer below the kill-floor (0.05) zeroes it. The composite + kill logic, proven. | [`schema.ts`](src/lib/kscan/schema.ts) · [test](tests/unit/lib/kscan/schema.test.ts) |
| **Projection-ceiling invariant** | The epistemic-honesty mechanism in code: a knowledge prior is hard-capped at 0.25, and **only a confirmed real outcome** can lift it. Priors inject as labeled hypotheses, never as guidance. | [`promotion.ts`](src/lib/kscan/promotion.ts) · [test](tests/unit/lib/kscan/promotion.test.ts) |
| **Verification spine** | The money-math (Wasserstein DRO, mixture-SPRT always-valid testing) is held to **property-based** (generated inputs, fast-check) *and* **metamorphic** standards — invariant relations asserted where ground truth is unknown. | [`dro.ts`](src/lib/dro.ts) · [`sequential-testing.ts`](src/lib/sequential-testing.ts) · [property](tests/unit/lib/dro.property.test.ts) · [metamorphic](tests/unit/lib/metamorphic/dro.metamorphic.test.ts) |

## What's deliberately not here

This is a slice, not the system. The agent fleet, the lead→cash pipeline, the Cortex memory backbone, the campaign executor, the JARVIS computer-use runtime, and the business/strategy layer live in the private repo. One registry-integration test was trimmed from the action-policy suite because it imports the full tool registry; the gate logic it guards is fully present and proven.

In techincal terms - Traction is a multi-agent harness wrapping a frozen foundation model — with persistent memory (RAG over a vector store), tool-use hands, an agentic orchestration loop, a verification/observability spine, and an emerging self-governance layer (calibration, drift detection,
    credit assignment) — being grown one calibrated, shadow-tested organ at a time toward reliable long-horizon autonomy in a single vertical.

## License

All rights reserved. This code is published for review and demonstration only — not licensed for reuse, modification, or redistribution.
