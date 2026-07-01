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

## Metrics in the matrix toggle
Late (min) · Break over (min) · Offline over 20 (min) · Early leave / short shift (min) · Shrinkage %.
Cells show minutes and a `×N` violation count, color-scaled by severity; a blue dot marks an applied
exception. Click any cell for the full status timeline and which rules tripped. Export the current grid to CSV.
