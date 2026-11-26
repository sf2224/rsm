import { describe, expect, it } from "vitest";
import { validateSnapshot } from "@/lib/data/validation";
import { snapshotDataSchema, categorySum } from "@/lib/data/schema";
import { suggestPeriodLabel, monthsBetween } from "@/lib/data/dates";
import { seedOct, seedSep, confirmed, TODAY } from "./helpers";

const ctx = { today: TODAY, previous: null };
const codes = (r: ReturnType<typeof validateSnapshot>) => r.issues.map((i) => i.code);

describe("seed data matches the IMI publication", () => {
  it("has 14 categories, total 989 and a category sum of 990", () => {
    const d = seedOct();
    expect(d.categories).toHaveLength(14);
    expect(d.totalCrimes).toBe(989);
    expect(categorySum(d)).toBe(990);
    expect(d.categories.find((c) => c.id === "broadcast-takeover")?.value).toBe(42);
    expect(d.period).toEqual({ start: "2026-09-24", end: "2026-10-24", newCases: 12 });
    expect(d.casualties).toEqual({ killedTotal: 143, killedOnDuty: 15 });
  });
});

describe("sum ≠ total is never auto-corrected, but can be confirmed", () => {
  it("blocks publishing (gate) but not submission while unconfirmed", () => {
    const r = validateSnapshot(seedOct(), ctx);
    expect(codes(r)).toContain("sum-mismatch");
    expect(r.canSubmit).toBe(true);
    expect(r.canPublish).toBe(false);
    expect(r.categorySum).toBe(990);
    expect(r.total).toBe(989);
  });
  it("requires an explanation in both languages after confirmation", () => {
    const d = seedOct();
    d.verification.sumMismatchConfirmed = true;
    d.verification.sourceChecked = true;
    d.verification.sumMismatchExplanation = { uk: "Пояснення", en: "" };
    const r = validateSnapshot(d, ctx);
    expect(codes(r)).toContain("sum-mismatch-explanation");
    expect(r.canPublish).toBe(false);
  });
  it("allows publishing once confirmed and explained", () => {
    const r = validateSnapshot(confirmed(seedOct()), ctx);
    expect(r.canPublish).toBe(true);
    expect(codes(r)).toContain("sum-mismatch-confirmed");
    expect(r.data?.totalCrimes).toBe(989); // value untouched
  });
  it("requires the source check", () => {
    const d = confirmed(seedOct());
    d.verification.sourceChecked = false;
    expect(validateSnapshot(d, ctx).canPublish).toBe(false);
  });
});

describe("data checks", () => {
  it("rejects missing critical translations", () => {
    const d = confirmed(seedOct());
    d.categories[3]!.name.en = "";
    const r = validateSnapshot(d, ctx);
    expect(codes(r)).toContain("translation-missing");
    expect(r.canSubmit).toBe(false);
  });
  it("ignores translations of hidden categories", () => {
    const d = confirmed(seedOct());
    d.categories[3]!.name.en = "";
    d.categories[3]!.hidden = true;
    expect(codes(validateSnapshot(d, ctx))).not.toContain("translation-missing");
  });
  it("rejects future dates and impossible relations", () => {
    const d = confirmed(seedOct());
    d.asOfDate = "2027-01-01";
    d.casualties.killedOnDuty = 500;
    const r = validateSnapshot(d, ctx);
    expect(codes(r)).toEqual(expect.arrayContaining(["dates-future", "killed-order"]));
  });
  it("compares with the previous publication", () => {
    const prev = seedSep();
    const r = validateSnapshot(confirmed(seedOct()), { today: TODAY, previous: prev });
    // 989 − 977 = 12 = declared new cases → no warning
    expect(codes(r)).not.toContain("new-cases-vs-delta");
    const d = confirmed(seedOct());
    d.period.newCases = 20;
    d.categories[0]!.value = 10;
    expect(codes(validateSnapshot(d, { today: TODAY, previous: prev }))).toEqual(expect.arrayContaining(["new-cases-vs-delta", "category-decreased"]));
  });
});

describe("schema hardening", () => {
  it("rejects HTML and scripts in texts", () => {
    const d = seedOct();
    for (const bad of ["<script>alert(1)</script>", '<img src=x onerror="x">', "javascript:alert(1)"]) {
      d.categories[0]!.description.uk = bad;
      expect(snapshotDataSchema.safeParse(d).success).toBe(false);
    }
  });
  it("accepts only https links", () => {
    const d = seedOct();
    d.sources.articleUk = "javascript:alert(1)";
    expect(snapshotDataSchema.safeParse(d).success).toBe(false);
    d.sources.articleUk = "http://imi.org.ua/";
    expect(snapshotDataSchema.safeParse(d).success).toBe(false);
  });
  it("rejects unknown icons and malformed ids", () => {
    const d = seedOct();
    d.categories[0]!.iconId = "../../etc/passwd";
    expect(snapshotDataSchema.safeParse(d).success).toBe(false);
  });
});

describe("period label", () => {
  it("is derived from dates", () => {
    expect(monthsBetween("2022-02-24", "2026-10-24")).toBe(56);
    expect(suggestPeriodLabel("2022-02-24", "2026-10-24")).toEqual({
      uk: "4 роки і 8 місяців повномасштабної війни",
      en: "4 years, 8 months of the full-scale war",
    });
    expect(suggestPeriodLabel("2022-02-24", "2027-02-24").uk).toBe("5 років повномасштабної війни");
  });
});

describe("history (dynamics by year)", () => {
  it("seed history is valid and sourced", () => {
    const d = confirmed(seedOct());
    expect(d.history.points.length).toBeGreaterThan(20);
    expect(d.history.points.every((p) => p.source.startsWith("https://"))).toBe(true);
    expect(codes(validateSnapshot(d, ctx)).filter((c) => c.startsWith("history"))).toEqual([]);
  });
  it("defaults to empty history for older documents", () => {
    const raw = structuredClone(seedOct()) as Record<string, unknown>;
    delete raw.history;
    expect(snapshotDataSchema.parse(raw).history).toEqual({ points: [], years: [] });
  });
  it("rejects unordered, out-of-range and duplicate entries", () => {
    const d = confirmed(seedOct());
    const [a, b] = d.history.points;
    d.history.points[0] = b!;
    d.history.points[1] = a!;
    d.history.points.push({ ...a!, date: d.asOfDate });
    d.history.points.push({ ...a!, date: "2099-01-01" });
    d.history.years.push({ ...d.history.years[0]! });
    const r = validateSnapshot(d, ctx);
    expect(codes(r)).toEqual(expect.arrayContaining(["history-order", "history-same-day", "history-date", "history-years"]));
    expect(r.canSubmit).toBe(false);
  });
  it("warns when a past value exceeds the current total", () => {
    const d = confirmed(seedOct());
    d.history.points.at(-1)!.total = 5000;
    expect(codes(validateSnapshot(d, ctx))).toContain("history-gt-total");
  });
});
