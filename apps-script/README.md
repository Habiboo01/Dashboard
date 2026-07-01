# Telda Support Search — Google Apps Script bot

A search bot over the **Telda Support Knowledge Base** (the Notion KB migrated from the "Updates"
Word doc). An agent describes a customer's case (English or Egyptian Arabic) and instantly gets the
matching procedure — steps, SLA, Jira/Slack links, contact tree.

**Runs 100% on Google Apps Script + Notion. No external AI, no server, nothing to install.**
The only credential is a Notion token, used solely to keep the KB in sync.

> No AI means it *finds and shows* the right procedure by keyword search — it does **not** understand
> free-form language like an LLM and does **not** draft customer replies.

---

## Files

| File | Purpose |
|------|---------|
| `Code.gs` | Routing (`doGet`), the `search()` API, admin gating, logging, keyword overrides |
| `Search.gs` | Deterministic ranking/scoring (title > keywords > category > content; EN + AR) |
| `Sync.gs` | Pulls KB content from Notion into a Drive JSON snapshot; daily trigger |
| `Kb.gs` | Built-in KB seed (96 topics) — fallback before/without a Notion sync |
| `Agent.html` | Agent search page (default view) |
| `Admin.html` | Admin panel — sync + keyword editor + logs (`?view=admin`) |
| `appsscript.json` | Manifest (OAuth scopes + web-app config) |

---

## One-time setup

### 1. Create the Apps Script project
- Go to https://script.google.com → **New project**.
- Create each file above with the **exact same name** (in the editor: **+ → Script** for `.gs`,
  **+ → HTML** for `Agent`/`Admin`). Paste in the contents. Replace the default `appsscript.json`
  via **Project Settings → “Show appsscript.json manifest file in editor”**.
- *(Optional, faster:)* use [`clasp`](https://github.com/google/clasp): `clasp create --type webapp`
  then `clasp push` from this folder.

### 2. Set Script Properties
**Project Settings → Script properties → Add script property:**

| Property | Value |
|----------|-------|
| `ADMIN_EMAILS` | Your admin Google email(s), comma-separated |
| `NOTION_TOKEN` | Notion internal integration token (see step 3) |
| `NOTION_PARENT_ID` | `38e5d4fc-3408-812a-9c68-ddf28a0b67c6` (the KB parent page) |

`KB_FILE_ID`, `DATA_SHEET_ID`, and `LAST_SYNC` are created automatically — don't set them.

### 3. Create the Notion integration (for sync)
- https://www.notion.so/my-integrations → **New integration** (internal) → copy the token into
  `NOTION_TOKEN`.
- In Notion, open **Telda Support Knowledge Base** → **•••** → **Connections** → add your
  integration. (Sharing the parent page shares all sub-pages.)

### 4. Deploy
- **Deploy → New deployment → Web app.**
- **Execute as:** Me. **Who has access:** *Anyone within <your Workspace>* (or *Anyone with the
  link* if you're not on Workspace).
- Authorize the scopes when prompted. Copy the **/exec** URL.

### 5. First sync + auto-sync
- Open `<url>?view=admin` → **Sync from Notion now** (should report 96 topics), then
  **Enable daily auto-sync**.

---

## Using it
- **Agents:** share the plain **/exec** URL.
- **Admins:** open **`/exec?view=admin`** to sync, tune keywords, and review the log (the Data sheet
  records every search and flags queries that returned **no results** — your KB gaps).

## Notes
- Before the first Notion sync, the bot serves the built-in `Kb.gs` seed, so it works immediately.
- The seed's "Open in Notion" links point at the KB parent page; after a sync they point at each
  exact topic page.
- Want AI later (case understanding / drafted Egyptian-Arabic replies)? It's a bolt-on API call in
  `Code.gs`; the search app doesn't need to change.
