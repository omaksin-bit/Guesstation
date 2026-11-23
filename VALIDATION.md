# Validation — Guesstation web port

Validated with Node (no browser needed) against the shipped iOS app's
known values. Harness: `../hidden_files/validation/guesstation-validate.js`
(run: `node guesstation-validate.js` from that folder — it loads
`app.js` via `require` and the model JSON; the math core is exported
from `app.js` for exactly this purpose). **103 checks, 103 passed**
(2026-11-22, after verification against the shipped Swift sources —
see §7). The harness now includes an independent transcription of
Swift's formulas and checks the web against it directly (§0).

## 1. Default profile — "If you wait" (SPONTANEOUS), singleton

Reference profile = all 23 features zero (age 25–34, BMI normal,
singleton, not first birth, female, White, no conditions).

| Quantity | Observed | Expected (shipped app, build-3 on-device test) | Verdict |
|---|---|---|---|
| Median | 40w1d (280.65 d) | ~40w1d (±2 d) | PASS |
| Likely window (middle 50%) | 39w0d – 41w1d (273.39 – 287.55 d) | ~39w0d – 41w1d (±3 d) | PASS |
| Preterm (<37w) | 4.63% | ~5% (±1.5 pp) | PASS |
| Early term (37–38w) | 19.03% | — | — |
| Full term (39–40w) | 50.31% | — | — |
| Late term (≥41w) | 26.03% | — | — |

**Default-profile finding — CONFIRMED against FeatureEncoding.swift (2026-11-22).** The brief described the
default as "a typical first-time singleton pregnancy", but a
first-birth default gives median 40w4d (283.76 d), window
39w3d–41w6d, preterm 3.12% — which does NOT match the shipped app.
The all-zero reference profile reproduces the shipped app's numbers
exactly on all quantities, and the Swift source confirms it:
`PregnancyProfile` defaults are `firstPregnancy = false`,
`ageProvided = false`, `bmiProvided = false`, `race = .notSpecified`,
`infantSex = .unknown` — i.e. exactly the all-zero reference. The
web default (first-birth toggle defaults to No) matches the shipped
app.

## 2. PMF sums to 1.0 (within 1e-6) — every scenario × plurality

Default (reference) features. All sums 1.000000000. The app has only
two scenarios (SPONTANEOUS, ALL); the induced share is a cumulative
incidence (see §7, check 3), not a third scenario.

| Plurality | SPONTANEOUS | ALL | pInduced (indicated share) | pSpont |
|---|---|---|---|---|
| singleton | PASS | PASS | 38.1% | 61.9% |
| twins | PASS | PASS | 69.0% | 31.0% |
| tripletPlus | PASS | PASS | 67.0% | 33.0% |

## 3. Ordering principle — ALL median ≤ SPONTANEOUS median

Checked for 8 profiles (default, prevPreterm, prevCesarean,
chronicHTN, age 40+ / obese / gestDiab, smoker + first birth, twins,
under 20). All PASS. Examples (singleton, SPONTANEOUS → ALL):
default 40w1d → 39w3d; prevCesarean 42w1d → 39w3d; chronicHTN
40w2d → 39w0d. (Pre-verification the ALL medians ran ~1 day late
because of the wrong total-hazard formula — see §7, check 2.)

Plurality sanity: SPONTANEOUS medians singleton 40w1d > twins 39w5d
> triplets 37w2d. PASS.

## 4. Readjustment (v1 spec §10)

Fixed "today" = 2026-11-22. LMP 2026-01-25 (GA 43w0d, original
median Nov 2 passed): state = readjusted, original 40w1d →
readjusted 43w6d (Nov 28). Strictly later: PASS. Window ordered
(q25 ≤ median ≤ q75): PASS.

Doc §7 example (EDD Sep 30 2026, viewed at GA 43w5d): readjusted
median 44w2d — doc's profile gave 44w1d; within tolerance (±4 d),
profile unknown. PASS.

## 5. Beyond range

- GA exactly 45w0d (LMP 2026-01-11, viewed 2026-11-22) → state
  `beyond` (no numbers). PASS.
- GA 44w6d → still predicts (readjusted), median 314.5 d (rounds to
  45w0d), q75 314.75 d. PASS — this is exactly what Swift gives; the
  app itself shows 45w0d in this edge case (no 44w6d clamp in
  HazardModel — see §7, check 6).

