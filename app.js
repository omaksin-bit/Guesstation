/* Guesstation — web version (v1 predictor only, no affirmations).
 *
 * Plain static files, no build step, no external dependencies.
 * Model: GestationModel.json (CDC Natality 2023, n=514,352) — classical
 * statistics (competing-risks discrete-time hazard, penalized pooled
 * logistic). This is NOT machine learning, and the app never calls it ML.
 *
 * Math VERIFIED against the shipped iOS app's Swift sources
 * (HazardModel.swift, FeatureEncoding.swift), 2026-11-22 — see
 * VALIDATION.md §7 for the item-by-item check. The Swift code is the
 * ground truth wherever the earlier reconstruction differed.
 */
(function () {
  'use strict';

  var DAY_MS = 24 * 60 * 60 * 1000;
  var WEEK_MIN = 20;
  var WEEK_MAX = 44;
  var N_WEEKS = 25; // weeks 20..44 inclusive

  /* ------------------------------------------------------------------ */
  /* Model math (pure functions — also exercised by the Node validator)  */
  /* ------------------------------------------------------------------ */

  function sigmoid(x) {
    // numerically safe for very negative x
    if (x >= 0) {
      var z = Math.exp(-x);
      return 1 / (1 + z);
    }
    var z2 = Math.exp(x);
    return z2 / (1 + z2);
  }

  // features: object mapping each of the 23 featureNames to 0 or 1.
  // Returns { hS: [25], hI: [25] } — RAW cause-specific hazards per
  // week, index k = week (20 + k). Exactly as HazardModel.swift:
  // sigmoid of (baseline logit + coef sum), logit clamped to [-35, 35],
  // plurality falling back to singleton. No forcing here: the week-44
  // forcing happens in netPmf() (spontaneous) and decompose() (all),
  // as in Swift — forcing hS[44] here would corrupt the week-44
  // cause split in decompose().
  function computeHazards(model, features, plurality) {
    var baseS = model.causes.spontaneous.baselineLogit[plurality] ||
      model.causes.spontaneous.baselineLogit['singleton'];
    var baseI = model.causes.indicated.baselineLogit[plurality] ||
      model.causes.indicated.baselineLogit['singleton'];
    var coefS = model.causes.spontaneous.coef;
    var coefI = model.causes.indicated.coef;
    var names = model.featureNames;
    var hS = [], hI = [];
    for (var k = 0; k < N_WEEKS; k++) {
      var ls = baseS[k], li = baseI[k];
      for (var j = 0; j < names.length; j++) {
        var x = features[names[j]] || 0;
        if (x) { ls += coefS[names[j]]; li += coefI[names[j]]; }
      }
      hS.push(sigmoid(Math.min(Math.max(ls, -35), 35)));
      hI.push(sigmoid(Math.min(Math.max(li, -35), 35)));
    }
    return { hS: hS, hI: hI };
  }

  // Net-survival pmf for a single cause with the competing event
  // censored (HazardModel.netPmf): last week's hazard forced to 1.0,
  // pmf[k] = S(k-1) * h[k]. Sums to 1.0.
  function netPmf(hazard) {
    var h = hazard.slice();
    h[h.length - 1] = 1.0;
    var pmf = [], s = 1;
    for (var k = 0; k < h.length; k++) {
      pmf.push(s * h[k]);
      s *= (1 - h[k]);
    }
    return pmf;
  }

  // Competing-risks decomposition (HazardModel.decompose): each cause's
  // per-week contribution to the all-cause delivery pmf. The weekly
  // total is hs + hi (capped at 1; forced to 1 in the last week so
  // everyone has delivered by week 44), split between causes by their
  // hazard share. NOTE: this is NOT the independent-hazards total
  // hs + hi - hs*hi — Swift adds the hazards, and the difference is
  // real (up to ~5 points of weekly mass in late weeks, ~1 day on the
  // ALL median).
  function decompose(hs, hi) {
    var n = hs.length;
    var cs = [], ci = [], s = 1;
    for (var j = 0; j < n; j++) {
      var total = (j === n - 1) ? 1.0 : Math.min(hs[j] + hi[j], 1.0);
      var denom = hs[j] + hi[j];
      var shareS = denom > 0 ? hs[j] / denom : 0.5;
      cs.push(s * total * shareS);
      ci.push(s * total * (1 - shareS));
      s *= (1 - total);
    }
    return { spont: cs, induced: ci };
  }

  // Scenario PMFs (HazardModel.predict):
  // - spont ("If you wait"): NET spontaneous hazard only, survival from
  //   the spontaneous hazard alone (interventions censored).
  // - all ("All deliveries"): decompose's spont + induced contributions.
  // There is NO induced scenario in the app (Scenario has only
  // spontaneous/all); the induced share is reported as pInduced, the
  // cumulative incidence of indicated deliveries — NOT a renormalized
  // conditional distribution, so there is no induced median/window.
  function distributions(model, features, plurality) {
    var hz = computeHazards(model, features, plurality);
    var dec = decompose(hz.hS, hz.hI);
    var pmfSpont = netPmf(hz.hS);
    var pmfAll = [];
    for (var k = 0; k < N_WEEKS; k++) pmfAll.push(dec.spont[k] + dec.induced[k]);
    var pSpont = 0, pInduced = 0;
    for (var k2 = 0; k2 < N_WEEKS; k2++) { pSpont += dec.spont[k2]; pInduced += dec.induced[k2]; }
    return { spont: pmfSpont, all: pmfAll, pSpont: pSpont, pInduced: pInduced };
  }

  // Quantile of the weekly PMF in gestational-age days (float).
  // Finds the smallest week whose cumulative PMF >= q, then linearly
  // interpolates the CDF within that week (the daily chart spreads a
  // week's PMF evenly over its 7 days, so the CDF is linear in-day).
  // Week w covers GA days [7w, 7w+7).
  function quantileDays(pmf, q) {
    var cum = 0, prev = 0;
    for (var k = 0; k < pmf.length; k++) {
      prev = cum;
      cum += pmf[k];
      if (cum >= q) {
        var frac = pmf[k] > 0 ? (q - prev) / pmf[k] : 0;
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
        return (WEEK_MIN + k) * 7 + 7 * frac;
      }
    }
    return WEEK_MAX * 7 + 7; // unreachable when pmf sums to 1 (q <= 1)
  }

  // Term breakdown of a weekly PMF — the app's four bands
  // (HazardModel.predict: pretermProb, earlyTermProb, fullTermProb,
  // lateTermProb): P(<37w), P(37–38w), P(39–40w), P(>=41w).
  function termBreakdown(pmf) {
    var preterm = 0, earlyTerm = 0, fullTerm = 0, lateTerm = 0;
    for (var k = 0; k < pmf.length; k++) {
      var w = WEEK_MIN + k;
      if (w < 37) preterm += pmf[k];
      else if (w <= 38) earlyTerm += pmf[k];
      else if (w <= 40) fullTerm += pmf[k];
      else lateTerm += pmf[k];
    }
    return { preterm: preterm, earlyTerm: earlyTerm, fullTerm: fullTerm, lateTerm: lateTerm };
  }

  // Daily PMF: array indexed by GA day (0..314), spreading each week's
  // PMF evenly over its 7 days. Days < 140 are zero.
  function dailyPmf(pmf) {
    var daily = [];
    for (var d = 0; d <= WEEK_MAX * 7 + 6; d++) daily.push(0);
    for (var k = 0; k < pmf.length; k++) {
      var v = pmf[k] / 7;
      for (var j = 0; j < 7; j++) daily[(WEEK_MIN + k) * 7 + j] = v;
    }
    return daily;
  }

  // Landmark conditioning on still being pregnant at today's GA
  // (gaDays, integer). Renormalizes the remaining daily PMF by
  // survival-to-today. Returns null when no mass remains (beyond range).
  // Quantiles are interpolated within the median day the same way as
  // the weekly quantile (CDF linear within the day).
  function conditionFromToday(pmf, gaDays) {
    var daily = dailyPmf(pmf);
    var remaining = 0;
    for (var d = gaDays; d < daily.length; d++) remaining += daily[d];
    if (!(remaining > 1e-12)) return null;
    var cond = [];
    for (var d2 = 0; d2 < daily.length; d2++) {
      cond.push(d2 >= gaDays ? daily[d2] / remaining : 0);
    }
    function qDay(q) {
      var cum = 0, prev = 0;
      for (var i = 0; i < cond.length; i++) {
        prev = cum;
        cum += cond[i];
        if (cum >= q) {
          var frac = cond[i] > 0 ? (q - prev) / cond[i] : 0;
          if (frac < 0) frac = 0;
          if (frac > 1) frac = 1;
          return i + frac;
        }
      }
      return daily.length - 1;
    }
    return {
      daily: cond,
      medianDays: qDay(0.5),
      q25Days: qDay(0.25),
      q75Days: qDay(0.75),
      remainingMass: remaining
    };
  }

  /* ------------------------------------------------------------------ */
  /* Dates (UTC day arithmetic — no timezone surprises)                  */
  /* ------------------------------------------------------------------ */

  // "YYYY-MM-DD" -> UTC ms at midnight. Returns null on bad input.
  function parseDate(str) {
    if (!str || typeof str !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var chk = new Date(ms);
    if (chk.getUTCFullYear() !== +m[1] || chk.getUTCMonth() !== +m[2] - 1 ||
        chk.getUTCDate() !== +m[3]) return null;
    return ms;
  }

  function toDateInput(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }

  function fmtDate(ms) {
    return new Date(ms).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      timeZone: 'UTC'
    });
  }

  function fmtDateShort(ms) {
    return new Date(ms).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'UTC'
    });
  }

  function addDays(ms, n) { return ms + n * DAY_MS; }

  function daysBetween(aMs, bMs) {
    return Math.round((bMs - aMs) / DAY_MS);
  }

  // Today's calendar day as UTC ms (from the user's local date).
  function todayMs() {
    var n = new Date();
    return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  }

  // GA today as { w, d } from LMP (UTC ms).
  function gaToday(lmpMs, tMs) {
    var days = daysBetween(lmpMs, tMs);
    return { w: Math.floor(days / 7), d: days - Math.floor(days / 7) * 7, days: days };
  }

  // { w, d } from a (rounded) GA day count.
  function weeksDays(totalDays) {
    var r = Math.round(totalDays);
    return { w: Math.floor(r / 7), d: r - Math.floor(r / 7) * 7, days: r };
  }

  // Calendar guardrails (v1 spec §10), recomputed from today:
  // LMP: 314 days ago (44w6d) .. today. EDD: 34 days ago .. 280 days out.
  function guardrails(tMs) {
    return {
      lmpMin: addDays(tMs, -314), lmpMax: tMs,
      eddMin: addDays(tMs, -34), eddMax: addDays(tMs, 280)
    };
  }

  /* ------------------------------------------------------------------ */
  /* Profile -> model features                                           */
  /* ------------------------------------------------------------------ */

  // profile: { ageBand, bmiBand, plurality, firstBirth, smoking,
  //   chronicHTN, pregHTN, preDiab, gestDiab, prevPreterm, fertilityTx,
  //   latePrenatalCare, prevCesarean, sex, race }
  // Defaults are the statistical reference: ALL features zero (age
  // 25–34, BMI normal, singleton, NOT first birth, female, White, no to
  // every condition). VERIFIED against FeatureEncoding.swift: the app's
  // PregnancyProfile defaults are firstPregnancy = false, ageProvided =
  // false, bmiProvided = false, race = .notSpecified, infantSex =
  // .unknown — i.e. exactly this all-zero reference. (A first-birth
  // default would give 40w4d / 39w3d–41w6d / 3.1% preterm instead.)
  function featuresFromProfile(p) {
    var f = {};
    var names = [
      'ageUnder20', 'age20to24', 'age35to39', 'age40plus',
      'bmiUnder', 'bmiOver', 'bmiObese',
      'smoking', 'chronicHTN', 'pregHTN', 'preDiab', 'gestDiab',
      'prevPreterm', 'fertilityTx', 'firstBirth', 'latePrenatalCare',
      'male', 'raceBlack', 'raceHispanic', 'raceAsian', 'raceAIAN',
      'raceOther', 'prevCesarean'
    ];
    names.forEach(function (n) { f[n] = 0; });
    if (p.ageBand === 'under20') f.ageUnder20 = 1;
    else if (p.ageBand === '20to24') f.age20to24 = 1;
    else if (p.ageBand === '35to39') f.age35to39 = 1;
    else if (p.ageBand === '40plus') f.age40plus = 1;
    if (p.bmiBand === 'under') f.bmiUnder = 1;
    else if (p.bmiBand === 'over') f.bmiOver = 1;
    else if (p.bmiBand === 'obese') f.bmiObese = 1;
    if (p.firstBirth) f.firstBirth = 1;
    if (p.smoking) f.smoking = 1;
    if (p.chronicHTN) f.chronicHTN = 1;
    if (p.pregHTN) f.pregHTN = 1;
    if (p.preDiab) f.preDiab = 1;
    if (p.gestDiab) f.gestDiab = 1;
    if (p.prevPreterm) f.prevPreterm = 1;
    if (p.fertilityTx) f.fertilityTx = 1;
    if (p.latePrenatalCare) f.latePrenatalCare = 1;
    if (p.prevCesarean) f.prevCesarean = 1;
    if (p.sex === 'male') f.male = 1;
    if (p.race === 'black') f.raceBlack = 1;
    else if (p.race === 'hispanic') f.raceHispanic = 1;
    else if (p.race === 'asian') f.raceAsian = 1;
    else if (p.race === 'aian') f.raceAIAN = 1;
    else if (p.race === 'other') f.raceOther = 1;
    return f;
  }

  function defaultProfile() {
    return {
      mode: 'edd', dateStr: '',
      eddDateStr: '', lmpDateStr: '', // each mode keeps its own date (see below)
      ageBand: '25to34', bmi: null, // null BMI -> normal band
      plurality: 'singleton', firstBirth: false, smoking: false,
      chronicHTN: false, pregHTN: false, preDiab: false, gestDiab: false,
      prevPreterm: false, fertilityTx: false, latePrenatalCare: false,
      prevCesarean: false, sex: 'female', race: 'white',
      scenario: 'spont'
    };
  }

  // Per-mode dates (FeatureEncoding.swift): each mode keeps its own
  // stored date; the modes are NOT connected and switching NEVER
  // converts. A mode with no stored date shows an empty picker (the
  // app shows today until picked; the web shows the empty picker with
  // the same guardrails). dateStr is always the ACTIVE mode's date.
  function modeDateStr(p) {
    return p.mode === 'edd' ? (p.eddDateStr || '') : (p.lmpDateStr || '');
  }
  function setModeDate(p, mode, str) {
    if (mode === 'edd') p.eddDateStr = str || '';
    else p.lmpDateStr = str || '';
    if (p.mode === mode) p.dateStr = str || '';
  }

  function bmiBand(bmi) {
    if (bmi == null || isNaN(bmi)) return 'normal';
    if (bmi < 18.5) return 'under';
    if (bmi < 25) return 'normal';
    if (bmi < 30) return 'over';
    return 'obese';
  }

  /* ------------------------------------------------------------------ */
  /* Full prediction (v1 spec §10 states)                                */
  /* ------------------------------------------------------------------ */

  // NOTE (verified against HazardModel.swift): there is NO clamp on
  // quantiles. Swift's quantile() interpolates linearly within the
  // median week, so in the extreme edge case (readjusted at GA 44w6d)
  // the median lands at 314.5 days and rounds to 45w0d — exactly what
  // the app shows. The PMF itself still ends at week 44.

  // Returns one of:
  //  { state:'nodates' }
  //  { state:'beyond', eddMs, ga }
  //  { state:'normal', ... } | { state:'readjusted', ... }
  // Common numeric fields: lmpMs, eddMs, ga, medianDays, medianDateMs,
  // q25Days, q75Days, q25DateMs, q75DateMs, terms {preterm, earlyTerm,
  // fullTerm, lateTerm}, daily (daily PMF array for the chart), pmf
  // (weekly PMF), pSpont, pInduced (cumulative incidence shares).
  // Readjusted adds: origMedianDateMs, origMedianDays.
  function predict(model, profile, tMs) {
    if (tMs == null) tMs = todayMs();
    if (!profile.dateStr) return { state: 'nodates' };
    var refMs = parseDate(profile.dateStr);
    if (refMs == null) return { state: 'nodates' };
    var lmpMs = profile.mode === 'lmp' ? refMs : addDays(refMs, -280);
    var eddMs = addDays(lmpMs, 280);
    var ga = gaToday(lmpMs, tMs);
    if (ga.days >= 45 * 7) return { state: 'beyond', eddMs: eddMs, ga: ga, lmpMs: lmpMs };
    var p = Object.assign({}, profile);
    p.bmiBand = bmiBand(profile.bmi);
    var features = featuresFromProfile(p);
    var dist = distributions(model, features, p.plurality);
    var pmf = dist[profile.scenario] || dist.spont;
    var medianDays = quantileDays(pmf, 0.5);
    var q25Days = quantileDays(pmf, 0.25);
    var q75Days = quantileDays(pmf, 0.75);
    var medianDateMs = addDays(lmpMs, Math.round(medianDays));
    var base = {
      lmpMs: lmpMs, eddMs: eddMs, ga: ga,
      medianDays: medianDays, medianDateMs: medianDateMs,
      q25Days: q25Days, q75Days: q75Days,
      q25DateMs: addDays(lmpMs, Math.round(q25Days)),
      q75DateMs: addDays(lmpMs, Math.round(q75Days)),
      terms: termBreakdown(pmf),
      daily: dailyPmf(pmf), pmf: pmf,
      pSpont: dist.pSpont, pInduced: dist.pInduced
    };
    if (tMs <= medianDateMs) {
      base.state = 'normal';
      return base;
    }
    // Today has passed the original median date: landmark-condition.
    var cond = conditionFromToday(pmf, ga.days);
    if (!cond) return { state: 'beyond', eddMs: eddMs, ga: ga, lmpMs: lmpMs };
    base.state = 'readjusted';
    base.origMedianDays = medianDays;
    base.origMedianDateMs = medianDateMs;
    base.medianDays = cond.medianDays;
    base.medianDateMs = addDays(lmpMs, Math.round(cond.medianDays));
    base.q25Days = cond.q25Days;
    base.q75Days = cond.q75Days;
    base.q25DateMs = addDays(lmpMs, Math.round(cond.q25Days));
    base.q75DateMs = addDays(lmpMs, Math.round(cond.q75Days));
    base.daily = cond.daily;
    base.terms = termBreakdownFromDaily(cond.daily);
    return base;
  }

  // Term breakdown from a daily PMF (used for the conditioned view) —
  // same four bands as termBreakdown: <37w, 37–38w, 39–40w, >=41w.
  function termBreakdownFromDaily(daily) {
    var preterm = 0, earlyTerm = 0, fullTerm = 0, lateTerm = 0;
    for (var d = 0; d < daily.length; d++) {
      if (d < 37 * 7) preterm += daily[d];
      else if (d < 39 * 7) earlyTerm += daily[d];
      else if (d < 41 * 7) fullTerm += daily[d];
      else lateTerm += daily[d];
    }
    return { preterm: preterm, earlyTerm: earlyTerm, fullTerm: fullTerm, lateTerm: lateTerm };
  }

  /* ------------------------------------------------------------------ */
  /* UI (browser only)                                                   */
  /* ------------------------------------------------------------------ */

  var Guesstation = {
    sigmoid: sigmoid,
    computeHazards: computeHazards,
    netPmf: netPmf,
    decompose: decompose,
    distributions: distributions,
    quantileDays: quantileDays,
    termBreakdown: termBreakdown,
    dailyPmf: dailyPmf,
    conditionFromToday: conditionFromToday,
    parseDate: parseDate,
    toDateInput: toDateInput,
    fmtDate: fmtDate,
    fmtDateShort: fmtDateShort,
    addDays: addDays,
    daysBetween: daysBetween,
    todayMs: todayMs,
    gaToday: gaToday,
    weeksDays: weeksDays,
    guardrails: guardrails,
    featuresFromProfile: featuresFromProfile,
    defaultProfile: defaultProfile,
    modeDateStr: modeDateStr,
    setModeDate: setModeDate,
    bmiBand: bmiBand,
    predict: predict,
    WEEK_MIN: WEEK_MIN,
    WEEK_MAX: WEEK_MAX
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Guesstation;
  }
  if (typeof window !== 'undefined') {
    window.Guesstation = Guesstation;
  }

  if (typeof document === 'undefined') return; // Node: math only

  var MODEL = null;
  var PROFILE = defaultProfile();
  var STORE_KEY = 'guesstation-web-profile-v1';

  function $(id) { return document.getElementById(id); }

  function loadStored() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      PROFILE = Object.assign(defaultProfile(), saved);
      // Migrate pre-per-mode saves: a lone dateStr belonged to the
      // saved mode.
      if (saved.dateStr && !saved.eddDateStr && !saved.lmpDateStr) {
        setModeDate(PROFILE, PROFILE.mode, saved.dateStr);
      }
    } catch (e) { /* ignore corrupt storage */ }
  }

  function saveStored() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(PROFILE)); } catch (e) {}
  }

  function readForm() {
    var mode = document.querySelector('input[name="dateMode"]:checked');
    PROFILE.mode = mode ? mode.value : 'edd';
    PROFILE.dateStr = $('refDate').value || '';
    setModeDate(PROFILE, PROFILE.mode, PROFILE.dateStr);
    var age = document.querySelector('input[name="ageBand"]:checked');
    PROFILE.ageBand = age ? age.value : '25to34';
    var pl = document.querySelector('input[name="plurality"]:checked');
    PROFILE.plurality = pl ? pl.value : 'singleton';
    var fb = document.querySelector('input[name="firstBirth"]:checked');
    PROFILE.firstBirth = fb ? fb.value === 'yes' : true;
    var sm = document.querySelector('input[name="smoking"]:checked');
    PROFILE.smoking = sm ? sm.value === 'yes' : false;
    var sx = document.querySelector('input[name="sex"]:checked');
    PROFILE.sex = sx ? sx.value : 'female';
    PROFILE.race = $('raceSel').value || 'white';
    PROFILE.chronicHTN = $('cChronicHTN').checked;
    PROFILE.pregHTN = $('cPregHTN').checked;
    PROFILE.preDiab = $('cPreDiab').checked;
    PROFILE.gestDiab = $('cGestDiab').checked;
    PROFILE.prevPreterm = $('cPrevPreterm').checked;
    PROFILE.fertilityTx = $('cFertilityTx').checked;
    PROFILE.latePrenatalCare = $('cLatePrenatal').checked;
    PROFILE.prevCesarean = $('cPrevCesarean').checked;
    var sc = document.querySelector('input[name="scenario"]:checked');
    PROFILE.scenario = sc ? sc.value : 'spont';
  }

  function syncBmiFromHeightWeight() {
    var hVal = parseFloat($('heightVal').value);
    var wVal = parseFloat($('weightVal').value);
    if (!hVal || !wVal) return;
    var hM = $('heightUnit').value === 'cm' ? hVal / 100 : hVal * 0.0254;
    var wKg = $('weightUnit').value === 'kg' ? wVal : wVal * 0.45359237;
    if (hM > 0) {
      PROFILE.bmi = wKg / (hM * hM);
      $('bmiSlider').value = Math.max(15, Math.min(45, PROFILE.bmi));
      updateBmiReadout();
    }
  }

  function bmiLabel(band) {
    return { under: 'Underweight', normal: 'Normal', over: 'Overweight', obese: 'Obese' }[band] || 'Normal';
  }

  function updateBmiReadout() {
    var band = bmiBand(PROFILE.bmi);
    $('bmiReadout').textContent = PROFILE.bmi == null
      ? 'BMI not entered — using average'
      : 'BMI ' + PROFILE.bmi.toFixed(1) + ' — ' + bmiLabel(band);
  }

  function applyDateGuardrails() {
    var g = guardrails(todayMs());
    var input = $('refDate');
    if (PROFILE.mode === 'lmp') {
      input.min = toDateInput(g.lmpMin);
      input.max = toDateInput(g.lmpMax);
      $('dateHint').textContent = 'Your last period, between ' + fmtDateShort(g.lmpMin) +
        ' and today.';
    } else {
      input.min = toDateInput(g.eddMin);
      input.max = toDateInput(g.eddMax);
      $('dateHint').textContent = 'Your due date, between ' + fmtDateShort(g.eddMin) +
        ' and ' + fmtDateShort(g.eddMax) + '.';
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function pct(x) { return (x * 100).toFixed(1) + '%'; }

  function termBarsHtml(terms) {
    function bar(label, val, cls) {
      return '<div class="term-row"><span class="term-label">' + label + '</span>' +
        '<div class="term-track"><div class="term-fill ' + cls + '" style="width:' +
        Math.max(0, Math.min(100, val * 100)).toFixed(1) + '%"></div></div>' +
        '<span class="term-val">' + pct(val) + '</span></div>';
    }
    return '<h3>How similar pregnancies ended up</h3>' +
      bar('Preterm — before 37 weeks', terms.preterm, 'pre') +
      bar('Early term — 37 to 38 weeks', terms.earlyTerm, 'tm') +
      bar('Full term — 39 to 40 weeks', terms.fullTerm, 'tm') +
      bar('Late term — 41 weeks or later', terms.lateTerm, 'post');
  }

  // Daily-% chart as inline SVG. x covers GA days 140..314 (20w0d..44w6d).
  function chartSvg(result) {
    var W = 720, H = 190, PADL = 8, PADR = 8, PADT = 12, PADB = 24;
    var daily = result.daily;
    var maxV = 0;
    for (var d = 140; d <= 314; d++) if (daily[d] > maxV) maxV = daily[d];
    if (maxV <= 0) maxV = 1;
    var x0 = PADL, x1 = W - PADR, y0 = PADT, y1 = H - PADB;
    function X(day) { return x0 + (day - 140) / (314 - 140) * (x1 - x0); }
    function Y(v) { return y1 - (v / maxV) * (y1 - y0); }
    var s = '';
    // likely-window shading (x clamped to the 44w6d chart edge; the
    // numbers themselves are unclamped, per HazardModel.swift)
    var wx0 = X(Math.min(Math.round(result.q25Days), 314)), wx1 = X(Math.min(Math.round(result.q75Days), 314));
    s += '<rect x="' + wx0.toFixed(1) + '" y="' + y0 + '" width="' + Math.max(0, wx1 - wx0).toFixed(1) +
      '" height="' + (y1 - y0) + '" fill="#dcefe6"/>';
    // daily bars
    for (var d2 = 140; d2 <= 314; d2++) {
      var v = daily[d2];
      if (v <= 0) continue;
      var bx = X(d2), bw = (x1 - x0) / 175;
      s += '<rect x="' + bx.toFixed(2) + '" y="' + Y(v).toFixed(1) + '" width="' +
        Math.max(0.6, bw - 0.4).toFixed(2) + '" height="' + Math.max(0, y1 - Y(v)).toFixed(1) +
        '" fill="#5b8a72"><title>' + fmtDateShort(addDays(result.lmpMs, d2)) +
        ' — ' + (v * 100).toFixed(2) + '%</title></rect>';
    }
    // median line (x clamped to the chart edge, numbers unclamped)
    var mx = X(Math.min(Math.round(result.medianDays), 314));
    s += '<line x1="' + mx.toFixed(1) + '" y1="' + y0 + '" x2="' + mx.toFixed(1) + '" y2="' + y1 +
      '" stroke="#1d4d33" stroke-width="2"/>';
    // baseline + week labels
    s += '<line x1="' + x0 + '" y1="' + y1 + '" x2="' + x1 + '" y2="' + y1 + '" stroke="#999"/>';
    for (var w = 20; w <= 44; w += 2) {
      var lx = X(w * 7);
      s += '<text x="' + lx.toFixed(1) + '" y="' + (H - 8) + '" font-size="10" fill="#666" text-anchor="middle">' + w + 'w</text>';
    }
    s += '<text x="' + mx.toFixed(1) + '" y="' + (y0 + 10) + '" font-size="10" fill="#1d4d33" text-anchor="middle">most likely</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily chance of delivery by date">' +
      s + '</svg>' +
      '<p class="chart-note">Each bar is one day. The shaded band is the likely window; the line is the most likely date.</p>';
  }

  function scenarioExplainer(sc) {
    return {
      spont: 'If labor starts on its own — no induction or scheduled birth.',
      all: 'What actually happens, including inductions and scheduled births.'
    }[sc] || '';
  }

  function render() {
    if (!MODEL) return;
    readForm();
    saveStored();
    applyDateGuardrails();
    updateBmiReadout();
    $('scenarioNote').textContent = scenarioExplainer(PROFILE.scenario);
    var out = $('results');
    var res = predict(MODEL, PROFILE, todayMs());
    if (res.state === 'nodates') {
      out.innerHTML = '<div class="card muted"><p>Enter your due date or last period above to see your personalized estimate.</p></div>';
      return;
    }
    var gaLine = '<p class="ga-line">You are ' + res.ga.w + 'w' + res.ga.d + 'd today.</p>';
    if (res.state === 'beyond') {
      out.innerHTML =
        '<div class="card warn"><p><strong>These dates are past the range this model covers — birth records get too sparse after 44 weeks.</strong></p>' +
        '<p>Your due date (EDD): ' + esc(fmtDate(res.eddMs)) + '</p>' +
        '<p><button type="button" class="btn" id="checkDatesBtn">Check my dates</button></p></div>';
      $('checkDatesBtn').addEventListener('click', function () {
        $('refDate').focus();
        $('refDate').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }
    var h = '';
    if (res.state === 'readjusted') {
      h += '<div class="card"><p class="caption">Readjusted from today — original estimate was ' +
        esc(fmtDate(res.origMedianDateMs)) + '.</p>' +
        '<div class="kv"><span>Previous prediction</span><strong>' + esc(fmtDate(res.origMedianDateMs)) + '</strong></div>' +
        '<div class="kv big"><span>Readjusted prediction</span><strong>' + esc(fmtDate(res.medianDateMs)) + '</strong></div>' +
        '<div class="kv"><span>Likely window</span><strong>' + esc(fmtDate(res.q25DateMs)) + ' – ' + esc(fmtDate(res.q75DateMs)) + '</strong></div>' +
        gaLine +
        '<p class="note">Half of similar pregnancies still pregnant today deliver between ' +
        esc(fmtDate(res.q25DateMs)) + ' and ' + esc(fmtDate(res.q75DateMs)) + '.</p></div>';
    } else {
      h += '<div class="card"><div class="kv big"><span>Most likely around</span><strong>' +
        esc(fmtDate(res.medianDateMs)) + '</strong></div>' +
        '<div class="kv"><span>Likely window</span><strong>' + esc(fmtDate(res.q25DateMs)) + ' – ' + esc(fmtDate(res.q75DateMs)) + '</strong></div>' +
        gaLine +
        '<p class="note">Half of similar pregnancies deliver between ' +
        esc(fmtDate(res.q25DateMs)) + ' and ' + esc(fmtDate(res.q75DateMs)) + '.</p></div>';
    }
    h += '<div class="card">' + termBarsHtml(res.terms) + '</div>';
    h += '<div class="card"><h3>Chance by day</h3>' + chartSvg(res) + '</div>';
    h += '<p class="edd-line">Your due date (EDD): ' + esc(fmtDate(res.eddMs)) + '</p>';
    out.innerHTML = h;
  }

  function setFormFromProfile() {
    var modeRadio = document.querySelector('input[name="dateMode"][value="' + PROFILE.mode + '"]');
    if (modeRadio) modeRadio.checked = true;
    $('refDate').value = modeDateStr(PROFILE);
    PROFILE.dateStr = modeDateStr(PROFILE);
    var ageRadio = document.querySelector('input[name="ageBand"][value="' + PROFILE.ageBand + '"]');
    if (ageRadio) ageRadio.checked = true;
    var plRadio = document.querySelector('input[name="plurality"][value="' + PROFILE.plurality + '"]');
    if (plRadio) plRadio.checked = true;
    var fbRadio = document.querySelector('input[name="firstBirth"][value="' + (PROFILE.firstBirth ? 'yes' : 'no') + '"]');
    if (fbRadio) fbRadio.checked = true;
    var smRadio = document.querySelector('input[name="smoking"][value="' + (PROFILE.smoking ? 'yes' : 'no') + '"]');
    if (smRadio) smRadio.checked = true;
    var sxRadio = document.querySelector('input[name="sex"][value="' + PROFILE.sex + '"]');
    if (sxRadio) sxRadio.checked = true;
    $('raceSel').value = PROFILE.race || 'white';
    $('cChronicHTN').checked = !!PROFILE.chronicHTN;
    $('cPregHTN').checked = !!PROFILE.pregHTN;
    $('cPreDiab').checked = !!PROFILE.preDiab;
    $('cGestDiab').checked = !!PROFILE.gestDiab;
    $('cPrevPreterm').checked = !!PROFILE.prevPreterm;
    $('cFertilityTx').checked = !!PROFILE.fertilityTx;
    $('cLatePrenatal').checked = !!PROFILE.latePrenatalCare;
    $('cPrevCesarean').checked = !!PROFILE.prevCesarean;
    var scRadio = document.querySelector('input[name="scenario"][value="' + PROFILE.scenario + '"]');
    if (scRadio) scRadio.checked = true;
    if (PROFILE.bmi != null) {
      $('bmiSlider').value = Math.max(15, Math.min(45, PROFILE.bmi));
    }
  }

  function init() {
    loadStored();
    setFormFromProfile();
    applyDateGuardrails();
    updateBmiReadout();
    var form = $('profileForm');
    form.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'bmiSlider') {
        PROFILE.bmi = parseFloat(e.target.value);
        $('heightVal').value = '';
        $('weightVal').value = '';
      }
      render();
    });
    form.addEventListener('change', function (e) {
      if (e.target && (e.target.id === 'heightVal' || e.target.id === 'weightVal' ||
          e.target.id === 'heightUnit' || e.target.id === 'weightUnit')) {
        syncBmiFromHeightWeight();
      }
      if (e.target && e.target.name === 'dateMode') {
        // Switching modes NEVER converts (FeatureEncoding.swift): each
        // mode keeps its own stored date. Save the current input into
        // the old mode, then show the new mode's own stored date
        // (or an empty picker if it has never been picked).
        var oldMode = PROFILE.mode;
        setModeDate(PROFILE, oldMode, $('refDate').value || '');
        PROFILE.mode = e.target.value;
        $('refDate').value = modeDateStr(PROFILE);
        PROFILE.dateStr = modeDateStr(PROFILE);
      }
      render();
    });
    fetch('GestationModel.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        MODEL = json;
        render();
      })
      .catch(function () {
        $('results').innerHTML = '<div class="card warn"><p><strong>Could not load the prediction model.</strong></p>' +
          '<p>This page needs to be served over http(s) — for example, open it from its hosted URL rather than as a local file. ' +
          'If you are previewing locally, run <code>python3 -m http.server</code> in this folder and open http://localhost:8000.</p></div>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
