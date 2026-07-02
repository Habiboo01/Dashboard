/**
 * WFM Adherence Dashboard — server engine (Google Apps Script, V8).
 *
 * Reads raw agent status data + roster + exceptions from the bound Google Sheet,
 * reconstructs shifts, scores them against the adherence rules, applies the typed
 * Exceptions engine, and returns a compact payload for WFM.html (agents x dates matrix).
 *
 * Tabs expected in the bound spreadsheet (see SETUP.md):
 *   Raw_Status_Log  - the agent_status_timeline export (16 cols).
 *   Schedule        - wide weekly roster grid (Name | Manager | Priority | AL Balance | <date cols>).
 *   Exceptions      - typed exceptions (agent_id | agent_name | date | rule | minutes | from_aux | to_aux | reason).
 *   Agents          - agent_id | agent_name | agent_email | Include in Reports.
 *   Aux_Config      - optional: status_name | bucket  (bucket = productive|shrinkage|nonproductive|neutral).
 */

/* ============================== CONFIG ============================== */

var CONFIG = {
  SHIFT_HOURS: 9,                 // paid shift length (incl. 1h break)
  SHIFT_MINUTES: 9 * 60,          // 540
  BREAK_TARGET_MIN: 60,           // total break target
  BREAK_TOLERANCE_MIN: 5,         // +/- tolerance on the total
  BREAK_SEGMENT_MAX_MIN: 30,      // no single break over this
  BREAK_MIN_SEGMENTS: 2,
  BREAK_MAX_SEGMENTS: 3,
  BREAK_EDGE_WINDOW_MIN: 60,      // no break in first/last hour
  OFFLINE_CAP_MIN: 20,            // upcoming-offline allowance
  LATE_GRACE_MIN: 5,
  SHIFT_SPLIT_GAP_MIN: 120,       // an Unavailable gap longer than this ends a shift
  LOGIN_MATCH_WINDOW_MIN: 180,    // login within this of a scheduled start binds to it
  SHRINKAGE_MODE: 'unplanned',    // 'unplanned' (excuse allowed break/offline) | 'gross'
  CANONICAL_START_HOURS: [0, 9, 12, 15, 18, 21, 3]  // fallback snap targets when no roster
};

// Default status -> bucket mapping (overridable via the Aux_Config tab).
var DEFAULT_AUX_BUCKETS = {
  'Available': 'productive',
  'Calls': 'shrinkage',
  'Meeting': 'shrinkage',
  'Jira': 'shrinkage',
  'Email': 'shrinkage',
  'Break': 'nonproductive',
  'Personal Time': 'nonproductive',
  'Upcoming Offline': 'nonproductive',
  'Unavailable': 'nonproductive',
  'System Issue': 'neutral'
};

var TZ = (function () {
  try { return Session.getScriptTimeZone() || 'Etc/GMT'; } catch (e) { return 'Etc/GMT'; }
})();

/* ============================== WEB APP ============================== */