## 6. Calendar guardrails + mode conversion (today = 2026-11-22)

- LMP range: 2026-01-12 (today − 314 d) .. 2026-11-22 (today). PASS.
- EDD range: 2026-10-19 (today − 34 d) .. 2027-08-29 (today + 280 d). PASS.
- LMP + 280 d = EDD and back again (2026-02-15 ↔ 2026-11-22). PASS.
- No date entered → no prediction shown. PASS.
- Future EDD (2026-12-15) → normal state, "You are 36w5d today". PASS.

## 7. Verification against the shipped Swift sources (2026-11-22)

Ground truth: `HazardModel.swift` + `FeatureEncoding.swift`, pulled
from the user's Mac. The harness now contains an independent
transcription of Swift's formulas and checks the web against it
directly (§0: pmfs element-wise < 1e-9, medians < 1e-6 d, for 7
profiles + twins/triplets). Item by item:

1. **Hazard formulas — MATCH.** `sigmoid(baselineLogit + Σ coef·x)`,
   logit clamped to [-35, 35], plurality falls back to singleton.
   Web hazards match Swift to 5.6e-17 for weeks 20–43.
2. **Total-hazard combination — DIVERGED, FIXED.** The web used the
   independent-hazards total `hS + hI − hS·hI`; Swift's `decompose()`
   uses the additive total `min(hS + hI, 1)` (forced to 1.0 in the
   last week), split between causes by hazard share. The difference
   was real: max weekly-mass diff 0.051, ALL median 39w4d (web) vs
   39w3d (Swift), indicated share 43.7% vs 38.1%. Fixed: web now
   implements `decompose()` exactly. Also fixed: the web forced
   hS[44] = 1.0 inside `computeHazards` (Swift raw value is 0.6998);
   the forcing now happens only inside `netPmf()`, as in Swift.
3. **Scenarios — DIVERGED, FIXED.** Swift's `Scenario` has only
   `spontaneous` and `all`. The web's third "Induced" scenario (a
   renormalized `S_total·h_i` distribution) was invented and has been
   removed from the UI and the math. The induced share survives as
   `pInduced`, the cumulative incidence from `decompose()` (38.1%
   singleton) — exactly as `Prediction.pInduced` in Swift.
4. **Quantile/median interpolation — MATCH.** Smallest week with
   cumulative PMF ≥ q, linear CDF interpolation within the week;
   dates round to the nearest day (`date(atWeeks:)`). Verified
   numerically: identical medians/windows for all profiles tested.
5. **Daily PMF / chart — MATCH (consistent).** Swift has no daily
   chart in these files; the web spreads each week's PMF evenly over
   its 7 days, which is the same uniform-within-week assumption
   Swift's quantile interpolation makes. Daily PMF sums to 1.
6. **Readjustment conditioning — MATCH.** Swift renormalizes the
   remaining weekly PMF (straddling week keeps only its remaining
   fraction); the web renormalizes the remaining daily PMF. Verified
   numerically identical: GA 43w0d → 43w6d, doc §7 case → 44w2d,
   GA 44w3d → 44w5d, all to within 0.05 d. One edge case: the web
   used to clamp displayed quantiles to 44w6d (314 d); Swift has no
   clamp, so at GA 44w6d the median is 314.5 d (rounds to 45w0d).
   Clamp removed — the web now matches Swift exactly.
7. **Beyond range — MATCH.** GA ≥ 45w0d → no numbers (Swift flags
   `beyondRange` when `conditionedFromWeek >= 45`).
8. **Week-44 forcing — MATCH (after fix 2).** Swift forces the total
   to 1.0 in the last week inside `decompose()` and h[last] = 1.0
   inside `netPmf()`; the web does the same now, in the same places.
9. **Term bands — DIVERGED, FIXED.** Swift has four bands: preterm
   <37w, early term 37–38w, full term 39–40w, late term ≥41w. The web
   showed three (preterm / term 37–41 / post-term ≥42). Fixed in both
   the weekly and conditioned-daily breakdowns and in the UI bars.
10. **Feature encoding — MATCH.** All 23 features, band boundaries
    (age <20 / 20–24 / 35–39 / 40+; BMI <18.5 / 25–30 / ≥30),
    reference levels (age 25–34, BMI normal, White/unknown,
    female/unknown), and the "not provided → reference" rule match
    `featureVector()` exactly.
