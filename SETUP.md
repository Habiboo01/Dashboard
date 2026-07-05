# WFM Adherence Dashboard — Apps Script setup

A Google Apps Script web app that reads raw agent-status data from a Google Sheet,
scores every shift against the team's adherence rules, and renders an
**agents (rows) × dates (columns)** matrix with a switchable metric, drill-downs,
a repeat-offender leaderboard, a daily breakdown, and a typed-exceptions manager.

## Files
| File | Role |
|------|------|
| `Code.gs` | Server engine: reads the sheet tabs, builds shifts, scores rules, applies exceptions, returns data to the UI. |
| `WFM.html` | The dashboard UI (served by `doGet`). |
| `Tests.gs` | Run `runTests` in the editor to verify the scoring/exception logic. |
| `appsscript.json` | Web-app manifest (timezone, V8, access). |

## 1. Create the Google Sheet + tabs
Create one Google Sheet and add these tabs (exact names matter):

### `Raw_Status_Log` — paste your export here
Header row 1 must be exactly your `agent_status_timeline` export columns:
```
log_id | agent_added_id | agent_email | agent_name | activity_date | status_id |
status_name | status_category | channel | status_start | status_end |
duration_sec | duration_min | is_first_status_of_day | is_last_status_of_day | chats_during_status
```
Paste a fresh export in any time and hit **↻ Refresh** in the app — everything recomputes live.

### `Schedule` — your weekly roster grid (recommended, for exact lateness)
Same wide layout as your existing schedule sheet:
```
Name | Manager | Priority | AL Balance | <one column per date> ...
```
- Each day-column header carries the date, e.g. `Wed 1-Jul` or `1-Jul` (or a real date cell).
- Each cell is either a **shift-start time** (`9 AM`, `12 PM`, `3 PM`, `6 PM`, `9 PM`, `12 AM`, `3 AM`, `09:00`)
  or an **off-code**: `WO` (week off), `AL` (annual leave), `CL` (casual leave), or blank = off.
- `Name` must match `agent_name` in the `Agents` tab. Cell colors are ignored.
- You can stack several week-blocks in the tab; each column carries its own date, so any range works.
- If a day has no roster entry, the app falls back to inferring the start from the log.

### `Agents` — lookup + report toggle
```
agent_id | agent_name | agent_email | Include in Reports
```
Set **Include in Reports = FALSE** to drop a person (team lead, QA…) from every view.

### `Exceptions` — typed exceptions (managed from the app, or edit by hand)
```
agent_id | agent_name | date | rule | minutes | from_aux | to_aux | reason
```
| rule | effect |
|------|--------|
| `late` | Removes that day's lateness. *e.g. reason "transportation delay".* |
| `early_leave` | Credits `minutes` back so leaving early isn't penalized (blank = credit the whole shortfall). |
| `wrong_aux` | Moves `minutes` from `from_aux` to `to_aux` (e.g. `Upcoming Offline` → `Meeting`); removes it from offline/non-productive. |
| `break` | Excuses the break violation that day. |
| `offline` | Excuses the offline violation that day. |
| *(blank)* | Suppresses **all** flags for that agent/date. |

### `Aux_Config` — optional, to re-bucket statuses
```
status_name | bucket        (bucket = productive | shrinkage | nonproductive | neutral)
```
Defaults: Available = productive; Meeting/Jira/Calls/Email = shrinkage;
Break/Personal Time/Upcoming Offline/Unavailable = nonproductive; System Issue = neutral.

### `Config` — optional, to change the rule thresholds (or edit them in the **Rules** tab in the app)
```
setting | value
```
Recognised settings (blank tab = built-in defaults): `shift_hours` (9), `break_target_min` (60),
`break_tolerance_min` (5), `break_segment_max_min` (30), `break_min_segments` (2),
`break_max_segments` (3), `break_edge_window_min` (60), `offline_cap_min` (20), `late_grace_min` (5),
`shift_split_gap_min` (120), `login_match_window_min` (180), `shrinkage_mode` (`unplanned` | `gross`).
The **Rules** tab in the dashboard writes this tab for you; changes apply on the next refresh.

### External data sources (Schedule / Performance / Raw in another spreadsheet)
Add these to the `Config` tab to read a source from a **different** Google Sheet by link (or id) + gid.
You can paste the full sheet URL into the `*_sheet_id` cell — the gid is taken from it automatically.
```
setting                  value
schedule_sheet_id        <URL or spreadsheet id of the Schedule file>
schedule_gid             <the tab's gid>            (optional if the URL has #gid=)
performance_sheet_id     <URL or id of the Performance file>
performance_gid          <the tab's gid>
raw_sheet_id             <optional: read the timeline from another file too>
raw_gid                  <optional>
```
**Performance sheet** supplies each agent's first **login** and **logout** (used for lateness,
early-leave and overtime); the timeline is still used for breaks/aux. Columns are auto-detected by
header (login/logout/date/agent/email); if your headers are unusual, pin them with
`perf_col_login`, `perf_col_logout`, `perf_col_date`, `perf_col_agent`, `perf_col_email`.
When no source is configured, the app falls back to the bound tabs and infers login from the timeline.
The 5 canonical shift starts (fallback only) are 09:00, 12:00, 15:00, 18:00, 00:00.

