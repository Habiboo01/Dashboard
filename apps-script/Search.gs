/**
 * Search.gs — ranking/scoring logic for the Telda Support Search bot.
 * Pure functions (no Apps Script services) so they are easy to reason about/test.
 * No AI: this is deterministic full-text, multi-word, case-insensitive matching
 * over each KB entry's title, keywords, category and content (English + Arabic).
 */

// Field weights: a hit in the title matters far more than a hit in the body.
var FIELD_WEIGHTS = { title: 10, keywords: 6, category: 3, content: 1 };

// Very common words we ignore so they don't dominate scoring. Kept small on
// purpose — Arabic queries are short, so we don't strip Arabic stop words.
var STOP_WORDS = {
  'the':1,'a':1,'an':1,'and':1,'or':1,'to':1,'of':1,'for':1,'in':1,'on':1,'is':1,
  'it':1,'my':1,'i':1,'me':1,'we':1,'he':1,'she':1,'they':1,'that':1,'this':1,
  'with':1,'was':1,'has':1,'have':1,'did':1,'do':1,'not':1,'but':1,'his':1,'her':1,
  'customer':1,'user':1,'client':1
};

/**
 * Normalize text for matching: lowercase, strip Arabic diacritics/tatweel,
 * unify alef/ya/ta-marbuta variants, and collapse punctuation to spaces.
 */
function normalize_(s) {
  if (s === null || s === undefined) return '';
  s = String(s).toLowerCase();
  // Remove Arabic diacritics (harakat) and tatweel.
  s = s.replace(/[ؗ-ًؚ-ْـ]/g, '');
  // Unify common Arabic letter variants.
  s = s.replace(/[آأإ]/g, 'ا') // آأإ -> ا
       .replace(/ى/g, 'ي')                 // ى -> ي
       .replace(/ة/g, 'ه');                // ة -> ه
  // Replace anything that isn't a latin letter/digit or Arabic letter with a space.
  s = s.replace(/[^0-9a-zء-ي]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Split a query/text into meaningful tokens (>=2 chars, excluding stop words). */
function tokenize_(s) {
  var norm = normalize_(s);
  if (!norm) return [];
  var raw = norm.split(' ');
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var t = raw[i];
    if (t.length < 2) continue;
    if (STOP_WORDS[t]) continue;
    out.push(t);
  }
  return out;
}

/** Count occurrences of a token inside already-normalized text. */
function countOccurrences_(haystackNorm, token) {
  if (!haystackNorm || !token) return 0;
  var count = 0, idx = haystackNorm.indexOf(token);
  while (idx !== -1) { count++; idx = haystackNorm.indexOf(token, idx + token.length); }
  return count;
}

/**
 * Score one KB entry against the tokenized query.
 * Returns { score, matchedTerms[] }. score is 0 when nothing matches.
 */
function scoreEntry_(entry, queryTokens) {
  var fields = {
    title: normalize_(entry.title),
    keywords: normalize_((entry.keywords || []).join(' ')),
    category: normalize_(entry.category),
    content: normalize_(entry.content)
  };
  var score = 0;
  var matched = {};
  for (var t = 0; t < queryTokens.length; t++) {
    var tok = queryTokens[t];
    var termHit = false;
    for (var f in FIELD_WEIGHTS) {
      var occ = countOccurrences_(fields[f], tok);
      if (occ > 0) {
        // Diminishing returns on repeated occurrences within a field.
        score += FIELD_WEIGHTS[f] * (1 + Math.log(occ));
        termHit = true;
      }
    }
    if (termHit) matched[tok] = true;
  }
  // Bonus: reward matching more of the distinct query terms (coverage).
  var distinct = Object.keys(matched).length;
  if (queryTokens.length > 0) {
    score *= (1 + distinct / queryTokens.length);
  }
  return { score: score, matchedTerms: Object.keys(matched) };
}

/**
 * Rank the KB against a query.
 * @param {Array} kb    array of {category,title,content,notionUrl,keywords}
 * @param {String} query
 * @param {Number} limit max results (default 8)
 * @return {Array} [{category,title,content,notionUrl,score,matchedTerms}]
 */
function rankKb_(kb, query, limit) {
  limit = limit || 8;
  var tokens = tokenize_(query);
  if (tokens.length === 0) return [];
  var results = [];
  for (var i = 0; i < kb.length; i++) {
    var s = scoreEntry_(kb[i], tokens);
    if (s.score > 0) {
      results.push({
        category: kb[i].category,
        title: kb[i].title,
        content: kb[i].content,
        notionUrl: kb[i].notionUrl || '',
        score: s.score,
        matchedTerms: s.matchedTerms
      });
    }
  }
  results.sort(function (a, b) { return b.score - a.score; });
  return results.slice(0, limit);
}