function doGet() {
  return HtmlService.createTemplateFromFile('WFM')
    .evaluate()
    .setTitle('WFM Adherence Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Allows <?!= include('file') ?> style includes if we later split HTML/CSS/JS. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ========================= SHEET READING ========================= */

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function readSheetObjects_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) return { headers: [], rows: [] };
  var values = sh.getDataRange().getValues();
  if (!values.length) return { headers: [], rows: [] };
  var headers = values[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var isEmpty = row.every(function (c) { return c === '' || c === null; });
    if (isEmpty) continue;
    var obj = {};
    for (var c = 0; c < headers.length; c++) obj[headers[c]] = row[c];
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

function readAgents_() {
  var data = readSheetObjects_('Agents');
  var byId = {}, byName = {};
  data.rows.forEach(function (r) {
    var id = normId_(r['agent_id']);
    if (!id) return;
    var inc = r['Include in Reports'];
    var included = !(inc === false || String(inc).toUpperCase() === 'FALSE' || inc === 0);
    var a = { id: id, name: String(r['agent_name'] || '').trim(),
              email: String(r['agent_email'] || '').trim(), included: included };
    byId[id] = a;
    if (a.name) byName[a.name.toLowerCase()] = a;
  });
  return { byId: byId, byName: byName };
}

/** Config tab (setting | value) overrides the CONFIG thresholds. Call before scoring. */
var CONFIG_MAP = {
  shift_hours: 'SHIFT_HOURS',
  break_target_min: 'BREAK_TARGET_MIN',
  break_tolerance_min: 'BREAK_TOLERANCE_MIN',
  break_segment_max_min: 'BREAK_SEGMENT_MAX_MIN',
  break_min_segments: 'BREAK_MIN_SEGMENTS',
  break_max_segments: 'BREAK_MAX_SEGMENTS',
  break_edge_window_min: 'BREAK_EDGE_WINDOW_MIN',
  offline_cap_min: 'OFFLINE_CAP_MIN',
  late_grace_min: 'LATE_GRACE_MIN',
  shift_split_gap_min: 'SHIFT_SPLIT_GAP_MIN',
  login_match_window_min: 'LOGIN_MATCH_WINDOW_MIN'
};

function applyConfigOverrides_() {
  var data = readSheetObjects_('Config');
  data.rows.forEach(function (r) {
    var k = String(r['setting'] || '').trim().toLowerCase();
    var v = r['value'];
    if (k === 'shrinkage_mode') { if (v) CONFIG.SHRINKAGE_MODE = String(v).trim().toLowerCase(); return; }
    if (CONFIG_MAP[k] && v !== '' && v != null && isFinite(parseFloat(v))) CONFIG[CONFIG_MAP[k]] = parseFloat(v);
  });
  CONFIG.SHIFT_MINUTES = CONFIG.SHIFT_HOURS * 60;
}

function getRulesSnapshot_() {
  var out = { shrinkage_mode: CONFIG.SHRINKAGE_MODE };
  Object.keys(CONFIG_MAP).forEach(function (k) { out[k] = CONFIG[CONFIG_MAP[k]]; });
  return out;
}

/** Current rule config for the UI. */
function getConfig() {
  applyConfigOverrides_();
  return getRulesSnapshot_();
}

/** Write the rule config back to the Config tab (creates it if missing), returns fresh data. */
function saveConfig(obj) {
  var sh = ss_().getSheetByName('Config');
  if (!sh) sh = ss_().insertSheet('Config');
  sh.clear();
  var rows = [['setting', 'value']];
  Object.keys(obj).forEach(function (k) { rows.push([k, obj[k]]); });
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  return getDashboardData();
}

function readAuxBuckets_() {
  var map = {};
  Object.keys(DEFAULT_AUX_BUCKETS).forEach(function (k) { map[k] = DEFAULT_AUX_BUCKETS[k]; });
  var data = readSheetObjects_('Aux_Config');
  data.rows.forEach(function (r) {
    var s = String(r['status_name'] || '').trim();
    var b = String(r['bucket'] || '').trim().toLowerCase();
    if (s && b) map[s] = b;
  });
  return map;
}

/** Raw_Status_Log -> statuses grouped by agent id. */
function readRawStatuses_() {
  var data = readSheetObjects_('Raw_Status_Log');
  var byAgent = {};
  data.rows.forEach(function (r) {
    var id = normId_(r['agent_added_id']);
    if (!id) return;
    var start = toDate_(r['status_start']);
    if (!start) return;
    var end = toDate_(r['status_end']);
    var dur = numOrNull_(r['duration_min']);
    if (dur == null && end) dur = (end - start) / 60000;
    var st = {
      agentId: id,
      agentName: String(r['agent_name'] || '').trim(),
      status: String(r['status_name'] || '').trim(),
      category: String(r['status_category'] || '').trim(),
      channel: String(r['channel'] || '').trim(),
      start: start,
      end: end,
      durMin: dur
    };
    (byAgent[id] = byAgent[id] || []).push(st);
  });
  Object.keys(byAgent).forEach(function (id) {
    byAgent[id].sort(function (a, b) { return a.start - b.start; });
  });
  return byAgent;
}

/**
 * Schedule (wide weekly grid) -> { agentId: { 'yyyy-MM-dd': {startHour|null, off:bool, code} } }.
 * Tolerant parser: finds the 'Name' header row, treats columns after the last fixed
 * column as date columns, and derives each column's date from the header (Date value,
 * or strings like "Wed 1-Jul" / "1-Jul"). Multiple stacked week-blocks are supported
 * because each column carries its own date.
 */
function readSchedule_(agents, rawYearHint) {
  var sh = ss_().getSheetByName('Schedule');
  var out = {};
  if (!sh) return out;
  var values = sh.getDataRange().getValues();
  if (!values.length) return out;

  var FIXED = ['name', 'manager', 'priority', 'al balance'];
  for (var hr = 0; hr < values.length; hr++) {
    var row = values[hr];
    var lc = row.map(function (c) { return String(c == null ? '' : c).trim().toLowerCase(); });
    var nameCol = lc.indexOf('name');
    if (nameCol === -1) continue;

    // Determine where date columns begin (after the fixed columns present in this header).
    var firstDateCol = nameCol + 1;
    for (var c = nameCol; c < lc.length; c++) {
      if (FIXED.indexOf(lc[c]) !== -1) firstDateCol = c + 1;
    }

    // Build column -> date map from this header row (fall back to the row above for a date).
    var colDate = {};
    for (var c2 = firstDateCol; c2 < row.length; c2++) {
      var d = parseHeaderDate_(row[c2], rawYearHint);
      if (!d && hr > 0) d = parseHeaderDate_(values[hr - 1][c2], rawYearHint);
      if (d) colDate[c2] = ymd_(d);
    }
    if (!Object.keys(colDate).length) continue; // not a real schedule header, keep scanning

    // Data rows below this header.
    for (var dr = hr + 1; dr < values.length; dr++) {
      var drow = values[dr];
      var nm = String(drow[nameCol] == null ? '' : drow[nameCol]).trim();
      if (!nm) continue;
      if (String(nm).toLowerCase() === 'name') break; // next header block
      var agent = agents.byName[nm.toLowerCase()];
      var aid = agent ? agent.id : null;
      if (!aid) continue;
      out[aid] = out[aid] || {};
      Object.keys(colDate).forEach(function (cc) {
        var cell = drow[cc];
        var parsed = parseShiftCell_(cell);
        out[aid][colDate[cc]] = parsed;
      });
    }
    break; // first valid header block anchors parsing
  }
  return out;
}

function readExceptions_(agents) {
  var data = readSheetObjects_('Exceptions');
  var list = [];
  data.rows.forEach(function (r) {
    var id = normId_(r['agent_id']);
    if (!id && r['agent_name']) {
      var a = agents.byName[String(r['agent_name']).trim().toLowerCase()];
      if (a) id = a.id;
    }
    var d = toDate_(r['date']);
    if (!id || !d) return;
    list.push({
      agentId: id,
      date: ymd_(d),
      rule: String(r['rule'] || '').trim().toLowerCase(),
      minutes: numOrNull_(r['minutes']),
      fromAux: String(r['from_aux'] || '').trim(),
      toAux: String(r['to_aux'] || '').trim(),
      reason: String(r['reason'] || '').trim()
    });
  });
  return list;
}

/* ========================= SHIFT ENGINE ========================= */

/**
 * Group an agent's ordered statuses into shifts.
 * A shift boundary is an 'Unavailable' block longer than SHIFT_SPLIT_GAP_MIN
 * (a real between-shift/day-off gap), or a plain time gap of the same size.
 */
function buildShifts_(statuses) {
  var shifts = [];
  var cur = null;
  function close() { if (cur && cur.statuses.length) shifts.push(cur); cur = null; }

  for (var i = 0; i < statuses.length; i++) {
    var st = statuses[i];
    var isUnavail = /unavailable/i.test(st.status);
    var span = st.durMin != null ? st.durMin
             : (st.end ? (st.end - st.start) / 60000 : null);
    var bigGap = isUnavail && (span == null || span > CONFIG.SHIFT_SPLIT_GAP_MIN);

    // A large plain time gap before this status also splits shifts.
    if (cur && cur.lastEnd) {
      var gap = (st.start - cur.lastEnd) / 60000;
      if (gap > CONFIG.SHIFT_SPLIT_GAP_MIN) close();
    }

    if (bigGap) { close(); continue; }
    if (!cur) cur = { statuses: [], start: st.start, lastEnd: null };
    cur.statuses.push(st);
    cur.lastEnd = st.end || st.start;
  }
  close();
  return shifts;
}

/** Score one shift against all rules; returns a metrics object (pre-exception). */
function scoreShift_(shift, agent, schedForAgent, auxBuckets) {
  var login = shift.start;
  var logout = shift.lastEnd || shift.start;

  // --- scheduled start (roster first, else canonical snap) ---
  var sched = resolveScheduledStart_(login, schedForAgent);
  var scheduledStart = sched.start;               // Date
  var offScheduled = sched.off;                   // true if roster says WO/AL/CL
  var startHour = scheduledStart;
  var shiftEndExpected = new Date(scheduledStart.getTime() + CONFIG.SHIFT_MINUTES * 60000);

  // --- lateness ---
  // Report the FULL minutes late (matching the workbook); the grace only decides
  // whether it counts as a violation, it is not subtracted from the reported minutes.
  var lateMin = 0, isLate = false;
  if (!offScheduled) {
    var lateRaw = (login - scheduledStart) / 60000;
    if (lateRaw > CONFIG.LATE_GRACE_MIN) { isLate = true; lateMin = Math.round(lateRaw); }
  }

  // --- worked span & short-shift shortfall ---
  var workedMin = Math.round((logout - login) / 60000);
  var shortfallMin = offScheduled ? 0 : Math.max(0, CONFIG.SHIFT_MINUTES - workedMin);

  // --- overtime: rostered OFF (WO/AL/CL) but the agent actually worked ---
  var isOvertime = offScheduled && workedMin > 0;
  var overtimeMin = isOvertime ? workedMin : 0;
  var offCode = sched.code || '';

  // --- aux tallies ---
  var auxMin = {};                                // status -> minutes
  var breakSegs = [];
  var firstHourEnd = new Date(scheduledStart.getTime() + CONFIG.BREAK_EDGE_WINDOW_MIN * 60000);
  var lastHourStart = new Date(shiftEndExpected.getTime() - CONFIG.BREAK_EDGE_WINDOW_MIN * 60000);
  var breakInFirstHour = false, breakInLastHour = false;

  shift.statuses.forEach(function (st) {
    var m = st.durMin != null ? st.durMin : (st.end ? (st.end - st.start) / 60000 : 0);
    m = m || 0;
    auxMin[st.status] = (auxMin[st.status] || 0) + m;
    if (/^break$/i.test(st.status)) {
      breakSegs.push({ start: st.start, end: st.end || st.start, min: m });
      if (st.start < firstHourEnd) breakInFirstHour = true;
      var segEnd = st.end || st.start;
      if (segEnd > lastHourStart) breakInLastHour = true;
    }
  });

  // --- break rules ---
  var totalBreak = round1_(sum_(breakSegs.map(function (s) { return s.min; })));
  var segCount = breakSegs.length;
  var segTooLong = breakSegs.some(function (s) { return s.min > CONFIG.BREAK_SEGMENT_MAX_MIN; });
  var breakOverMin = round1_(sum_(breakSegs.map(function (s) {
    return Math.max(0, s.min - CONFIG.BREAK_SEGMENT_MAX_MIN);
  })));
  var totalMismatch = segCount > 0 &&
    Math.abs(totalBreak - CONFIG.BREAK_TARGET_MIN) > CONFIG.BREAK_TOLERANCE_MIN;
  var segCountBad = segCount > 0 &&
    (segCount < CONFIG.BREAK_MIN_SEGMENTS || segCount > CONFIG.BREAK_MAX_SEGMENTS);

  var breakRules = [];
  if (segTooLong) breakRules.push('segment>30');
  if (breakInFirstHour) breakRules.push('first-hour');
  if (breakInLastHour) breakRules.push('last-hour');
  if (segCountBad) breakRules.push('segments!=2-3');
  if (totalMismatch) breakRules.push('total!=60±5');
  var breakExceeded = breakRules.length > 0;

  // --- offline ---
  var totalOffline = round1_(auxMin['Upcoming Offline'] || 0);
  var offlineExcess = round1_(Math.max(0, totalOffline - CONFIG.OFFLINE_CAP_MIN));
  var offlineExceeded = offlineExcess > 0;

  // --- bucket minutes ---
  var buckets = computeBuckets_(auxMin, auxBuckets, totalBreak, totalOffline);

  // On an unscheduled (overtime) day, don't score adherence violations — the agent
  // wasn't rostered, so lateness/break/offline/short-shift flags don't apply. The
  // worked time is counted as overtime and durations are kept for reference.
  if (offScheduled) {
    isLate = false; lateMin = 0;
    breakExceeded = false; breakRules = []; breakOverMin = 0;
    offlineExceeded = false; offlineExcess = 0;
    shortfallMin = 0;
  }

  // --- total lost minutes the agent should compensate (on-queue shortfall) ---
  // Expected on-queue time = full shift - allowed break - allowed offline. Whatever the agent
  // did NOT cover with Available + other productive auxes (Calls/Meeting/Jira/Email) is "lost".
  // Late arrival, early leave, extra break/offline, personal time and unavailable all reduce the
  // covered time and therefore raise lost automatically. Zero on overtime days.
  var expectedOnQueue = CONFIG.SHIFT_MINUTES - CONFIG.BREAK_TARGET_MIN - CONFIG.OFFLINE_CAP_MIN;
  var coveredMin = (buckets.productive || 0) + (buckets.shrinkageAux || 0);
  var lostMin = offScheduled ? 0 : round1_(Math.max(0, expectedOnQueue - coveredMin));

  return {
    agentId: agent.id,
    agentName: agent.name,
    date: ymd_(scheduledStart),
    loginDate: ymd_(login),
    scheduledStart: iso_(scheduledStart),
    login: iso_(login),
    logout: iso_(logout),
    offScheduled: offScheduled,
    offCode: offCode,
    isOvertime: isOvertime,
    overtimeMin: overtimeMin,
    lateMin: lateMin,
    isLate: isLate,
    workedMin: workedMin,
    shortfallMin: shortfallMin,
    lostMin: lostMin,
    totalBreak: totalBreak,
    breakSegments: segCount,
    breakOverMin: breakOverMin,
    breakRules: breakRules,
    breakExceeded: breakExceeded,
    totalOffline: totalOffline,
    offlineExcess: offlineExcess,
    offlineExceeded: offlineExceeded,
    auxMin: roundMap_(auxMin),
    buckets: buckets,
    statuses: shift.statuses.map(function (s) {
      return { status: s.status, start: iso_(s.start), end: s.end ? iso_(s.end) : null,
               min: round1_(s.durMin != null ? s.durMin : 0) };
    }),
    appliedExceptions: []
  };
}

/** Split aux minutes into productive/shrinkage/nonproductive and compute shrinkage%. */
function computeBuckets_(auxMin, auxBuckets, totalBreak, totalOffline) {
  var productive = 0, shrinkageAux = 0, personalTime = 0, inShiftUnavail = 0, neutral = 0;
  Object.keys(auxMin).forEach(function (status) {
    var b = auxBuckets[status] || 'neutral';
    var m = auxMin[status];
    if (/^break$/i.test(status)) return;            // handled via allowance below
    if (/^upcoming offline$/i.test(status)) return; // handled via allowance below
    if (/^personal time$/i.test(status)) { personalTime += m; return; }
    if (/^unavailable$/i.test(status)) { inShiftUnavail += m; return; }
    if (b === 'productive') productive += m;
    else if (b === 'shrinkage') shrinkageAux += m;
    else if (b === 'nonproductive') inShiftUnavail += m; // custom nonprod status
    else neutral += m;
  });

  var breakExcess = Math.max(0, totalBreak - CONFIG.BREAK_TARGET_MIN);
  var offlineExcess = Math.max(0, totalOffline - CONFIG.OFFLINE_CAP_MIN);

  var shrinkNumerator;
  if (CONFIG.SHRINKAGE_MODE === 'gross') {
    shrinkNumerator = shrinkageAux + personalTime + totalBreak + totalOffline + inShiftUnavail;
  } else { // unplanned: excuse the allowed 60 break + 20 offline
    shrinkNumerator = shrinkageAux + personalTime + breakExcess + offlineExcess + inShiftUnavail;
  }
  var pct = CONFIG.SHIFT_MINUTES > 0
    ? round1_((shrinkNumerator / CONFIG.SHIFT_MINUTES) * 100) : 0;

  return {
    productive: round1_(productive),
    shrinkageAux: round1_(shrinkageAux),
    personalTime: round1_(personalTime),
    breakExcess: round1_(breakExcess),
    offlineExcess: round1_(offlineExcess),
    inShiftUnavail: round1_(inShiftUnavail),
    nonProductive: round1_(personalTime + breakExcess + offlineExcess + inShiftUnavail),
    shrinkageMin: round1_(shrinkNumerator),
    shrinkagePct: pct
  };
}

/** Bind a login time to a roster start, else snap to the nearest canonical start hour. */
function resolveScheduledStart_(login, schedForAgent) {
  var candidates = [];
  var loginYmd = ymd_(login);
  var prevYmd = ymd_(new Date(login.getTime() - 24 * 3600000));
  var nextYmd = ymd_(new Date(login.getTime() + 24 * 3600000));

  if (schedForAgent) {
    [prevYmd, loginYmd, nextYmd].forEach(function (d) {
      var cell = schedForAgent[d];
      if (!cell) return;
      if (cell.off) { candidates.push({ date: d, off: true, start: dateAt_(d, 0), code: cell.code || 'WO' }); return; }
      if (cell.startHour != null) candidates.push({ date: d, off: false, start: dateAt_(d, cell.startHour) });
    });
  }

  // Prefer the closest roster start within the match window.
  var best = null, bestDiff = Infinity;
  candidates.forEach(function (c) {
    if (c.off) return;
    var diff = Math.abs(login - c.start) / 60000;
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  });
  if (best && bestDiff <= CONFIG.LOGIN_MATCH_WINDOW_MIN) {
    return { start: best.start, off: false, code: '' };
  }

  // Roster explicitly marks the login day off (agent still logged in) -> overtime.
  var offToday = candidates.filter(function (c) { return c.off && c.date === loginYmd; });
  if (offToday.length && !candidates.some(function (c) { return !c.off; })) {
    return { start: dateAt_(loginYmd, login.getHours()), off: true, code: offToday[0].code };
  }

  // Fallback: snap to nearest canonical start on the login day (or adjacent for overnight).
  return { start: snapCanonical_(login), off: false, code: '' };
}

function snapCanonical_(login) {
  var best = null, bestDiff = Infinity;
  [-1, 0, 1].forEach(function (dayOff) {
    var base = new Date(login.getTime() + dayOff * 24 * 3600000);
    CONFIG.CANONICAL_START_HOURS.forEach(function (h) {
      var cand = dateAt_(ymd_(base), h);
      var diff = Math.abs(login - cand) / 60000;
      if (diff < bestDiff) { bestDiff = diff; best = cand; }
    });
  });
  return best;
}

/* ==================== TYPED EXCEPTIONS ENGINE ==================== */

/** Mutate a scored shift per the exceptions that match its agent/date, then recompute. */
function applyExceptions_(shift, exceptions, auxBuckets) {
  var matches = exceptions.filter(function (e) {
    return e.agentId === shift.agentId && (e.date === shift.date || e.date === shift.loginDate);
  });
  if (!matches.length) return;

  matches.forEach(function (e) {
    var rule = e.rule;
    if (!rule) {                          // blank -> suppress everything
      suppressLate_(shift, e); suppressBreak_(shift, e);
      suppressOffline_(shift, e); suppressShort_(shift, e);
      return;
    }
    if (rule === 'late') suppressLate_(shift, e);
    else if (rule === 'early_leave' || rule === 'early leave') suppressShort_(shift, e);
    else if (rule === 'break') suppressBreak_(shift, e);
    else if (rule === 'offline') suppressOffline_(shift, e);
    else if (rule === 'wrong_aux' || rule === 'wrong aux') applyWrongAux_(shift, e);
    else shift.appliedExceptions.push({ rule: rule, reason: e.reason, note: 'unrecognized rule' });
  });

  // Recompute derived buckets/shrinkage after any aux reclassification.
  var recomputed = computeBuckets_(mapFromRounded_(shift.auxMin), auxBuckets,
                                   shift.totalBreak, shift.totalOffline);
  shift.buckets = recomputed;
}

function suppressLate_(shift, e) {
  if (shift.lateMin > 0 || shift.isLate) {
    shift.appliedExceptions.push({ rule: 'late', reason: e.reason, removedMin: shift.lateMin });
  }
  shift.lateMin = 0; shift.isLate = false;
}

function suppressShort_(shift, e) {
  var credit = e.minutes != null ? e.minutes : shift.shortfallMin;
  var before = shift.shortfallMin;
  shift.shortfallMin = Math.max(0, shift.shortfallMin - credit);
  shift.workedMin = shift.workedMin + Math.min(credit, before);
  if (before > 0) shift.appliedExceptions.push({ rule: 'early_leave', reason: e.reason, creditedMin: Math.min(credit, before) });
}

function suppressBreak_(shift, e) {
  if (shift.breakExceeded) {
    shift.appliedExceptions.push({ rule: 'break', reason: e.reason, clearedRules: shift.breakRules.slice() });
  }
  shift.breakExceeded = false; shift.breakRules = []; shift.breakOverMin = 0;
}

function suppressOffline_(shift, e) {
  if (shift.offlineExceeded) {
    shift.appliedExceptions.push({ rule: 'offline', reason: e.reason, clearedMin: shift.offlineExcess });
  }
  shift.offlineExceeded = false; shift.offlineExcess = 0;
}

/** Move `minutes` from one aux to another (e.g. Upcoming Offline -> Meeting) and recompute offline. */
function applyWrongAux_(shift, e) {
  var from = e.fromAux, to = e.toAux;
  var mins = e.minutes;
  if (!from || !to) { shift.appliedExceptions.push({ rule: 'wrong_aux', reason: e.reason, note: 'missing from/to aux' }); return; }
  var have = shift.auxMin[from] || 0;
  if (mins == null) mins = have;
  mins = Math.min(mins, have);
  shift.auxMin[from] = round1_(have - mins);
  shift.auxMin[to] = round1_((shift.auxMin[to] || 0) + mins);

  // Recompute offline-derived numbers if offline was the source or target.
  if (/^upcoming offline$/i.test(from) || /^upcoming offline$/i.test(to)) {
    shift.totalOffline = round1_(shift.auxMin['Upcoming Offline'] || 0);
    shift.offlineExcess = round1_(Math.max(0, shift.totalOffline - CONFIG.OFFLINE_CAP_MIN));
    shift.offlineExceeded = shift.offlineExcess > 0;
  }
  shift.appliedExceptions.push({ rule: 'wrong_aux', reason: e.reason, movedMin: mins, from: from, to: to });
}

/* ========================= PUBLIC API ========================= */

/**
 * Main entry point for the client.
 * @param {Object} opts optional { from:'yyyy-MM-dd', to:'yyyy-MM-dd' } date window.
 * @return {Object} dashboard payload.
 */
function getDashboardData(opts) {
  opts = opts || {};
  applyConfigOverrides_();
  var agents = readAgents_();
  var auxBuckets = readAuxBuckets_();
  var rawByAgent = readRawStatuses_();
  var yearHint = inferYear_(rawByAgent);
  var schedule = readSchedule_(agents, yearHint);
  var exceptions = readExceptions_(agents);

  var agentIds = Object.keys(rawByAgent);
  var cells = {};          // agentId -> date -> metrics
  var dateSet = {};
  var agentMeta = {};

  agentIds.forEach(function (id) {
    var agent = agents.byId[id] || { id: id, name: (rawByAgent[id][0] || {}).agentName || id, included: true };
    if (!agent.included) return; // drop excluded agents entirely
    var shifts = buildShifts_(rawByAgent[id]);
    shifts.forEach(function (shift) {
      var scored = scoreShift_(shift, agent, schedule[id], auxBuckets);
      applyExceptions_(scored, exceptions, auxBuckets);
      var d = scored.date;
      dateSet[d] = true;
      cells[id] = cells[id] || {};
      // If two shifts land on the same date, merge (keep worst).
      cells[id][d] = cells[id][d] ? mergeShifts_(cells[id][d], scored) : scored;
      agentMeta[id] = { id: id, name: agent.name };
    });
  });

  var dates = Object.keys(dateSet).sort();
  if (opts.from) dates = dates.filter(function (d) { return d >= opts.from; });
  if (opts.to) dates = dates.filter(function (d) { return d <= opts.to; });

  var agentList = Object.keys(agentMeta).map(function (id) { return agentMeta[id]; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });

  return {
    generatedAt: new Date().toISOString(),
    timezone: TZ,
    config: {
      shiftMinutes: CONFIG.SHIFT_MINUTES, breakTarget: CONFIG.BREAK_TARGET_MIN,
      offlineCap: CONFIG.OFFLINE_CAP_MIN, lateGrace: CONFIG.LATE_GRACE_MIN,
      shrinkageMode: CONFIG.SHRINKAGE_MODE
    },
    rules: getRulesSnapshot_(),
    auxBuckets: auxBuckets,
    agents: agentList,
    dates: dates,
    cells: cells,
    totals: buildTotals_(agentList, dates, cells)
  };
}

/** Add or update an Exceptions row, then return fresh dashboard data. */
function saveException(row) {
  var sh = ss_().getSheetByName('Exceptions');
  if (!sh) throw new Error('Exceptions tab not found');
  var headers = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var need = ['agent_id', 'agent_name', 'date', 'rule', 'minutes', 'from_aux', 'to_aux', 'reason'];
  if (headers.filter(String).length === 0) {
    sh.getRange(1, 1, 1, need.length).setValues([need]);
    headers = need;
  }
  var rowVals = headers.map(function (h) { return row[h] != null ? row[h] : ''; });
  sh.appendRow(rowVals);
  return getDashboardData();
}

function deleteException(index1Based) {
  var sh = ss_().getSheetByName('Exceptions');
  if (sh && index1Based >= 2) sh.deleteRow(index1Based);
  return getDashboardData();
}

function listExceptions() {
  return readSheetObjects_('Exceptions').rows;
}

/* ========================= AGGREGATION ========================= */

function mergeShifts_(a, b) {
  // Keep the more severe shift for the day but sum minutes-based metrics.
  var m = JSON.parse(JSON.stringify(a));
  m.lateMin = Math.max(a.lateMin, b.lateMin);
  m.isLate = a.isLate || b.isLate;
  m.breakExceeded = a.breakExceeded || b.breakExceeded;
  m.breakOverMin = a.breakOverMin + b.breakOverMin;
  m.breakRules = a.breakRules.concat(b.breakRules);
  m.offlineExcess = a.offlineExcess + b.offlineExcess;
  m.offlineExceeded = a.offlineExceeded || b.offlineExceeded;
  m.shortfallMin = Math.max(a.shortfallMin, b.shortfallMin);
  m.lostMin = (a.lostMin || 0) + (b.lostMin || 0);
  m.isOvertime = a.isOvertime || b.isOvertime;
  m.overtimeMin = (a.overtimeMin || 0) + (b.overtimeMin || 0);
  m.buckets.shrinkagePct = Math.max(a.buckets.shrinkagePct, b.buckets.shrinkagePct);
  m.appliedExceptions = a.appliedExceptions.concat(b.appliedExceptions);
  return m;
}

function buildTotals_(agentList, dates, cells) {
  var perAgent = {}, perDate = {};
  agentList.forEach(function (a) {
    perAgent[a.id] = { lateMin: 0, lateCnt: 0, breakMin: 0, breakCnt: 0,
                       offlineMin: 0, offlineCnt: 0, shortMin: 0, shrinkSum: 0, shifts: 0 };
  });
  dates.forEach(function (d) {
    perDate[d] = { lateMin: 0, lateCnt: 0, breakMin: 0, breakCnt: 0,
                   offlineMin: 0, offlineCnt: 0, shortMin: 0, shrinkSum: 0, shifts: 0 };
  });
  agentList.forEach(function (a) {
    dates.forEach(function (d) {
      var c = cells[a.id] && cells[a.id][d];
      if (!c) return;
      [perAgent[a.id], perDate[d]].forEach(function (t) {
        t.shifts++;
        t.lateMin += c.lateMin; t.lateCnt += c.isLate ? 1 : 0;
        t.breakMin += c.breakOverMin; t.breakCnt += c.breakExceeded ? 1 : 0;
        t.offlineMin += c.offlineExcess; t.offlineCnt += c.offlineExceeded ? 1 : 0;
        t.shortMin += c.shortfallMin; t.shrinkSum += c.buckets.shrinkagePct;
      });
    });
  });
  return { perAgent: perAgent, perDate: perDate };
}

/* ========================= HELPERS ========================= */

function normId_(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return String(Math.round(v));
  var s = String(v).trim();
  var n = parseFloat(s);
  return isFinite(n) && String(n) === s ? String(Math.round(n)) : s;
}
function numOrNull_(v) {
  if (v == null || v === '') return null;
  var n = parseFloat(v);
  return isFinite(n) ? n : null;
}
function toDate_(v) {
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v) ? null : v;
  var d = new Date(v);
  return isNaN(d) ? null : d;
}
function sum_(arr) { return arr.reduce(function (a, b) { return a + (b || 0); }, 0); }
function round1_(n) { return Math.round((n || 0) * 10) / 10; }
function roundMap_(m) { var o = {}; Object.keys(m).forEach(function (k) { o[k] = round1_(m[k]); }); return o; }
function mapFromRounded_(m) { var o = {}; Object.keys(m).forEach(function (k) { o[k] = m[k]; }); return o; }

function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function iso_(d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ss"); }
function dateAt_(ymdStr, hour) {
  var p = ymdStr.split('-');
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10), hour, 0, 0);
}