## 2. Add the script
1. In the Sheet: **Extensions → Apps Script**.
2. Create files matching this repo: `Code.gs`, `WFM.html` (Apps Script calls it "WFM"), `Tests.gs`,
   and set the manifest (`appsscript.json`) — enable *Show "appsscript.json"* under Project Settings.
3. Save.

## 3. Verify
Run `runTests` from the editor (choose the function, **Run**) and check the execution log shows `ALL PASS`.

## 4. Deploy
**Deploy → New deployment → Web app.** Execute as *you*; access as your domain (or as needed).
Open the web-app URL. Adjust the timezone in `appsscript.json` if your team isn't on `Africa/Cairo`.

## Rules encoded (edit thresholds in `CONFIG` at the top of `Code.gs`)
- No break in the first or last 60 min · no single break > 30 min · total break 60 min ±5 in 2–3 segments.
- Upcoming Offline ≤ 20 min/shift (excess = non-productive).
- 9-hour shift; late grace 5 min (full late minutes are reported once past grace).
- **Shrinkage% = (off-queue auxes + unplanned non-productive) ÷ 9h**, excusing the allowed 60-min break
  and 20-min offline. Switch `CONFIG.SHRINKAGE_MODE` to `'gross'` to count everything non-Available.

## Overtime (worked on a rostered off day)
If the `Schedule` marks a day `WO`/`AL`/`CL` but the agent actually logged in and worked, that day is
counted as **overtime** (whole worked span) and is **not** scored for lateness/break/offline/short-shift —
they weren't rostered. Overtime shows as its own matrix metric, a teal dot on the cell, a tag in the
drill, and Overtime columns in the agent summary and MTD.

## Total lost / to compensate
The **Lost / compensate** metric is the on-queue shortfall for a day:

> **Lost = shift (9h) − break allowance (60m) − offline allowance (20m) − productive aux (Calls+Meeting+Jira+Email) − Available**

i.e. of the ~460 minutes the agent is expected to be on-queue, whatever they didn't cover with
**Available** time plus other productive auxes is "lost". Late arrival, early leave, extra break/offline,
personal time and unavailable all reduce covered time and therefore raise lost automatically — there's
no separate line for unavailable. Clamped at 0 (never negative) and **0 on overtime days**.
The cell drill shows the calculation; the **MTD** tab leads with **Total lost (to compensate)** per agent
(sorted worst-first) and exports to CSV — that's the number of minutes each agent should make up.

**Exceptions reduce lost.** Any exception credits its minutes back: `late` removes the late minutes,
`early_leave` credits the shortfall, `break`/`offline` credit the over-allowance minutes, and `wrong_aux`
reclassifies time into covered work — so lost drops accordingly. The drill shows the exception credit line.
Delete an exception anytime from the **Exceptions** tab (✕ Delete) and the numbers recompute.

## Metrics in the matrix toggle
**Violations (default)** · Late (min) · Break over (min) · Offline over 20 (min) · Early leave (min) · Overtime (min) · **Lost / compensate (min)** · Shrinkage %.
The **Violations** view is the calendar default and shows only rule breaches — late login + break-exceed
+ offline-exceed + early-leave minutes (with a ×count). It deliberately hides productive/non-productive
aux durations and shrinkage, so the grid shows *only* what an agent did wrong.
Cells show minutes and a `×N` violation count, color-scaled by severity; a blue dot marks an applied
exception. **Click a cell** for that day's full status timeline, break/shrinkage durations and which
rules tripped. **Click an agent's name** for their totals over the selected window (break duration,
shrinkage duration, productive time, late/offline/early-leave, plus a per-day list). Export the grid to CSV.

### The last (Σ) column
The right-most column per agent is their **total of the selected metric** for the shown period
(e.g. total late minutes), with `×N` = number of days flagged. For **Shrinkage %** it's the **average**
instead of a total. The header shows the active metric and hovering any total explains it.

## MTD tab (month-to-date totals)
A per-agent table for a chosen month: **break duration**, **shrinkage duration**, average shrinkage %,
offline-over minutes, late count/minutes, break- and offline-exceed counts, and early-leave minutes.
Pick the month at the top; respects the agent filter; export to CSV. Use this for the end-of-month review.

## Native Google Sheets output (no web app needed)
The script also renders the dashboard as **tabs inside the spreadsheet**. On open you get a
**WFM Dashboard** menu → **Refresh all tabs**, which (re)builds:
- **WFM_Matrix** — agents (rows) × dates (cols), colour-scaled, for the metric in Config
  `sheet_metric` (default `lost`; also `late`/`break`/`offline`/`short`/`overtime`/`shrink`).
- **WFM_MTD** — per-agent month totals led by **Total lost (to compensate)**, worst-first, with a
  TEAM TOTAL row. Month = Config `mtd_month` (yyyy-MM) or the latest month in the data.
- **WFM_Detail** — one row per agent-day with every metric, ready for your own pivot tables.
Run `buildSheetReport` from the editor once to authorize; after that use the menu.

## Filtering the view
- **Agents dropdown** (top-right of the Matrix): tick/untick to show or hide specific agents everywhere
  (matrix, leaderboard, day breakdown, CSV). Your choice is remembered in the browser. Use **All / None**
  to bulk toggle, or the search box to find someone. (This is on top of the `Include in Reports` sheet
  toggle, which removes an agent from the data entirely.)
- **View switch** (Day / Week / Month / All) with the ‹ › arrows steps through periods, so you can look
  at a single day, one week, or a whole month. The leaderboard and CSV follow the selected window.
