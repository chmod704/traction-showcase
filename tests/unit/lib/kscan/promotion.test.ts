import { describe, it, expect } from "vitest";
import {
  promoteFromGauntlet,
  selectForTesting,
  settleFromOutcome,
  enforceConfidenceCeiling,
  injectionMode,
} from "@/lib/kscan/promotion";
import { PROJECTION_CEILING } from "@/lib/kscan/schema";

describe("promoteFromGauntlet", () => {
  it("a dead verdict → refuted, zero confidence", () => {
    const r = promoteFromGauntlet({ value: 0.3, dead: true, killedBy: "evidenceGrade" });
    expect(r.status).toBe("refuted");
    expect(r.confidence).toBe(0);
  });
  it("a survivor → verified-prior at PROJECTION, capped confidence", () => {
    const r = promoteFromGauntlet({ value: 0.9, dead: false, killedBy: null });
    expect(r.status).toBe("verified-prior");
    expect(r.confidence).toBe(PROJECTION_CEILING);
    expect(r.calibration).toBe("PROJECTION");
  });
});

describe("the ladder invariant — only a REAL outcome confers truth", () => {
  it("selectForTesting only promotes a verified-prior", () => {
    expect(selectForTesting({ status: "verified-prior", confidence: 0.2 }).status).toBe("testing");
    expect(selectForTesting({ status: "candidate", confidence: 0.2 }).status).toBe("candidate");
  });

  it("a CONFIRMED outcome is the ONLY way confidence exceeds the PROJECTION ceiling", () => {
    const r = settleFromOutcome({ status: "testing" }, { settled: true, confirmed: true, measuredConfidence: 0.72 });
    expect(r.status).toBe("confirmed");
    expect(r.confidence).toBeCloseTo(0.72, 3);
    expect(r.confidence).toBeGreaterThan(PROJECTION_CEILING);
    expect(r.calibration).toBe("CALIBRATED");
  });

  it("an outcome refutation kills the node regardless of gauntlet quality", () => {
    const r = settleFromOutcome({ status: "testing" }, { settled: true, confirmed: false, measuredConfidence: 0 });
    expect(r.status).toBe("refuted");
  });

  it("a node not under test cannot be settled by an outcome", () => {
    const r = settleFromOutcome({ status: "verified-prior" }, { settled: true, confirmed: true, measuredConfidence: 0.9 });
    expect(r.status).toBe("verified-prior");
  });

  it("enforceConfidenceCeiling hard-caps everything except confirmed", () => {
    expect(enforceConfidenceCeiling("verified-prior", 0.9)).toBe(PROJECTION_CEILING);
    expect(enforceConfidenceCeiling("testing", 0.9)).toBe(PROJECTION_CEILING);
    expect(enforceConfidenceCeiling("confirmed", 0.9)).toBe(0.9);
  });
});

describe("injectionMode — proof vs guess discipline", () => {
  it("only confirmed nodes inject as guidance; priors inject as hypotheses; refuted/candidate withheld", () => {
    expect(injectionMode("confirmed")).toBe("guidance");
    expect(injectionMode("verified-prior")).toBe("hypothesis");
    expect(injectionMode("testing")).toBe("hypothesis");
    expect(injectionMode("candidate")).toBe("withheld");
    expect(injectionMode("refuted")).toBe("withheld");
  });
});
