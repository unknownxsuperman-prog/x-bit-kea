/* ══════════════════════════════════════════════════════════════════════
   logic.js — NCERT local knowledge engine for x-bit Proton
   ------------------------------------------------------------------------
   100% offline. No API calls, no network model, no LLM.
   Everything it "knows" comes from ncert_data.json, which is a structured
   extraction of the uploaded NCERT chapter (headings, paragraphs, tables),
   produced once by extract_ncert.py.

   What it does:
     1. Loads ncert_data.json (fetch of a local static file — not an API).
     2. Tokenizes every sentence in the chapter and builds a TF-IDF style
        inverted index purely in JS (same family of technique already used
        elsewhere in this app for the KCET/chat classifiers).
     3. For a user query, scores every sentence, picks the best match, then
        expands outward to a small window of neighbouring sentences from
        the same section ("look around the word") so the answer reads as
        a coherent NCERT excerpt instead of one bare line.
     4. If the matched section contains a table (e.g. Table 1.1 SI units)
        it is rendered as an HTML table under the answer.
     5. If the matched text contains a classification/relationship pattern
        ("X is classified into A, B and C" / "X consists of A and B" ...)
        it auto-draws a small SVG tree diagram from the extracted words —
        the diagram is generated from the doc text itself, nothing external.
     6. Exposes `window.NCERTEngine` (class) and a ready-made singleton
        `window.ncertEngine` that Proton's chat router calls into.
   ══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── stopwords / helpers ─────────────────────────────────────────── */
  const STOPWORDS = new Set([
    'the','a','an','of','in','on','at','to','for','and','or','is','are','was','were',
    'be','been','being','it','its','this','that','these','those','with','as','by',
    'from','which','what','whats',"what's",'who','whom','how','why','when','where',
    'does','do','did','can','could','should','would','will','shall','me','my','you',
    'your','i','we','us','tell','explain','define','definition','meaning','about',
    'please','also','than','then','so','if','into','not','no','yes','their','there',
    'they','them','he','she','him','her','has','have','had','but','all','any','some'
  ]);

  function stem(w) {
    w = w.toLowerCase();
    if (w.length > 5) {
      if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
      if (w.endsWith('ing')) return w.slice(0, -3);
      if (w.endsWith('ed')) return w.slice(0, -2);
    }
    if (w.length > 3) {
      if (w.endsWith('es')) return w.slice(0, -2);
      if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
    }
    return w;
  }
  function tokenize(text) {
    const raw = text.toLowerCase().replace(/[^a-z0-9\s%.\-]/g, ' ').split(/\s+/).filter(Boolean);
    return raw.filter(w => w.length > 1 && !STOPWORDS.has(w)).map(stem);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function highlightTerms(text, termSet) {
    return escapeHtml(text).replace(/[A-Za-z][A-Za-z0-9\-]*/g, w => {
      return termSet.has(stem(w)) ? `<b>${w}</b>` : w;
    });
  }

  const DEFINITION_RE = [
    /\bis (?:defined as|the sum of|the science of|obtained by|called)\b/i,
    /\bare (?:defined as|called|known as)\b/i,
    /\brefers? to\b/i,
    /\bis a\b|\bis an\b|\bis the\b/i
  ];
  const RELATION_RE = /([A-Za-z][A-Za-z\s]{2,40}?)\s+(?:can be|may be|is|are)?\s*(?:classified|divided|sub-divided|categorised|categorized|grouped)\s+(?:into|as)\s+([^.]+)\./i;

  /* ══════════════════════════════════════════════════════════════════
     ENGINE
     ══════════════════════════════════════════════════════════════════ */
  class NCERTEngine {
    constructor(dataUrl) {
      this.dataUrl = dataUrl;
      this.ready = false;
      this.data = null;
      this.idf = null;          // Map term -> idf weight
      this.headingTokens = [];  // per-section token Set (for topic-name boost)
      this.tables = [];         // flattened {sectionIdx, path, rows}
    }

    async load() {
      try {
        const res = await fetch(this.dataUrl);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        this.data = await res.json();
      } catch (e) {
        console.error('[NCERTEngine] could not load ' + this.dataUrl + ':', e.message);
        this.ready = false;
        return;
      }
      this._buildIndex();
      this.ready = true;
      console.info(`[NCERTEngine] ready — ${this.data.sentences.length} sentences indexed from "${this.data.chapter}"`);
    }

    _buildIndex() {
      const sentences = this.data.sentences;
      const df = new Map();
      sentences.forEach(s => {
        s._tokens = tokenize(s.text);
        s._tokenSet = new Set(s._tokens);
        for (const t of s._tokenSet) df.set(t, (df.get(t) || 0) + 1);
      });
      const N = sentences.length;
      this.idf = new Map();
      for (const [t, c] of df) this.idf.set(t, Math.log((N + 1) / (c + 0.5)));

      // per-section heading token set (topic-name boost) + table flattening
      this.data.sections.forEach((sec, i) => {
        sec._headingTokens = new Set(tokenize(sec.path.join(' ')));
        (sec.tables || []).forEach(tbl => {
          this.tables.push({ sectionIdx: i, path: sec.path, rows: tbl.rows });
        });
      });
    }

    /* score a single sentence against the query token set */
    _scoreSentence(qTokens, qSet, sent, secHeadTokens) {
      let score = 0;
      for (const t of qTokens) {
        if (sent._tokenSet.has(t)) score += (this.idf.get(t) || 1);
      }
      // heading/topic boost: query words hitting the section title matter a lot
      let headHits = 0;
      for (const t of qSet) if (secHeadTokens.has(t)) headHits++;
      score += headHits * 2.2;
      return score;
    }

    _scoreTable(qSet, tbl, secHeadTokens) {
      let score = 0;
      for (const t of qSet) if (secHeadTokens.has(t)) score += 2;
      const headerTokens = new Set(tokenize((tbl.rows[0] || []).join(' ')));
      for (const t of qSet) if (headerTokens.has(t)) score += 1.2;
      return score;
    }

    /* pull a coherent window of neighbouring sentences from the same section */
    _buildWindow(bestIdx, maxChars) {
      const sentences = this.data.sentences;
      const sec = sentences[bestIdx].section;
      let lo = bestIdx, hi = bestIdx;
      while (lo > 0 && sentences[lo - 1].section === sec) lo--;
      while (hi < sentences.length - 1 && sentences[hi + 1].section === sec) hi++;
      let start = bestIdx, end = bestIdx, chars = sentences[bestIdx].text.length;
      let turn = 0;
      while (chars < maxChars && (start > lo || end < hi)) {
        const goLeft = start > lo && (end >= hi || turn % 2 === 0);
        if (goLeft) { start--; chars += sentences[start].text.length; }
        else if (end < hi) { end++; chars += sentences[end].text.length; }
        else break;
        turn++;
      }
      return sentences.slice(start, end + 1);
    }

    /* ── main entry point ── */
    search(query) {
      if (!this.ready) return null;
      const qTokens = tokenize(query);
      if (!qTokens.length) return null;
      const qSet = new Set(qTokens);
      const sentences = this.data.sentences;
      const sections = this.data.sections;

      let best = null, bestScore = 0;
      for (const s of sentences) {
        const sc = this._scoreSentence(qTokens, qSet, s, sections[s.section]._headingTokens);
        if (sc > bestScore) { bestScore = sc; best = s; }
      }
      // minimum confidence bar so unrelated chit-chat doesn't get hijacked
      if (!best || bestScore < 1.4) return { found: false };

      const window_ = this._buildWindow(best.id, 560);
      const windowText = window_.map(s => s.text).join(' ');
      const path = sections[best.section].path;

      // is there a matching/relevant table nearby?
      let tableHtml = '';
      let bestTable = null, bestTableScore = 0;
      for (const tbl of this.tables) {
        const sc = this._scoreTable(qSet, tbl, sections[tbl.sectionIdx]._headingTokens);
        if (sc > bestTableScore) { bestTableScore = sc; bestTable = tbl; }
      }
      if (bestTable && bestTableScore >= 2) tableHtml = this._renderTable(bestTable);

      // is there a classification/relationship pattern to diagram?
      const secFullText = sections[best.section].paragraphs.join(' ');
      const rel = windowText.match(RELATION_RE) || secFullText.match(RELATION_RE);
      let diagramHtml = '';
      if (rel) diagramHtml = this._renderRelationDiagram(rel);

      const html = this._renderAnswer(path, window_, qSet, tableHtml, diagramHtml);
      const plain = windowText;
      return { found: true, html, plain, score: bestScore, path };
    }

    _renderTable(tbl) {
      const rows = tbl.rows;
      if (!rows.length) return '';
      const head = rows[0], body = rows.slice(1);
      let h = `<div style="margin-top:10px;font-family:var(--font-m);font-size:.58rem;color:var(--text-3);letter-spacing:.08em;text-transform:uppercase;">${escapeHtml(tbl.path[tbl.path.length - 1])}</div>`;
      h += `<div style="overflow-x:auto;margin-top:6px;"><table style="border-collapse:collapse;width:100%;font-size:.72rem;">`;
      h += `<thead><tr>${head.map(c => `<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border-strong);color:var(--text-0);font-weight:700;">${escapeHtml(c)}</th>`).join('')}</tr></thead>`;
      h += `<tbody>${body.map(r => `<tr>${r.map(c => `<td style="padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text-1);">${escapeHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      h += `</table></div>`;
      return h;
    }

    _renderRelationDiagram(match) {
      const root = match[1].trim().replace(/^(the|a|an)\s+/i, '');
      let items = match[2].split(/,|\band\b/i).map(s => s.trim()).filter(Boolean)
        .map(s => s.replace(/^(a|an|the)\s+/i, '').replace(/\.$/, ''));
      items = items.filter(s => s.length > 1 && s.length < 40);
      if (items.length < 2 || items.length > 6) return '';
      const boxW = 130, boxH = 40, gap = 14;
      const n = items.length;
      const totalW = n * boxW + (n - 1) * gap;
      const svgW = Math.max(totalW + 40, 300);
      const startX = (svgW - totalW) / 2;
      const rootCx = svgW / 2;
      let svg = `<svg viewBox="0 0 ${svgW} 150" style="width:100%;height:auto;margin-top:10px;display:block;" xmlns="http://www.w3.org/2000/svg">`;
      svg += `<rect x="${rootCx - 75}" y="6" width="150" height="${boxH}" rx="10" fill="var(--text-0)"/>`;
      svg += `<text x="${rootCx}" y="${6 + boxH / 2 + 4}" text-anchor="middle" font-size="11" font-family="Space Grotesk, sans-serif" fill="var(--bg)" font-weight="700">${escapeHtml(cap(root)).slice(0, 24)}</text>`;
      items.forEach((it, i) => {
        const x = startX + i * (boxW + gap);
        const y = 96;
        svg += `<line x1="${rootCx}" y1="${6 + boxH}" x2="${x + boxW / 2}" y2="${y}" stroke="var(--border-strong)" stroke-width="1.4"/>`;
        svg += `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="10" fill="var(--surface-2)" stroke="var(--border-strong)" stroke-width="1"/>`;
        svg += `<text x="${x + boxW / 2}" y="${y + boxH / 2 + 4}" text-anchor="middle" font-size="10.5" font-family="Space Grotesk, sans-serif" fill="var(--text-0)">${escapeHtml(cap(it)).slice(0, 20)}</text>`;
      });
      svg += `</svg>`;
      return svg;
      function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
    }

    _renderAnswer(path, windowSentences, qSet, tableHtml, diagramHtml) {
      const breadcrumb = path.join(' <i class="fa-solid fa-angle-right" style="font-size:.5rem;opacity:.5;"></i> ');
      let body = windowSentences.map(s => highlightTerms(s.text, qSet)).join(' ');
      // pull out a definition-style sentence to lead with, if present
      let defLine = null;
      for (const s of windowSentences) {
        if (DEFINITION_RE.some(re => re.test(s.text))) { defLine = s.text; break; }
      }
      let html = `<div style="font-family:var(--font-m);font-size:.55rem;color:var(--text-3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;">${breadcrumb}</div>`;
      html += `<div style="font-size:.86rem;line-height:1.6;">${body}</div>`;
      html += tableHtml;
      html += diagramHtml;
      html += `<div class="chip-row" style="margin-top:10px;"><div class="mini-chip" data-action="ncert-source"><i class="fa-solid fa-book-open"></i> From NCERT — ${escapeHtml(path[0])}</div></div>`;
      return html;
    }
  }

  window.NCERTEngine = NCERTEngine;
  // singleton the app can use immediately; index.html calls .load() at init
  window.ncertEngine = new NCERTEngine('./ncert_data.json');
})();
