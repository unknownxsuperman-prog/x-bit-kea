// fetchengine.js — KEA link fetching, PDF preview/download, native bridge POST support

(function () {
  const KEA_URL = 'https://cetonline.karnataka.gov.in/kea/ugcet2026';
  const CATALOG_URL = 'https://unknownxsuperman-prog.github.io/Tools/links.json';
  const target = typeof window !== 'undefined' ? window : globalThis;

  function normalize(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function matchScore(query, text) {
    const wanted = new Set(normalize(query).split(' ').filter(Boolean));
    const available = new Set(normalize(text).split(' ').filter(Boolean));
    if (!wanted.size) return 0;
    let count = 0;
    wanted.forEach(token => { if (available.has(token)) count++; });
    return count / wanted.size;
  }

  async function bridgeText(url, body) {
    if (typeof target.__protonNativeFetch !== 'function') {
      throw new Error('App bridge is not ready');
    }
    const result = await target.__protonNativeFetch(url, false, body || null);
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Bridge request failed (${result.status})`);
    }
    return result.payload;
  }

  async function englishKeaHtml() {
    const initial = await bridgeText(KEA_URL);
    const doc = new DOMParser().parseFromString(initial, 'text/html');
    const form = doc.querySelector('form');
    const language = doc.querySelector('select[name="ctl00$ddlLanguage"]');
    if (!form || !language) return initial;

    const fields = new URLSearchParams();
    form.querySelectorAll('input[type="hidden"][name]').forEach(input => fields.append(input.name, input.value || ''));
    fields.set('__EVENTTARGET', 'ctl00$ddlLanguage');
    fields.set('__EVENTARGUMENT', '');
    fields.set(language.name, 'E');
    const action = new URL(form.getAttribute('action') || KEA_URL, KEA_URL).toString();
    return bridgeText(action, fields.toString());
  }

  function extractLinks(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(doc.querySelectorAll('a[href]')).map(anchor => ({
      name: anchor.textContent.replace(/\s+/g, ' ').trim(),
      link: new URL(anchor.getAttribute('href'), KEA_URL).toString()
    })).filter(item => item.name.length >= 3);
  }

  async function query(rawQuery) {
    const [catalog, html] = await Promise.all([
      bridgeText(CATALOG_URL).then(JSON.parse),
      englishKeaHtml()
    ]);
    const generated = extractLinks(html);
    const results = [];
    for (const [key, entry] of Object.entries(catalog)) {
      const reference = entry.actual_name || key;
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      const best = generated.map(item => ({ item, score: Math.max(matchScore(reference, item.name), ...aliases.map(alias => matchScore(alias, item.name))) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.5) {
        const queryScore = Math.max(matchScore(rawQuery, reference), ...aliases.map(alias => matchScore(rawQuery, alias)));
        if (queryScore >= 0.5) results.push({ name: best.item.name, link: best.item.link, key, score: queryScore });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return { items: results.slice(0, 5) };
  }

  target.fetchKeaLinks = query;
  if (typeof module !== 'undefined') module.exports = { query, extractLinks };
})();
