/**
 * Sync.gs — pull the Telda KB from Notion into a Drive JSON snapshot.
 * No AI. Uses the Notion API via UrlFetchApp. Structure expected:
 *   Parent page  ->  Category sub-pages  ->  Topic sub-pages (content lives here).
 *
 * Requires Script Properties: NOTION_TOKEN, NOTION_PARENT_ID.
 */

var NOTION_VERSION = '2022-06-28';
var NOTION_PAUSE_MS = 350; // stay under Notion's ~3 req/sec rate limit.

// ---------- Public entry points ----------

/** Admin-triggered sync (from the Admin UI button). Returns a status object. */
function adminSyncNow() {
  requireAdmin_();
  return syncFromNotion_();
}

/** Install a once-a-day trigger that keeps the snapshot fresh. */
function installDailyTrigger() {
  requireAdmin_();
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'syncFromNotion_';
  });
  if (!exists) {
    ScriptApp.newTrigger('syncFromNotion_').timeBased().everyDays(1).atHour(4).create();
  }
  return { installed: true };
}

// ---------- Core sync ----------

function syncFromNotion_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('NOTION_TOKEN');
  var parentId = props.getProperty('NOTION_PARENT_ID');
  if (!token || !parentId) {
    throw new Error('NOTION_TOKEN and NOTION_PARENT_ID must be set in Script Properties.');
  }

  // Map title -> seed keywords so curated synonyms survive a sync.
  var seedKw = {};
  (typeof KB_SEED !== 'undefined' ? KB_SEED : []).forEach(function (e) {
    seedKw[e.title] = e.keywords || [];
  });

  var kb = [];
  var categories = childPagesOf_(parentId, token);
  for (var c = 0; c < categories.length; c++) {
    var cat = categories[c];
    var topics = childPagesOf_(cat.id, token);
    for (var t = 0; t < topics.length; t++) {
      var topic = topics[t];
      var text = pageText_(topic.id, token);
      kb.push({
        category: cat.title,
        title: topic.title,
        content: text,
        notionUrl: 'https://www.notion.so/' + topic.id.replace(/-/g, ''),
        keywords: (seedKw[topic.title] || deriveKeywords_(topic.title, cat.title))
      });
    }
  }

  if (!kb.length) throw new Error('Sync found 0 topics — check that the parent page is shared with the integration.');

  writeSnapshot_(kb);
  props.setProperty('LAST_SYNC', new Date().toISOString());
  return { topicCount: kb.length, categories: categories.length, lastSync: props.getProperty('LAST_SYNC') };
}

// ---------- Notion helpers ----------

function notionGet_(path, token) {
  var res = UrlFetchApp.fetch('https://api.notion.com/v1' + path, {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION
    }
  });
  var code = res.getResponseCode();
  if (code === 429) { // rate limited — back off and retry once.
    Utilities.sleep(1500);
    return notionGet_(path, token);
  }
  if (code < 200 || code >= 300) {
    throw new Error('Notion API ' + code + ' on ' + path + ': ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/** All child blocks of a block/page id (handles pagination). */
function blockChildren_(id, token) {
  var out = [], cursor = '';
  do {
    var path = '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
    var data = notionGet_(path, token);
    Utilities.sleep(NOTION_PAUSE_MS);
    out = out.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : '';
  } while (cursor);
  return out;
}

/** Direct child pages (title + id) of a page. */
function childPagesOf_(id, token) {
  return blockChildren_(id, token)
    .filter(function (b) { return b.type === 'child_page'; })
    .map(function (b) { return { id: b.id, title: (b.child_page && b.child_page.title) || 'Untitled' }; });
}

/** Convert a topic page's blocks to plain text. */
function pageText_(id, token) {
  return blocksToText_(blockChildren_(id, token), token, 0).replace(/\n{3,}/g, '\n\n').trim();
}

function richText_(rt) {
  if (!rt || !rt.length) return '';
  return rt.map(function (r) { return r.plain_text || ''; }).join('');
}

function blocksToText_(blocks, token, depth) {
  var lines = [];
  var indent = depth > 0 ? '  ' : '';
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i], type = b.type, data = b[type], txt = '';
    if (!data) continue;
    switch (type) {
      case 'child_page': continue; // don't recurse into nested pages
      case 'heading_1': txt = '# ' + richText_(data.rich_text); break;
      case 'heading_2': txt = '## ' + richText_(data.rich_text); break;
      case 'heading_3': txt = '### ' + richText_(data.rich_text); break;
      case 'bulleted_list_item':
      case 'numbered_list_item': txt = indent + '- ' + richText_(data.rich_text); break;
      case 'to_do': txt = indent + '- [' + (data.checked ? 'x' : ' ') + '] ' + richText_(data.rich_text); break;
      case 'quote': txt = '> ' + richText_(data.rich_text); break;
      case 'callout': txt = richText_(data.rich_text); break;
      case 'toggle': txt = richText_(data.rich_text); break;
      case 'code': txt = richText_(data.rich_text); break;
      case 'paragraph': txt = richText_(data.rich_text); break;
      case 'table': txt = tableText_(b.id, token); break;
      default: txt = data.rich_text ? richText_(data.rich_text) : '';
    }
    if (txt) lines.push(txt);
    // Recurse into nested children (lists/toggles), but not tables/pages.
    if (b.has_children && type !== 'table' && type !== 'child_page' && depth < 3) {
      var child = blocksToText_(blockChildren_(b.id, token), token, depth + 1);
      if (child) lines.push(child);
    }
  }
  return lines.join('\n');
}

/** Render a Notion table as pipe-separated rows. */
function tableText_(tableId, token) {
  var rows = blockChildren_(tableId, token).filter(function (r) { return r.type === 'table_row'; });
  return rows.map(function (r) {
    return '| ' + (r.table_row.cells || []).map(function (cell) { return richText_(cell); }).join(' | ') + ' |';
  }).join('\n');
}

function deriveKeywords_(title, category) {
  var words = {};
  (title + ' ' + category).toLowerCase().replace(/[^a-z ]/g, ' ')
    .split(/\s+/).forEach(function (w) { if (w.length >= 3) words[w] = true; });
  return Object.keys(words);
}

// ---------- Drive snapshot ----------

function writeSnapshot_(kb) {
  var props = PropertiesService.getScriptProperties();
  var json = JSON.stringify(kb);
  var id = props.getProperty('KB_FILE_ID');
  var file = null;
  if (id) { try { file = DriveApp.getFileById(id); } catch (err) { file = null; } }
  if (file) {
    file.setContent(json);
  } else {
    file = DriveApp.createFile('telda_kb_snapshot.json', json, 'application/json');
    props.setProperty('KB_FILE_ID', file.getId());
  }
}
