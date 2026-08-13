/* ==========================================================================
   x-bit Proton — ProtonEngine (engine.js)
   --------------------------------------------------------------------------
   A small, self-contained NLU layer for the chat composer. It is NOT a
   heavy ML model — it's a "decent level" trained-feel pipeline built from
   three parts, matching how a real slot-filling assistant is put together:

     1. ENTITY EXTRACTION (deterministic, regex + fuzzy match)
        - board / KCET marks (total, %, or PHY+CHEM+MATH subject marks)
        - rank, category (with shorthand families like "SC"→S1G, "2A"→2AG)
        - branch — fuzzy-matched against branch-aliases.json (token-overlap
          + exact alias containment), not a hardcoded shorthand table
        - location — matched against location.json's district list AND a
          city-spelling equivalence table (Bangalore/Bengaluru etc.), plus
          direct college recognition via collegedetails.json (shortform or
          name fragments, e.g. "RVCE", "BMSCE")
        - round (mock / provisional / first_round), and near/only filters

     2. SLOT / ACTION PLANNER (deterministic rules)
        Mirrors the shape of trainy.json's "missing" + "action" fields:
        given what's known, decide the intent (predict_rank / predict_college)
        and what's still missing, so the app can ask exactly one follow-up
        question instead of guessing.

     3. TF-IDF + COSINE SIMILARITY CLASSIFIER (the "vector" layer)
        Built at load time from trainy.json. Used as a fallback / confidence
        signal for turns that aren't rank/college requests (greetings,
        thanks, FAQs) — this is the part that gives "trained model" behaviour
        for chit-chat the slot planner doesn't own.

   Multi-turn memory: analyze(text, session) takes the previous session's
   partially-filled slots and merges new entities on top, so "130 in KCET"
   followed later by "90 boards" followed by "CSE in Bangalore under GM"
   resolves into one completed request, same as trainy.json's examples.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------- categories ---------------------------- */
  const GENERAL_CATEGORIES = ['1G','1K','1R','2AG','2AK','2AR','2BG','2BK','2BR','3AG','3AK','3AR','3BG',
    '3BK','3BR','GM','GMK','GMP','GMR','NRI','OPN','OTH','S1G','S1K','S1R','S2G','S2K','S2R','S3G',
    'S3K','S3R','S4G','S4K','S4R','STG','STK','STR'];
  const HK_CATEGORIES = ['1H','1KH','1RH','2AH','2AKH','2ARH','2BH','2BKH','2BRH','3AH','3AKH','3ARH','3BH',
    '3BKH','3BRH','GMH','GMKH','GMPH','GMRH','S1H','S1KH','S1RH','S2H','S2KH','S2RH','S3H','S3KH',
    'S3RH','S4H','S4KH','S4RH','STH','STKH','STRH'];
  const ALL_CATEGORIES = [...GENERAL_CATEGORIES, ...HK_CATEGORIES];

  // shorthand -> best-guess canonical category (user still gets to correct
  // it — this only fills the slot, the UI shows what was assumed)
  const CATEGORY_SHORTHAND = {
    GM:'GM', GEN:'GM', GENERAL:'GM', OPEN:'OPN', OPN:'OPN',
    '1':'1G', '2A':'2AG', '2B':'2BG', '3A':'3AG', '3B':'3BG',
    SC:'S1G', ST:'STG', S1:'S1G', S2:'S2G', S3:'S3G', S4:'S4G',
    NRI:'NRI', OTH:'OTH'
  };

  /* ------------------------------ text utils ---------------------------- */
  function norm(s) { return (s || '').toLowerCase().replace(/[^\w\s%.\/]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function tokens(s) { return norm(s).split(' ').filter(Boolean); }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ------------------------- TF-IDF + cosine index ------------------------ */
  function buildTfidfIndex(examples, getText) {
    const docsTokens = examples.map(ex => tokens(getText(ex)));
    const df = {};
    docsTokens.forEach(toks => { new Set(toks).forEach(t => { df[t] = (df[t] || 0) + 1; }); });
    const N = examples.length || 1;
    const idf = {};
    Object.keys(df).forEach(t => { idf[t] = Math.log(1 + N / df[t]); });

    function vec(toks) {
      const tf = {};
      toks.forEach(t => { tf[t] = (tf[t] || 0) + 1; });
      const v = {};
      Object.keys(tf).forEach(t => { v[t] = (tf[t] / (toks.length || 1)) * (idf[t] || 0); });
      return v;
    }
    const vectors = docsTokens.map(vec);

    function cosine(v1, v2) {
      let dot = 0, n1 = 0, n2 = 0;
      for (const k in v1) { n1 += v1[k] * v1[k]; if (v2[k]) dot += v1[k] * v2[k]; }
      for (const k in v2) { n2 += v2[k] * v2[k]; }
      if (!n1 || !n2) return 0;
      return dot / (Math.sqrt(n1) * Math.sqrt(n2));
    }

    return {
      query(text) {
        if (!examples.length) return null;
        const qv = vec(tokens(text));
        let best = -1, bestIdx = -1;
        vectors.forEach((v, i) => { const s = cosine(qv, v); if (s > best) { best = s; bestIdx = i; } });
        return bestIdx === -1 ? null : { index: bestIdx, score: best, example: examples[bestIdx] };
      }
    };
  }

  /* --------------------- fuzzy branch matcher (branch-aliases.json) ------------------- */
  function buildBranchMatcher(branchAliases) {
    const entries = (branchAliases || []).map(e => ({
      id: e.branch_id,
      name: e.display_name,
      tokSet: new Set(tokens(e.display_name)),
      aliasPools: [e.display_name, ...(e.aliases || [])].map(a => ({ raw: a, toks: new Set(tokens(a)) }))
    }));

    function match(text) {
      const norm_text = norm(text);
      const qTok = new Set(tokens(text));
      if (!qTok.size) return null;

      // 1) exact alias containment as a whole word/phrase — handles "CSE", "ECE" etc precisely
      for (const e of entries) {
        for (const p of e.aliasPools) {
          const rawNorm = norm(p.raw);
          if (!rawNorm) continue;
          const re = new RegExp('\\b' + escapeRe(rawNorm) + '\\b');
          if (re.test(norm_text)) return { id: e.id, name: e.name, score: 1 };
        }
      }
      // 2) token-overlap fuzzy match as a fallback
      let best = null, bestScore = 0;
      for (const e of entries) {
        for (const p of e.aliasPools) {
          const inter = [...p.toks].filter(t => qTok.has(t)).length;
          const uni = new Set([...p.toks, ...qTok]).size;
          const score = uni ? inter / uni : 0;
          if (score > bestScore) { bestScore = score; best = { id: e.id, name: e.name, score }; }
        }
      }
      return bestScore >= 0.34 ? best : null;
    }
    return { match };
  }

  /* --------------------- location + college matcher --------------------- */
  // Karnataka district ⇄ common-spelling equivalence groups. Datasets in
  // this project use older city spellings ("Bangalore","Mysore") while
  // location.json uses current official district names ("Bengaluru",
  // "Mysuru") — so filtering is done against the WHOLE group, not just
  // the canonical name.
  const DEFAULT_ALIAS_GROUPS = [
    ['bangalore','bengaluru','bangalore rural','bengaluru rural'],
    ['mysore','mysuru'], ['mangalore','mangaluru','dakshina kannada'],
    ['hubli','hubballi','dharwad'], ['belgaum','belagavi'],
    ['shimoga','shivamogga'], ['tumkur','tumakuru'],
    ['davangere','davanagere'], ['bellary','ballari'],
    ['gulbarga','kalaburagi'], ['bidar'], ['raichur'], ['udupi'],
    ['chikmagalur','chikkamagaluru'], ['kolar'], ['mandya'], ['chitradurga'],
    ['bagalkot','bagalkote'], ['hospet','vijayanagara'], ['bijapur','vijayapura'],
    ['kodagu','coorg'], ['ramanagara','ramanagar'], ['chikkaballapur'],
    ['koppal'], ['gadag'], ['haveri'], ['yadgir'],
    ['uttara kannada','karwar'], ['hassan'], ['chamarajanagar','chamarajanagara']
  ];

  function buildLocationMatcher(locationData, collegeDetails) {
    const groups = (locationData && locationData.aliasGroups && locationData.aliasGroups.length)
      ? locationData.aliasGroups : DEFAULT_ALIAS_GROUPS;
    const districts = (locationData && locationData.districts) || [];

    const collegeIdx = (collegeDetails || []).map(c => ({
      id: c.id, name: c.College || c.name, shortform: c.shortform || '', location: c.location || ''
    }));

    // returns { display, group } where group is every accepted spelling
    function findDistrict(text) {
      const t = ' ' + norm(text) + ' ';
      for (const group of groups) {
        for (const alias of group) {
          if (new RegExp('\\b' + escapeRe(alias) + '\\b').test(t)) {
            return { display: capitalizeWords(group[0]), group };
          }
        }
      }
      for (const d of districts) {
        if (new RegExp('\\b' + escapeRe(norm(d)) + '\\b').test(t)) {
          return { display: d, group: [norm(d)] };
        }
      }
      return null;
    }

    function findCollege(text) {
      const t = norm(text);
      for (const c of collegeIdx) {
        if (c.shortform && new RegExp('\\b' + escapeRe(norm(c.shortform)) + '\\b').test(t)) {
          return { id: c.id, name: c.name, location: c.location };
        }
      }
      for (const c of collegeIdx) {
        const sig = tokens(c.name).filter(w => w.length > 3 &&
          !['engineering','college','institute','technology','university','autonomous'].includes(w)).slice(0, 3);
        if (sig.length >= 2 && sig.every(w => t.includes(w))) {
          return { id: c.id, name: c.name, location: c.location };
        }
      }
      return null;
    }

    function capitalizeWords(s) { return (s || '').replace(/\b\w/g, c => c.toUpperCase()); }

    return { findDistrict, findCollege };
  }

  /* --------------------------- marks / score extraction --------------------------- */
  const SUBJ_RE = { physics: /phy(?:sics)?/, chemistry: /chem(?:istry)?/, maths: /math(?:s|ematics)?/ };

  function extractSubjectMarks(t) {
    const marks = {};
    for (const [subj, re] of Object.entries(SUBJ_RE)) {
      const after = new RegExp(re.source + '\\D{0,4}(\\d{1,3}(?:\\.\\d+)?)', 'i');
      const before = new RegExp('(\\d{1,3}(?:\\.\\d+)?)\\D{0,4}' + re.source, 'i');
      // "before" (number immediately precedes its subject name, e.g. "86 maths",
      // "92 in maths,") is the dominant phrasing across every sample seen, and
      // is tried first. Trying "after" first is a trap: in "86 maths 84
      // physics" the after-pattern for "maths" finds "84" (physics' own
      // number) sitting within the small gap and wrongly claims it.
      const mm = t.match(before) || t.match(after);
      if (mm) marks[subj] = parseFloat(mm[1]);
    }
    if (marks.physics != null && marks.chemistry != null && marks.maths != null) return marks;
    return null;
  }

  // Scope the subject-mark search to the full gap between this keyword's
  // neighbouring keyword mentions (not a midpoint split). Phrasing varies on
  // which side of the keyword the numbers sit ("86 maths ... in boards" vs
  // "board marks are 88 maths..."), and regex .match() always returns the
  // FIRST occurrence in the string it's given — so widening the window to
  // the full neighbour-to-neighbour gap and relying on "first match wins"
  // correctly resolves both phrasing directions without extra bookkeeping.
  function segmentForKeyword(text, ownSrc, otherSrc) {
    const re = new RegExp('(?:' + ownSrc + ')|(?:' + otherSrc + ')', 'gi');
    const ownRe = new RegExp('^(?:' + ownSrc + ')$', 'i');
    const matches = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ index: m.index, end: re.lastIndex, isOwn: ownRe.test(m[0]) });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    const ownIdx = matches.findIndex(x => x.isOwn);
    if (ownIdx === -1) return text;
    const start = ownIdx > 0 ? matches[ownIdx - 1].end : 0;
    const end = ownIdx < matches.length - 1 ? matches[ownIdx + 1].index : text.length;
    return text.slice(start, end);
  }

  function findScoreBlock(text, keywordSrc, otherKeywordSrc, maxTotal, subjectMax, ambiguousDefault) {
    const windowText = otherKeywordSrc ? segmentForKeyword(text, keywordSrc, otherKeywordSrc) : text;
    const subj = extractSubjectMarks(windowText);
    if (subj && subj.physics <= subjectMax && subj.chemistry <= subjectMax && subj.maths <= subjectMax) {
      const total = subj.physics + subj.chemistry + subj.maths;
      return { total, pct: (total / maxTotal) * 100, subjects: subj };
    }
    let pctMatch = text.match(new RegExp(keywordSrc + '(?:\\s+(?:score|marks?|is|was|of|scored|got))?\\s+(\\d+(?:\\.\\d+)?)\\s*%', 'i')) ||
      text.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:in\\s+)?' + keywordSrc, 'i'));
    if (pctMatch) { const v = Math.min(100, parseFloat(pctMatch[1])); return { pct: v, total: (v / 100) * maxTotal }; }

    let fracMatch = text.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*(?:\\/|out of)\\s*' + maxTotal, 'i'));
    if (fracMatch) { const v = parseFloat(fracMatch[1]); if (v <= maxTotal) return { total: v, pct: (v / maxTotal) * 100 }; }

    let explicitMarks = text.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s+marks?\\s+(?:in\\s+)?' + keywordSrc, 'i')) ||
      text.match(new RegExp(keywordSrc + '\\s+(\\d+(?:\\.\\d+)?)\\s+marks', 'i'));
    if (explicitMarks) { const v = parseFloat(explicitMarks[1]); if (v <= maxTotal) return { total: v, pct: (v / maxTotal) * 100 }; }

    // NOTE: gaps here are whitespace-only (plus a short whitelist of linking
    // words) on purpose — an earlier version allowed any non-digit run
    // (\D{0,15}) between the keyword and a number, which let it skip clean
    // over "and" in "...in boards and 130 in KCET" and grab the KCET figure
    // as if it were the board mark. Whitespace-only gaps keep each number
    // anchored to its own keyword.
    let totalMatch = text.match(new RegExp(keywordSrc + '(?:\\s+(?:score|marks?|is|was|of|scored|got))?\\s+(\\d+(?:\\.\\d+)?)\\b', 'i')) ||
      text.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s+(?:marks?\\s+)?(?:in\\s+)?' + keywordSrc, 'i'));
    if (totalMatch) {
      const v = parseFloat(totalMatch[1]);
      if (v <= maxTotal) {
        if (v > 100) return { total: v, pct: (v / maxTotal) * 100 };
        if (ambiguousDefault === 'marks') return { total: v, pct: (v / maxTotal) * 100 };
        return { pct: v, total: (v / 100) * maxTotal };
      }
    }
    return null;
  }

  function extractCategory(text) {
    const t = ' ' + norm(text) + ' ';
    const sorted = [...ALL_CATEGORIES].sort((a, b) => b.length - a.length);
    for (const code of sorted) { if (new RegExp('\\b' + code.toLowerCase() + '\\b').test(t)) return code; }
    for (const short in CATEGORY_SHORTHAND) {
      if (new RegExp('\\b' + short.toLowerCase() + '\\b').test(t)) return CATEGORY_SHORTHAND[short];
    }
    return null;
  }

  function extractRound(text) {
    const t = norm(text);
    if (/\bmock\b/.test(t)) return 'mock';
    if (/\bprovisional\b/.test(t)) return 'provisional';
    if (/\b(first\s*round|round\s*1|round\s*one|final\s*(result|round))\b/.test(t)) return 'round1';
    return null;
  }

  function extractLocationFilter(text) {
    const t = norm(text);
    if (/\b(near|around|close to|nearby)\b/.test(t)) return 'near';
    if (/\bonly\b/.test(t)) return 'only';
    return null;
  }

  function extractRank(text) {
    const t = ' ' + norm(text) + ' ';
    let rm = t.match(/\brank\b[^\d]{0,6}(\d+(?:\.\d+)?)\s*(k)?\b/);
    if (rm) { let v = parseFloat(rm[1]); if (rm[2]) v *= 1000; return Math.round(v); }
    const km = t.match(/\b(\d+(?:\.\d+)?)\s*k\b/);
    if (km) return Math.round(parseFloat(km[1]) * 1000);
    return null;
  }

  /* --------------- answer-layer: templated follow-up copy (answers.json) --------------- */
  // Keyed by intent + exact missing-field set, matching answers.json's shape
  // 1:1. The engine's internal missing-labels ('boards'/'kcet') are mapped
  // to the answer layer's field names ('per_boards'/'mark_kcet') before
  // lookup so the two vocabularies line up without duplicating the file.
  function buildAnswerLayer(data) {
    const missingIntents = (data && data.missing_intents) || [];
    const locationContext = (data && data.location_context) || [];
    const roundContext = (data && data.round_context) || [];
    const completeIntents = (data && data.complete_intents) || [];
    const MISSING_LABEL_MAP = { boards: 'per_boards', kcet: 'mark_kcet' };

    function sameSet(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      const sa = new Set(a);
      for (const x of b) if (!sa.has(x)) return false;
      return true;
    }
    function mapMissing(missing) { return (missing || []).map(m => MISSING_LABEL_MAP[m] || m); }
    function fill(str, vars) {
      return (str || '').replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null) ? vars[k] : m);
    }

    function findMissingTemplate(intent, missing) {
      const mapped = mapMissing(missing);
      return missingIntents.find(en => en.intent === intent && sameSet(en.missing, mapped)) || null;
    }
    function findLocationTemplate(intent, missing) {
      const mapped = mapMissing(missing);
      return locationContext.find(en => en.intent === intent && sameSet(en.missing, mapped)) || null;
    }
    function findCompleteTemplate(intent) {
      return completeIntents.find(en => en.intent === intent) || null;
    }
    function findRoundTemplate(round) {
      const key = round === 'round1' ? 'first_round' : round;
      return roundContext.find(en => en.round === key) || null;
    }

    // Returns { text, roundNote, complete } — `text` is the follow-up
    // question (or null if nothing applies / plan is already complete
    // without a matching complete-intent template), `roundNote` is a
    // short aside about which round's data is being used.
    function compose(analysis) {
      const { intent, missing, entities } = analysis;
      const out = { text: null, roundNote: null, complete: !missing || missing.length === 0 };

      if (entities.round) {
        const rt = findRoundTemplate(entities.round);
        if (rt) out.roundNote = rt.output;
      }

      if (missing && missing.length) {
        let tpl = null;
        if (entities.location && intent === 'predict_college') tpl = findLocationTemplate(intent, missing);
        if (!tpl) tpl = findMissingTemplate(intent, missing);
        out.text = tpl ? fill(tpl.output, { location: entities.location }) : null;
      } else if (intent === 'predict_rank' || intent === 'predict_college' ||
                 intent === 'check_specific_college' || intent === 'check_cutoff') {
        const tpl = findCompleteTemplate(intent);
        out.text = tpl ? tpl.output : null;
      }
      return out;
    }

    return { compose, findMissingTemplate, findLocationTemplate, findCompleteTemplate, findRoundTemplate };
  }

  /* ------------------------------- engine ------------------------------- */
  function createEngine() {
    let tfidf = null, branchMatcher = null, locMatcher = null, answerLayer = null, ready = false;

    function init({ trainingExamples = [], branchAliases = [], collegeDetails = [], locationData = {}, answerData = {} } = {}) {
      tfidf = buildTfidfIndex(trainingExamples, e => e.input || '');
      branchMatcher = buildBranchMatcher(branchAliases);
      locMatcher = buildLocationMatcher(locationData, collegeDetails);
      answerLayer = buildAnswerLayer(answerData);
      ready = true;
    }

    function extractEntities(rawText, prevKnown) {
      const t = ' ' + norm(rawText) + ' ';
      const e = Object.assign({}, prevKnown || {});

      const BOARDS_KW = '(?:boards?|2nd\\s*pu|puc?)\\b';
      const KCET_KW = '(?:kcet|cet)\\b';

      const boards = findScoreBlock(t, BOARDS_KW, KCET_KW, 300, 100, 'percentage');
      if (boards) e.boardPercentage = Math.round(boards.pct * 100) / 100;

      const kcet = findScoreBlock(t, KCET_KW, BOARDS_KW, 180, 60, 'marks');
      if (kcet) e.kcetMarks = Math.round(kcet.total * 100) / 100;

      const rank = extractRank(rawText);
      if (rank != null) e.rank = rank;

      const cat = extractCategory(rawText);
      if (cat) e.category = cat;

      const round = extractRound(rawText);
      if (round) e.round = round;

      const locFilter = extractLocationFilter(rawText);
      if (locFilter) e.locationFilter = locFilter;

      if (branchMatcher) {
        const b = branchMatcher.match(rawText);
        if (b) { e.branch = b.name; e.branchId = b.id; }
      }
      if (locMatcher) {
        const college = locMatcher.findCollege(rawText);
        if (college) { e.college = college; }
        const dist = locMatcher.findDistrict(rawText);
        if (dist) { e.location = dist.display; e.locationGroup = dist.group; }
      }
      return e;
    }

    // deterministic slot/action planner — mirrors trainy.json's "missing"/"action" shape
    // `prevGoal` is the intent the session was already working toward (set by
    // a previous turn, e.g. "what college can I get?"). Without it, a
    // follow-up turn like "my kcet is 130 and boards is 90" — which mentions
    // no college/branch/category words on its own — would be misread as a
    // *completed* rank request and wipe the in-progress college search.
    function planAction(entities, rawText, prevGoal) {
      const mentionsCutoff = /\bcutoff\b/i.test(rawText);
      const mentionsCollege = /\bcolleg/i.test(rawText) || /\ballot/i.test(rawText) || mentionsCutoff;
      const goalWasCollege = prevGoal === 'predict_college' || prevGoal === 'check_specific_college' || prevGoal === 'check_cutoff';
      const wantsCollege = !!(entities.branch || entities.category || entities.location ||
        entities.college || entities.round || mentionsCollege || goalWasCollege);

      const hasRankInputs = entities.boardPercentage != null && entities.kcetMarks != null;
      const hasRank = entities.rank != null;

      if (!hasRank && !hasRankInputs) {
        if (entities.kcetMarks != null && entities.boardPercentage == null) {
          return { intent: 'predict_rank', missing: ['boards'], entities };
        }
        if (entities.boardPercentage != null && entities.kcetMarks == null) {
          return { intent: 'predict_rank', missing: ['kcet'], entities };
        }
        if (wantsCollege) return { intent: 'predict_college', missing: ['rank_or_scores'], entities };
        return { intent: 'unknown', missing: [], entities };
      }

      // a specific college was named (e.g. "RVCE", "BMSCE") — this is a
      // narrower check_specific_college / check_cutoff request rather than
      // an open-ended location search
      if (entities.college) {
        const missing = [];
        if (!entities.category) missing.push('category');
        if (!entities.branch) missing.push('branch');
        return { intent: mentionsCutoff ? 'check_cutoff' : 'check_specific_college', missing, entities };
      }

      if (!wantsCollege) return { intent: 'predict_rank', missing: [], entities };

      const missing = [];
      if (!entities.category) missing.push('category');
      if (!entities.branch) missing.push('branch');
      return { intent: 'predict_college', missing, entities };
    }

    function analyze(rawText, session) {
      if (!ready) throw new Error('ProtonEngine.init() must be called before analyze()');
      session = session || { known: {}, goal: null };
      const entities = extractEntities(rawText, session.known);
      const plan = planAction(entities, rawText, session.goal);

      const nearestExample = tfidf ? tfidf.query(rawText) : null;

      const done = plan.intent !== 'unknown' && plan.missing.length === 0;
      // once a request completes, wipe slot memory; otherwise keep partial
      // state (and the standing goal) for the next turn
      const newSession = done ? { known: {}, goal: null } : { known: entities, goal: plan.intent };

      return {
        intent: plan.intent,
        entities,
        missing: plan.missing,
        nearestExample,
        session: newSession
      };
    }

    function respond(analysis) {
      if (!ready) throw new Error('ProtonEngine.init() must be called before respond()');
      return answerLayer.compose(analysis);
    }

    return { init, analyze, respond, extractEntities, isReady: () => ready };
  }

  global.ProtonEngine = createEngine();

})(window);
