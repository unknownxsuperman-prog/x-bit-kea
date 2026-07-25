# kea-watch

Server-side pipeline (GitHub Actions, no CORS restriction) that:
1. **Stage 1** — predicts and probes candidate URLs for the KEA schedule notice, to learn the mock / provisional / round-1 dates
2. **Stage 2** — once a date is known, predicts and probes the cutoff-list PDF for that round, downloads it, and extracts raw text
3. Commits the results into `data/`, so GitHub Pages can serve them as ordinary static files — `index.html` (Proton) fetches them same-origin, no CORS involved at all.

## Where this goes in your repo

Drop this whole folder (`package.json`, `scripts/`, `.github/workflows/kea-watch.yml`, `data/`) into the **same repo as `index.html`** (the x-bit-kea repo). GitHub Actions workflows only run from `.github/workflows/` in the repo root, so that path must be exact.

## Setup

```bash
npm install
```

Then either:
- push to GitHub and let the scheduled workflow run automatically, or
- trigger it manually from the repo's **Actions** tab (workflow_dispatch), or
- run locally to test: `npm run fetch-notice` then `node scripts/fetch-kea-cutoffs.js mock`

## What's still a TODO (intentionally left for your parser tools)

- `DOC_TYPE_CANDIDATES` in both scripts are **placeholders** — replace them once you find real notice / cutoff-list URLs (same way we decoded the `UGCET_CHOICE_NOTE_ENG_...` pattern together). Paste any new real URL you find and I'll help extend the pattern.
- Whether `keawebentry456` (the session-id segment) is fixed for the whole cycle or changes — if it changes, the scripts will need to probe an ID range too, not just dates.
- The actual date-extraction from the schedule notice's PDF text (marked `TODO` in `fetch-kea-notice.js`).
- The actual structuring of the cutoff-list PDF's raw text into the `{ id, name, location, branches: {...} }` shape (marked `TODO` in `fetch-kea-cutoffs.js`) — this is the parser you said you're building.

## Output files (once filled in)

- `data/kea-dates.json` — `{ mock, provisional, round1, lastNoticeUrl, lastProbeAt }`
- `data/mock-cutoff-raw.txt` — raw PDF text, pre-parsing
- `data/mockcutoff.json` (and `mockcutoffhk.json`) — structured, same shape as `firstroundeng.js`, once your parser is wired in
