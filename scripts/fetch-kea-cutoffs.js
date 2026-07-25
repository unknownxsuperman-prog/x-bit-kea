#!/usr/bin/env node
/**
 * fetch-kea-cutoffs.js
 * STAGE 2 — once data/kea-dates.json has a real date for a given round
 * (mock / provisional / round1), build the cutoff-list PDF URL for that
 * round, download it, and extract raw text for your parser to structure.
 *
 * Usage:
 *   node scripts/fetch-kea-cutoffs.js mock
 *   node scripts/fetch-kea-cutoffs.js provisional
 *   node scripts/fetch-kea-cutoffs.js round1
 *
 * NOTE: the cutoff-list PDF is a DIFFERENT document type from the
 * CHOICE_NOTE one already decoded — its doc-type prefix is still unknown.
 * Update DOC_TYPE_CANDIDATES below once you find a real cutoff-list URL.
 */

const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

const YEAR = process.env.KEA_YEAR || '2026';
const SESSION_ID = process.env.KEA_SESSION_ID || 'keawebentry456';
const LANG = 'english';

// TODO: replace with real doc-type prefix(es) once a real cutoff-list URL is found
const DOC_TYPE_CANDIDATES = [
  'UGCET_MOCK_CUTOFF',
  'UGCET_CUTOFF_LIST',
  'UGCET_MOCK_ALLOTMENT_CUTOFF',
  'UGCET_ROUND_CUTOFF'
];

// matches the eng / enghk split already used in firstroundeng.js / firstroundenghk.js
const STREAM_CANDIDATES = ['ENG', 'ENGHK'];

function formatDDMMYYYY(isoDateStr) {
  // expects "YYYY-MM-DD"
  const [y, m, d] = isoDateStr.split('-');
  return `${d}${m}${y}`;
}

function buildCandidateUrl(docType, stream, isoDateStr) {
  const ddmmyyyy = formatDDMMYYYY(isoDateStr);
  return `https://cetonline.karnataka.gov.in/${SESSION_ID}/ugcet${YEAR}/${docType}_${stream}_${ddmmyyyy}${LANG}.pdf`;
}

async function probeAndDownload(isoDateStr) {
  for (const stream of STREAM_CANDIDATES) {
    for (const docType of DOC_TYPE_CANDIDATES) {
      const url = buildCandidateUrl(docType, stream, isoDateStr);
      try {
        const res = await fetch(url);
        if (res.ok) {
          console.log(`[kea-cutoffs] FOUND (${stream}): ${url}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          return { url, stream, buffer };
        }
      } catch (e) {
        // try next candidate
      }
    }
  }
  return null;
}

async function main(round) {
  const datesPath = path.join(__dirname, '..', 'data', 'kea-dates.json');
  if (!fs.existsSync(datesPath)) {
    console.error('[kea-cutoffs] data/kea-dates.json not found — run fetch-kea-notice.js first.');
    process.exit(1);
  }
  const dates = JSON.parse(fs.readFileSync(datesPath, 'utf8'));
  const isoDateStr = dates[round]; // e.g. dates.mock, dates.provisional, dates.round1
  if (!isoDateStr) {
    console.error(`[kea-cutoffs] no date known yet for round "${round}" — nothing to probe. Run fetch-kea-notice.js once the schedule notice parser is filled in.`);
    process.exit(1);
  }

  const found = await probeAndDownload(isoDateStr);
  if (!found) {
    console.error(`[kea-cutoffs] could not locate the ${round} cutoff PDF for ${isoDateStr}. Update DOC_TYPE_CANDIDATES once you know the real prefix.`);
    process.exit(1);
  }

  const parsed = await pdf(found.buffer);
  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const rawTextPath = path.join(dataDir, `${round}-cutoff-raw.txt`);
  fs.writeFileSync(rawTextPath, parsed.text);
  console.log(`[kea-cutoffs] wrote raw extracted text to ${rawTextPath} (${parsed.text.length} chars)`);

  // TODO: this is where YOUR parser plugs in — turn parsed.text into the same
  // { id, name, location, branches: { branchName: { category: cutoff } } }
  // shape used by firstroundeng.js / firstroundenghk.js, then write it out, e.g.:
  //
  //   const structured = yourParser(parsed.text);
  //   fs.writeFileSync(path.join(dataDir, `${round}cutoff${found.stream === 'ENGHK' ? 'hk' : ''}.json`),
  //     'window.XOS_CUTOFF = ' + JSON.stringify(structured) + ';');
  //
  // (writing it as `window.XOS_CUTOFF = ...` matches the existing loadDataset()
  // convention in index.html — see loadDataset() there for how it's consumed.)
}

const round = process.argv[2] || 'mock';
main(round);
