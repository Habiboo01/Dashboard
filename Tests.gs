/**
 * Lightweight self-tests for the WFM engine.
 * Run `runTests` from the Apps Script editor; results print to the execution log.
 * These build synthetic shifts (no sheet needed) so the scoring logic can be
 * verified independently of the live Google Sheet.
 */

function runTests() {
  var results = [];
  function check(name, cond, extra) {
    results.push((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' :: ' + extra : ''));
  }

  var agent = { id: '18', name: 'Test Agent', included: true };
  var auxBuckets = readAuxBuckets_ ? DEFAULT_AUX_BUCKETS : DEFAULT_AUX_BUCKETS;

  // --- Case 1: overnight 00:00 shift, single 35min break in first hour, late 43min ---
  // login 00:43, break 00:50-01:25 (35m), then available until 09:00.
  var day = '2026-06-01';
  var s1 = mkShift_([
    st_('Available', day + 'T00:43:00', day + 'T00:50:00'),
    st_('Break', day + 'T00:50:00', day + 'T01:25:06'),      // 35.1m, first hour, >30
    st_('Available', day + 'T01:25:06', day + 'T09:00:00')
  ]);
  var m1 = scoreShift_(s1, agent, { '2026-06-01': { startHour: 0, off: false } }, auxBuckets);
  check('C1 late≈43 (full minutes)', Math.abs(m1.lateMin - 43) <= 1, 'got ' + m1.lateMin);
  check('C1 break exceeded', m1.breakExceeded === true, m1.breakRules.join('|'));
  check('C1 break first-hour flagged', m1.breakRules.indexOf('first-hour') >= 0, m1.breakRules.join('|'));
  check('C1 segment>30 flagged', m1.breakRules.indexOf('segment>30') >= 0, m1.breakRules.join('|'));

  // --- Case 2: offline exceedance (33.8m offline > 20 cap) ---
  var s2 = mkShift_([
    st_('Available', day + 'T15:00:00', day + 'T15:30:00'),
    st_('Upcoming Offline', day + 'T15:30:00', day + 'T16:03:48'), // 33.8m
    st_('Available', day + 'T16:03:48', day + 'T18:00:00'),
    st_('Break', day + 'T18:00:00', day + 'T18:30:00'),
    st_('Break', day + 'T20:00:00', day + 'T20:30:00'),
    st_('Available', day + 'T20:30:00', day + 'T23:59:00')
  ]);
  var m2 = scoreShift_(s2, agent, { '2026-06-01': { startHour: 15, off: false } }, auxBuckets);
  check('C2 offline exceeded', m2.offlineExceeded === true, 'excess ' + m2.offlineExcess);
  check('C2 offline excess≈13.8', Math.abs(m2.offlineExcess - 13.8) < 1, 'got ' + m2.offlineExcess);
  check('C2 not late (on time)', m2.isLate === false, 'late ' + m2.lateMin);

  // --- Case 3: exceptions engine ---
  // late exception clears lateness.
  applyExceptions_(m1, [{ agentId: '18', date: '2026-06-01', rule: 'late', reason: 'transportation delay' }], auxBuckets);
  check('C3 late suppressed', m1.isLate === false && m1.lateMin === 0);
  check('C3 late exception recorded', m1.appliedExceptions.some(function (e) { return e.rule === 'late'; }));

  // wrong_aux: move 13.8m from Upcoming Offline to Meeting -> offline no longer exceeds.
  applyExceptions_(m2, [{ agentId: '18', date: '2026-06-01', rule: 'wrong_aux', minutes: 13.8, fromAux: 'Upcoming Offline', toAux: 'Meeting', reason: 'was a meeting' }], auxBuckets);
  check('C3 wrong_aux drops offline excess', m2.offlineExceeded === false, 'excess now ' + m2.offlineExcess);

  // --- Case 4: early leave short shift ---
  var s4 = mkShift_([ st_('Available', day + 'T09:00:00', day + 'T17:00:00') ]); // 8h worked
  var m4 = scoreShift_(s4, agent, { '2026-06-01': { startHour: 9, off: false } }, auxBuckets);
  check('C4 short by ~60m', Math.abs(m4.shortfallMin - 60) <= 2, 'got ' + m4.shortfallMin);
  applyExceptions_(m4, [{ agentId: '18', date: '2026-06-01', rule: 'early_leave', minutes: 60, reason: 'approved' }], auxBuckets);
  check('C4 short cleared by exception', m4.shortfallMin === 0, 'got ' + m4.shortfallMin);

  // --- Case 5: overtime (worked on a rostered WO day) ---
  var s5 = mkShift_([ st_('Available', day + 'T09:00:00', day + 'T14:00:00') ]); // 5h on a WO day
  var m5 = scoreShift_(s5, agent, { '2026-06-01': { startHour: null, off: true, code: 'WO' } }, auxBuckets);
  check('C5 overtime flagged', m5.isOvertime === true, 'code ' + m5.offCode);
  check('C5 overtime ~300m', Math.abs(m5.overtimeMin - 300) <= 2, 'got ' + m5.overtimeMin);
  check('C5 no late on WO day', m5.isLate === false);
  check('C5 no short-shift on WO day', m5.shortfallMin === 0, 'got ' + m5.shortfallMin);

  // --- Case 6: total lost minutes to compensate ---
  // 9:00 start, login 9:20 (late 20), single 40m break (over 60? no; over 30 seg), leaves 16:40 (short).
  var s6 = mkShift_([
    st_('Available', day + 'T09:20:00', day + 'T12:00:00'),
    st_('Break', day + 'T12:00:00', day + 'T12:40:00'),       // 40m break (excess over 60 = 0)
    st_('Personal Time', day + 'T12:40:00', day + 'T13:00:00'),// 20m personal
    st_('Available', day + 'T13:00:00', day + 'T16:40:00')
  ]);
  var m6 = scoreShift_(s6, agent, { '2026-06-01': { startHour: 9, off: false } }, auxBuckets);
  // Available = 160 + 220 = 380; expected on-queue = 540 - 60 - 20 = 460; lost = 80.
  check('C6 late 20', m6.lateMin === 20, 'got ' + m6.lateMin);
  check('C6 lost = 460 - available(380) = 80', Math.abs(m6.lostMin - 80) <= 1, 'got ' + m6.lostMin);

  Logger.log(results.join('\n'));
  return results;
}

function mkShift_(statuses) {
  return { statuses: statuses, start: statuses[0].start, lastEnd: statuses[statuses.length - 1].end };
}
function st_(name, s, e) {
  var start = new Date(s), end = new Date(e);
  return { status: name, category: '', channel: '', start: start, end: end, durMin: (end - start) / 60000 };
}
