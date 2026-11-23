# Guesstation — web version

A static, dependency-free web port of the Guesstation iOS app's
personalized due-date predictor (v1). No backend, no build step, no
external requests: plain `index.html` + `app.js` + the shipped model
JSON. Answers stay in the visitor's browser (localStorage only).

## Files

- `index.html` — single-page form + results (mobile-friendly).
- `app.js` — the predictor: model math, calendar guardrails, readjustment, chart.
- `GestationModel.json` — the shipped model, copied as-is (CDC Natality 2023, n=514,352; competing-risks discrete-time hazard, spontaneous vs indicated).
- `VALIDATION.md` — what was checked against the shipped iOS app and the numbers observed.

## Deploy (free) — GitHub Pages

1. Create a repo on GitHub, e.g. `guesstation-web` (account: `omaksin-bit`).
2. Push the contents of this folder to the repo's `main` branch (root of the repo, not a subfolder).
3. Repo → **Settings → Pages** → under "Build and deployment", Source: **Deploy from a branch** → Branch: `main`, folder: `/ (root)` → Save.
4. Live in about a minute at `https://omaksin-bit.github.io/guesstation-web/` (replace `guesstation-web` with your repo name).

No build step is needed — the site is dependency-free static files.

Alternative: drag this folder onto [Netlify Drop](https://app.netlify.com/drop) for a free live URL the same way.

## Preview locally

```sh
cd /path/to/web
python3 -m http.server
# open http://localhost:8000
```

Opening `index.html` directly as a local file will not work: the page
loads `GestationModel.json` with `fetch`, which browsers block from
`file://` URLs. Serve it over http(s) (above) or use the hosted URL.

## Known v1 gaps

- **No affirmations.** The affirmation fragment pools live in Swift on
  the Mac, so this web version is predictor-only.
- The model is classical statistics (penalized pooled logistic
  discrete-time hazard), **not ML** — the page never calls it ML.
- Math was verified against the shipped Swift sources
  (`HazardModel.swift`, `FeatureEncoding.swift`) on 2026-11-22 — see
  `VALIDATION.md` §7 for the item-by-item check. Two things remain
  spec-verified rather than Swift-verified because `ContentView.swift`
  was not available: the readjustment trigger and the calendar
  guardrails (both from the v1 spec §10).