function inferYear_(rawByAgent) {
  var ids = Object.keys(rawByAgent);
  for (var i = 0; i < ids.length; i++) {
    var arr = rawByAgent[ids[i]];
    if (arr && arr.length) return arr[0].start.getFullYear();
  }
  return new Date().getFullYear();
}

/** Parse a schedule header cell into a Date. Accepts Date, "1-Jul", "Wed 1-Jul", "Jul 1". */
function parseHeaderDate_(v, yearHint) {
  if (!v && v !== 0) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v) ? null : v;
  var s = String(v).trim();
  if (!s) return null;
  var months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  var m = s.match(/(\d{1,2})\s*[-\/\s]\s*([A-Za-z]{3,})/); // "1-Jul", "1 Jul"
  if (m) {
    var mon = months[m[2].slice(0, 3).toLowerCase()];
    if (mon != null) return new Date(yearHint, mon, parseInt(m[1], 10));
  }
  m = s.match(/([A-Za-z]{3,})\s*[-\/\s]\s*(\d{1,2})/); // "Jul 1"
  if (m) {
    var mon2 = months[m[1].slice(0, 3).toLowerCase()];
    if (mon2 != null) return new Date(yearHint, mon2, parseInt(m[2], 10));
  }
  var d = new Date(s);
  return isNaN(d) ? null : d;
}

/** Parse a schedule cell into { startHour, off, code }. */
function parseShiftCell_(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return { startHour: null, off: true, code: '' };
  var up = s.toUpperCase();
  if (up === 'WO' || up === 'AL' || up === 'CL' || up === 'OFF' || up === 'DAY OFF') {
    return { startHour: null, off: true, code: up };
  }
  // "9 AM", "12 PM", "3 AM", "9AM", "09:00"
  var m = s.match(/(\d{1,2})\s*(AM|PM)/i);
  if (m) {
    var h = parseInt(m[1], 10) % 12;
    if (/pm/i.test(m[2])) h += 12;
    return { startHour: h, off: false, code: s };
  }
  m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return { startHour: parseInt(m[1], 10), off: false, code: s };
  m = s.match(/^(\d{1,2})$/);
  if (m) return { startHour: parseInt(m[1], 10), off: false, code: s };
  return { startHour: null, off: true, code: s }; // unknown -> treat as off/no shift
}