11. **Input defaults — MATCH (confirmed).** See §1: the all-zero
    reference is the app's default profile per `PregnancyProfile`.
12. **Date-mode switching — DIVERGED, FIXED.** Swift: each mode
    keeps its own stored date; switching never converts (a mode with
    no stored date shows today until picked). The web converted the
    date on switch (LMP+280d=EDD). Fixed: per-mode stored dates
    (`eddDateStr` / `lmpDateStr`), no conversion; a fresh mode shows
    an empty picker. Old single-date saves migrate (the saved date
    belongs to the saved mode).
13. **Other — MATCH / not in these files.** Sigmoid clamping,
    `weeksDaysString` rounding, and the GA ≥ 45w beyond-range trigger
    match. The readjustment *trigger* (today past the original median
    date) and the calendar guardrails come from the v1 spec §10, not
    from these two files — `ContentView.swift` was not provided, so
    they are spec-verified, not Swift-verified. The chart itself
    (daily bars) is also not in these files; only its underlying
    daily-PMF math was checked.

## Reconstruction decisions (verified against HazardModel.swift, §7)

These were the exact formulas the web port used before verification.
Items 2, 5, 8 and 9 below were wrong and have been fixed (see §7);
the rest were confirmed as written:

1. **Hazards.** Per week w (20–44), plurality p:
   `h_s = sigmoid(baselineLogit_s[p][w] + Σ coef_s[i]·x[i])`,
   `h_i = sigmoid(baselineLogit_i[p][w] + Σ coef_i[i]·x[i])`.
   Week-44 spontaneous hazard forced to 1.0.
2. **Total hazard — FIXED.** Was `h = h_s + h_i − h_s·h_i`; Swift
   uses `decompose()`: weekly total `min(h_s + h_i, 1)` (1.0 in the
   last week), split by hazard share; survival `S(w) = Π(1 − total)`.
3. **SPONTANEOUS.** Net: hazard and survival from h_s only.
4. **ALL.** Total hazard for both hazard and survival.
5. **INDUCED — REMOVED.** The pre-verification port had a third
   "Induced" scenario: raw `pmf_ind(w) = S_total(w−1)·h_i(w)`,
   renormalized to sum to 1. Swift has no such scenario (see §7,
   check 3). The induced share is now `pInduced`, the cumulative
   incidence from `decompose()` (38.1% singleton).
6. **Quantiles.** Smallest week with cumulative PMF ≥ q, linear
   interpolation of the CDF within the week (week w covers GA days
   [7w, 7w+7)); median/q25/q75 in days, rounded to the nearest day
   for dates and weeks+days display.
7. **Readjustment.** Daily PMF (weekly PMF ÷ 7 per day), conditioned
   on still pregnant at today's GA: remaining mass renormalized;
   median/window interpolated within the median day. Trigger: today
   later than the original median date. Chart and term breakdown in
   the readjusted state use the *conditioned* distribution.
8. **44w6d cap — REMOVED.** Displayed quantiles were clamped to 314
   d; Swift has no clamp (§7, check 6). Edge case GA 44w6d now shows
   the Swift value (median 314.5 d → 45w0d).
9. **Default profile — CONFIRMED.** All-zero reference (see §1) —
   first-birth toggle defaults to No, per `PregnancyProfile`.
10. **Triplet/twin late-week baselines.** The JSON has 0.0 baselines
    for tripletPlus weeks 40–44 and twins week 44 (both causes);
    used as-is. The week-44 forcing makes the tail well-defined;
    survival by week 40 is already tiny for these pluralities.

## Notes / discrepancies spotted

- `n_births_fit` in the shipped JSON is 514,352 — the K=7 fit
  (every-7th-row sample of CDC 2023), consistent with the doc's
  "matches the K=7 model". The GOAL.md note about K=16 / 225,017
  births describes an older fit, not the shipped model.
- The UI (form rendering, chart, date-picker guardrails,
  localStorage) could not be exercised in a browser here — only the
  math was executed. The three files were served over local HTTP and
  all return 200; all element IDs referenced in `app.js` exist in
  `index.html` (one apparent miss, `checkDatesBtn`, is created
  dynamically by the render code). Open the hosted URL and check: the
  date picker grays out-of-range dates, the scenario toggle, and the
  readjusted/beyond-range states.
