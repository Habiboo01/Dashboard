/**
 * Code.gs — entry point, routing, search API, keyword overrides, logging.
 * Telda Support Search bot. 100% Google Apps Script + Notion; no external AI.
 *
 * Script Properties used (Project Settings -> Script properties):
 *   ADMIN_EMAILS        Comma-separated admin emails (e.g. "a@x.com,b@x.com")
 *   NOTION_TOKEN        Notion internal integration token (only for sync)
 *   NOTION_PARENT_ID    Notion parent page id of the KB (only for sync)
 *   KB_FILE_ID          (set by sync) Drive file id of the KB JSON snapshot
 *   DATA_SHEET_ID       (auto-created) Spreadsheet id for logs + keyword overrides
 */

// ---------- Routing ----------

function doGet(e) {
  var view = (e && e.parameter && e.parameter.view) || 'agent';
  if (view === 'admin') {
    if (!isAdmin_()) {
      return HtmlService.createHtmlOutput(
        '<div style="font-family:sans-serif;padding:40px">' +
        '<h2>Not authorized</h2><p>The admin panel is restricted. ' +
        'Ask an administrator to add your Google account to ADMIN_EMAILS.</p></div>')
        .setTitle('Telda Support — Admin');
    }
    return HtmlService.createHtmlOutputFromFile('Admin')
      .setTitle('Telda Support — Admin')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutputFromFile('Agent')
    .setTitle('Telda Support Search')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------- Config / auth ----------

function getConfig_() {
  return PropertiesService.getScriptProperties().getProperties();
}

function currentEmail_() {
  try { return (Session.getActiveUser().getEmail() || '').toLowerCase(); }
  catch (err) { return ''; }
}

function isAdmin_() {
  var cfg = getConfig_();
  var admins = (cfg.ADMIN_EMAILS || '')
    .split(',').map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s; });
  var me = currentEmail_();
  return !!me && admins.indexOf(me) !== -1;
}

function requireAdmin_() {
  if (!isAdmin_()) throw new Error('Not authorized (admin only).');
}

// ---------- KB loading ----------

/** Load the KB: Drive snapshot if synced, otherwise the in-script seed. */
function loadKbRaw_() {
  var cfg = getConfig_();
  if (cfg.KB_FILE_ID) {
    try {
      var file = DriveApp.getFileById(cfg.KB_FILE_ID);
      var data = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
      if (data && data.length) return data;
    } catch (err) {
      // Fall through to the seed if the snapshot can't be read.
    }
  }
  return KB_SEED; // defined in Kb.gs
}

/** KB with admin keyword overrides merged in (overrides survive Notion syncs). */
function getKb() {
  var kb = loadKbRaw_();
  var overrides = readKeywordOverrides_(); // { title: [words] }
  if (Object.keys(overrides).length) {
    kb = kb.map(function (entry) {
      var extra = overrides[entry.title];
      if (extra && extra.length) {
        var base = entry.keywords || [];
        entry = {
          category: entry.category, title: entry.title, content: entry.content,
          notionUrl: entry.notionUrl,
          keywords: base.concat(extra)
        };
      }
      return entry;
    });
  }
  return kb;
}

// ---------- Public API (called from the Agent UI) ----------

/**
 * Search the KB. Returns { query, count, results:[{category,title,content,notionUrl,matchedTerms}] }.
 * Also logs the query (and whether it returned results) for KB-gap analysis.
 */
function search(query) {
  query = (query || '').toString();
  var kb = getKb();
  var results = rankKb_(kb, query, 8); // rankKb_ in Search.gs
  try { logSearch_(query, results); } catch (err) {} // never fail a search on logging
  // Strip the numeric score before returning to the client.
  var clean = results.map(function (r) {
    return {
      category: r.category, title: r.title, content: r.content,
      notionUrl: r.notionUrl, matchedTerms: r.matchedTerms
    };
  });
  return { query: query, count: clean.length, results: clean };
}

// ---------- Data spreadsheet (logs + keyword overrides) ----------

/** Get (or lazily create) the backing spreadsheet with Log + Keywords tabs. */
function getDataSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DATA_SHEET_ID');
  var ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Telda Support Search — data');
    props.setProperty('DATA_SHEET_ID', ss.getId());
  }
  ensureSheet_(ss, 'Log', ['Timestamp', 'Agent', 'Query', 'Results', 'Top match']);
  ensureSheet_(ss, 'Keywords', ['Topic title', 'Extra keywords (comma-separated)']);
  return ss;
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  // Remove the default "Sheet1" if empty and we created named tabs.
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  return sh;
}

function logSearch_(query, results) {
  var sh = getDataSheet_().getSheetByName('Log');
  var top = results && results.length ? (results[0].title + ' (' + results[0].category + ')') : '— none —';
  sh.appendRow([new Date(), currentEmail_() || 'unknown', query, results ? results.length : 0, top]);
}

// ---------- Keyword overrides ----------

function readKeywordOverrides_() {
  var map = {};
  try {
    var sh = getDataSheet_().getSheetByName('Keywords');
    var last = sh.getLastRow();
    if (last < 2) return map;
    var rows = sh.getRange(2, 1, last - 1, 2).getValues();
    rows.forEach(function (r) {
      var title = (r[0] || '').toString().trim();
      var words = (r[1] || '').toString().split(',')
        .map(function (s) { return s.trim(); }).filter(function (s) { return s; });
      if (title && words.length) map[title] = words;
    });
  } catch (err) {}
  return map;
}

// ---------- Admin API (called from the Admin UI) ----------

/** Status payload for the admin panel. */
function getAdminStatus() {
  requireAdmin_();
  var props = PropertiesService.getScriptProperties();
  var kb = loadKbRaw_();
  var ss = getDataSheet_();
  return {
    email: currentEmail_(),
    topicCount: kb.length,
    source: props.getProperty('KB_FILE_ID') ? 'Notion sync' : 'built-in seed',
    lastSync: props.getProperty('LAST_SYNC') || 'never',
    notionConfigured: !!(props.getProperty('NOTION_TOKEN') && props.getProperty('NOTION_PARENT_ID')),
    dataSheetUrl: ss.getUrl(),
    titles: kb.map(function (e) { return e.title; }).sort()
  };
}

/** List current keyword overrides for the admin editor. */
function getKeywordOverrides() {
  requireAdmin_();
  var map = readKeywordOverrides_();
  return Object.keys(map).map(function (t) { return { title: t, keywords: map[t].join(', ') }; });
}

/** Add/replace the extra keywords for a topic title. Empty string clears it. */
function setKeywords(title, keywordsCsv) {
  requireAdmin_();
  title = (title || '').toString().trim();
  if (!title) throw new Error('Topic title is required.');
  var sh = getDataSheet_().getSheetByName('Keywords');
  var last = sh.getLastRow();
  var found = -1;
  if (last >= 2) {
    var titles = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < titles.length; i++) {
      if ((titles[i][0] || '').toString().trim() === title) { found = i + 2; break; }
    }
  }
  var clean = (keywordsCsv || '').toString();
  if (found === -1) {
    sh.appendRow([title, clean]);
  } else {
    sh.getRange(found, 2).setValue(clean);
  }
  return true;
}
