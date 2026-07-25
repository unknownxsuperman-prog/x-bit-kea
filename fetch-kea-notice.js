#!/usr/bin/env node
/**
 * fetch-kea-notice.js
 * STAGE 1 — find the KEA notice that announces mock / provisional / round-1
 * dates, by predicting the URL directly rather than scraping the whole
 * announcements page every run.
 *
 * Known confirmed pattern (from a real UGCET 2026 choice-entry PDF):
 *   https://cetonline.karnataka.gov.in/keawebentry456/ugcet2026/UGCET_CHOICE_NOTE_ENG_15072026english.pdf
 *                                       ^session-id?    ^year    ^doctype        ^stream ^DDMMYYYY  ^lang
 *
 * UNKNOWNS still to confirm:
 *   - whether "keawebentry456" is fixed for the whole cycle or changes per
 *     notice/session — if it changes, date-only prediction won't be enough
 *     and you'll need to probe a small ID range too.
 *   - the exact doc-type prefix for the SCHEDULE notice (the one that states
 *     mock/provisional/round-1 dates as readable text) — this is a DIFFERENT
 *     document from the CHOICE_NOTE one already decoded, so the candidates
 *     below are placeholders. Replace/extend once you find a real one.
 */

const fs = require('fs');
const path = require('path');

const YEAR = process.env.KEA_YEAR || '2026';
const SESSION_ID = process.env.KEA_SESSION_ID || 'keawebentry456'; // TODO: confirm if this ever changes
const STREAM = process.env.KEA_STREAM || 'ENG';
const LANG = 'english';

// TODO: replace with the real doc-type prefix once you find a schedule-notice URL
const DOC_TYPE_CANDIDATES = [
  'UGCET_SCHEDULE',
  'UGCET_ROUND_SCHEDULE',
  'UGCET_MOCK_ALLOTMENT_SCHEDULE',
  'UGCET_COUNSELLING_SCHEDULE',
  'UGCET_NOTIFICATION'
];

function formatDDMMYYYY(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}${mm}${yyyy}`;
}

function buildCandidateUrl(docType, date) {
  const dateStr = formatDDMMYYYY(date);
  return `https://cetonline.karnataka.gov.in/${SESSION_ID}/ugcet${YEAR}/${docType}_${STREAM}_${dateStr}${LANG}.pdf`;
}

/** Lightweight HEAD probe — no CORS restriction, this runs server-side. */
async function probe(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Try every doc-type candidate across a window of dates around `centerDate`.
 * KEA revises dates often — don't rely on a single exact-day guess.
 */
async function probeForNotice(centerDate, windowDays = 7) {
  for (let offset = -windowDays; offset <= windowDays; offset++) {
    const candidateDate = new Date(centerDate);
    candidateDate.setDate(candidateDate.getDate() + offset);
    for (const docType of DOC_TYPE_CANDIDATES) {
      const url = buildCandidateUrl(docType, candidateDate);
      const found = await probe(url);
      if (found) {
        console.log(`[kea-watch] FOUND: ${url}`);
        return url;
      }
    }
  }
  return null;
}

/**
 * Fallback discovery — only used if prediction fails. Fetches the plain
 * announcements page (server-side, so CORS doesn't apply) and scans for PDF
 * links. Slower/heavier than prediction, kept as a safety net only, and
 * useful for manually confirming real doc-type prefixes.
 */
async function discoverFromAnnouncementsPage() {
  const pageUrl = 'https://cetonline.karnataka.gov.in/kea/';
  try {
    const res = await fetch(pageUrl);
    const html = await res.text();
    const pdfLinks = Array.from(html.matchAll(/href=["']([^"']+\.pdf)["']/gi)).map(m => m[1]);
    return pdfLinks;
  } catch (e) {
    console.error('[kea-watch] announcements page fetch failed:', e.message);
    return [];
  }
}

async function main() {
  const today = new Date();
  console.log(`[kea-watch] probing for KEA ${YEAR} schedule notice around ${today.toISOString().slice(0, 10)}...`);

  let noticeUrl = await probeForNotice(today, 7);

  if (!noticeUrl) {
    console.log('[kea-watch] prediction failed — falling back to announcements page scan.');
    const links = await discoverFromAnnouncementsPage();
    console.log(`[kea-watch] found ${links.length} pdf link(s) on announcements page (inspect these to refine DOC_TYPE_CANDIDATES):`);
    links.forEach(l => console.log('  ' + l));
  }

  // TODO (Stage 1 continued, once noticeUrl is found):
  //   1. download the PDF (fetch + arrayBuffer, see fetch-kea-cutoffs.js for the pattern)
  //   2. parse it with pdf-parse to get raw text
  //   3. regex/extract the mock / provisional / round-1 dates from that text
  //      — your parser tools plug in here
  //   4. merge { mock, provisional, round1 } (as "YYYY-MM-DD" strings) into the
  //      result object below before it's written out

  const outPath = path.join(__dirname, '..', 'data', 'kea-dates.json');
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const result = {
    ...existing,
    lastProbeAt: new Date().toISOString(),
    lastNoticeUrl: noticeUrl || existing.lastNoticeUrl || null
    // mock / provisional / round1 date fields intentionally left for your parser to fill in
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`[kea-watch] wrote ${outPath}`);
}

main();
