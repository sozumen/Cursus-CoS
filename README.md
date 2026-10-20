# Cursus CoS

A drag-and-drop, customizable Kanban style personal task management app

Kanban, table and calendar task management with multiple boards, automatic column moves, reminders,
custom backgrounds and a ready-made seam for Exchange email. **One web codebase, three ways to run it:**

| Where | How | Storage | Reminders |
|---|---|---|---|
| Browser / installable web app (PWA) | host `www/`, or open `www/index.html` | browser storage | while a tab is open |
| **Windows .exe** | Electron shell in `electron/` | files in `%APPDATA%\Cursus CoS\data` | native toasts from the system tray |
| **Android** | Capacitor shell (`capacitor.config.json`) | Android Preferences | scheduled as OS notifications |

The UI never talks to a platform directly. Everything platform-specific is behind **`src/js/host.js`**
(storage, notifications, file saving, shared-file sync). Adding a platform means adding a branch there.

## Quick start

```bash
npm install
npm run build        # compiles Tailwind, copies fonts + Lucide into ./www (works offline)
npm test             # unit tests + headless UI test, including two devices syncing
```

Open `www/index.html` in a browser to try it. `npm run build:single` also writes
`dist/cursus-cos.html`, one self-contained file.

## Windows (.exe)

```bash
npm start            # build and launch in Electron (development)
npm run dist:win     # build installer + portable exe into ./release  (run this on Windows)
```

- `npm run dist:win:setup` builds only the Setup wizard (.exe); `npm run dist:win:msi` builds a Windows Installer package
  (.msi, installs for all users, for deployment tools or Group Policy). Run either on Windows. The MSI target is configured
  but has not been run on Windows from here, so expect to adjust it on first use.
- Closing the window keeps Cursus CoS in the system tray so reminders still fire. The tray menu has
  "Keep running in the tray when closed" and "Start with Windows".
- The installer is unsigned, so Windows SmartScreen will warn until you add a code-signing certificate
  (`win.certificateFile` in the `build` section of `package.json`).
- Data lives in plain JSON under `%APPDATA%\Cursus CoS\data` (shown in Settings, Data).

## Android

One-time setup (needs Node, Android Studio and a JDK):

```bash
npm install
npm run cap:add:android      # creates ./android
```

1. **Permissions.** In `android/app/src/main/AndroidManifest.xml`, inside `<manifest>`, add:
   ```xml
   <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
   <uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM"/>
   ```
   On Android 12+ the user may also need to allow "Alarms & reminders" for the app so reminders arrive on time.
2. **Notification icon.** Copy `build/android/ic_stat_icon.png` to `android/app/src/main/res/drawable/`.
3. **Launcher icon (optional).** `npm run assets` generates Android icons from `assets/icon-only.png`.

Then, each time you change the app:

```bash
npm run cap:sync     # rebuilds www/ and copies it into the Android project
npm run cap:open     # opens Android Studio; press Run, or Build > Generate Signed Bundle / APK
```

The Android hardware Back button closes dialogs first, then minimizes the app.

## Keeping Windows and Android in step (sync)

Each device keeps a full local copy and works offline. Sync (Settings, Sync) merges changes **task by task, newest
edit wins**, and deletions travel as tombstones, so a delete on one device is not undone by another.
Boards, projects and tasks sync, including per-board settings (members, fields, automations, views, colors).
Theme, background, your last-used view, personal tags, subscriptions and "me" stay on each device.

| Method | Works on | Notes |
|---|---|---|
| **OneDrive** (personal Microsoft account) | Windows, Android (browser: see below) | Recommended. Live change alerts plus a check every 20 seconds. |
| Shared file | Windows | Point every Windows PC at one file in a OneDrive / Dropbox / network folder. |
| Web address | Windows, Android, browser | Any URL that answers GET and PUT with a file (WebDAV, a NAS, your own server). |

### OneDrive: one-time setup

You register your own small app with Microsoft (free, about 5 minutes). Nothing is hosted by anyone else.

1. Go to **entra.microsoft.com** (or portal.azure.com) and sign in with your personal Microsoft account. If it offers to
   create a free directory, accept.
2. **App registrations** → **New registration**. Name: `Cursus CoS`. Supported account types: **Personal Microsoft
   accounts only**. Leave Redirect URI empty. Click Register.
3. **Authentication** → under advanced settings set **Allow public client flows** to **Yes** → Save.
4. **API permissions** → Add a permission → Microsoft Graph → **Delegated** → **Files.ReadWrite**. (User.Read is already
   listed.) Personal accounts need no admin approval.
5. **Overview**: copy the **Application (client) ID**.

Then on each device: Settings → Sync → method **OneDrive** → paste the client ID → **Sign in with Microsoft**. The app
shows a short code; enter it at microsoft.com/link and approve. The data is stored at
`OneDrive / Apps / Cursus CoS / cursus-cos.json`. The client ID is not secret; use the same one on every device.

How fast: your edit is uploaded about 2.5 seconds after you stop typing. While the app is open, Microsoft pushes a change
alert (a websocket address from Graph's `/subscriptions/socketIo`) so other devices pull within a few seconds, and the
app also checks every 20 seconds as a safety net (it only downloads the file when OneDrive's eTag changed). Returning
to the app triggers an immediate check. A closed or locked Android app cannot receive alerts; it catches up when opened.

Notes: the sign-in uses the OAuth device-code flow. The Windows app makes these requests from its main process, and the
Android app uses Capacitor's native HTTP (`CapacitorHttp` is enabled in `capacitor.config.json`), so browser cross-origin
rules do not apply. A plain web browser may be blocked by Microsoft's servers, so use the apps. The refresh token is kept
in the app's private storage on each device (not in the synced data). The permission requested is **Files.ReadWrite**
(Microsoft's narrower app-folder permission is not used because the live-alert endpoint documents full Files scopes).
Sign out in the same Settings screen. Clocks matter: "newest edit wins", so keep device clocks automatic.

Tested here against a simulated Microsoft sign-in, Graph and alert service (see `test/onedrive.test.js` and the UI test),
**not** against the real Microsoft services; expect to adjust on first real use.

## Email from Exchange (not connected yet)

`src/js/ingest.js` already maps a Microsoft Graph message to a task (importance to an importance number, follow-up flag date to due
date, categories to tags, de-duplicated by message id). What's missing is the part that fetches mail. Two routes:

- **Windows app:** poll Microsoft Graph from `electron/main.js` (MSAL sign-in, `Mail.Read`), then send messages to the
  page with `webContents.send` and call `CoS.api.ingestEmails(messages, 'exchange')`.
- **Any platform:** a small relay service that polls Graph and exposes the messages to the apps.

Test the mapping today in Settings, Email, "Try it with a sample message".

## Archive

Archived tasks leave boards, the calendar, reminders and automation, and are listed under **Archive** in the sidebar, where
they can be restored. Archive a task from its editor, or archive everything in the Done column with the archive button in
that column's header (with Undo). Settings, Automation has "Archive finished tasks after N days" (0 is off). The Done
column shows the newest 25 cards with a "Show more" button, and the table shows 200 rows at a time.

## Importing from Zenkit

Settings, Data, **Import from Zenkit**. In Zenkit, open the list's settings and choose Export as JSON, then choose that file.
A preview shows the result before anything changes.

- **Stages to columns** is an editable table. First guesses: To-Do to Near-Term, Major Project and On Hold to Long-Term,
  Await Reply to Review, Idea for discussion to Consider, and a stage named like a column goes to that column. Your choices
  are remembered for the next import. A stage that has no column of its own is also kept as a tag (can be turned off).
- Priorities are mapped the same way. Tags, due and start dates, workload, assignees (as `@name` tags), checklists
  (become subitems), subtasks (become linked tasks), dependencies, and attachment names (listed in the notes) come across.
- Done tasks that finished more than N days ago (default 30) go straight to the Archive. Zenkit entries archived or deleted
  there only come in if you ask, and arrive archived.
- Importing the same file again skips tasks already imported, so it is safe to repeat.
- Not imported: comments, attachment files, and recurrence rules (recurring tasks get a `recurring` tag only).
- Parsing and mapping are in `src/js/zenkit.js`, with no DOM, so it is covered by `test/zenkit.test.js`.

## Stages (columns) per board

Board settings (the pencil by a board's name) → **Stages**. Add, rename, recolor, reorder and delete stages (up to 20 per
board). A new board starts with the standard eight: Consider, Scheduled, Long-Term, Near-Term, Up Next, In Progress,
Review, Done.

- **Completed stage:** exactly one stage per board is the completed stage (Done by default). The circle on a card moves a
  task there, tasks in it count as done (done dates, "hide done", overdue, blocked, the archive-done button and the
  automatic archive all follow it), and you can change which stage it is at any time.
- **Deleting a stage** asks where its tasks should go. Rules, colored-task rules and the new-task default that pointed at
  the deleted stage are re-pointed to that stage. The completed stage cannot be deleted until another is chosen.
- **Several boards at once:** stages with the same name (ignoring capitals and punctuation) share a column. Dropping a card
  into a column that its board does not have is refused with a message. Moving a task to another board keeps the same
  stage, else the same name, else maps completed to completed, else the first open stage.
- **Automation** (Settings, Automation) still moves tasks between the standard stages by their ids (Consider, Scheduled,
  Long-Term, Near-Term, Up Next). Renaming those stages is fine; a board with no stage to move into is left alone.
- **Sync:** stages are part of the board, so they sync. **Update every device before you customise stages**: an older
  version does not understand custom stages and can show tasks wrongly.
- **Other places:** CSV import matches stage names (unknown names go to the first open stage), CSV/print/calendar/email
  use your stage names, and the Zenkit import still uses the standard stages (it maps into an existing board by name).

Dragging a card to the left or right edge of the board scrolls it that way (faster nearer the edge), so you can reach columns
off screen.

## Importance (1 to 10)

Every task has an importance from 1 (least) to 10 (most), set in the task editor, in the table, or by dragging a card into
a column when the view is grouped by Importance. It replaces Low / Medium / High, which now mean 1-3, 4-7 and 8-10.

- Existing tasks become Low = 3, Medium = 5, High = 8. Filters, rules and colour rules that named Low / Medium / High keep
  working (they match the same bands), and new ones can use a band, a number or "N or more".
- **Settings, Automation:** the "important and urgent" rule now has "counts as important at importance N or more" (8 by
  default, which is what High used to mean).
- CSV: the column is "Importance". A number from 1 to 10 is used as is; High / Low / Urgent / P1 words still work on import.
- For other devices still on an older version, the stored `priority` field is kept in step (low, medium or high).

## Editing a task

- **Saves when you close it** (X, Esc, or a click outside the window). Only **Cancel** throws the changes away. Closing a new
  task without a title creates nothing, and a task you did not change is not touched.
- **Reminder and Repeat** sit right under the dates. Boards saved before this keep their own arrangement except that
  Reminder and Repeat move up under the dates once; you can reorder them in board settings, Fields.
- **Dependencies both ways:** "Waits on" (this task cannot finish before those) and "Blocking" (those wait for this task).
  Both are editable; loops are refused. Changes to a task's blocking list are written to the other tasks when you save.
- **Stick with parent:** once a subtask is made into a task, a "Stick with parent" box appears. A stuck task moves to the
  parent's stage and board whenever the parent moves (including Done and back). Moving a stuck task by itself takes it off the
  parent (it says so); automation leaves stuck tasks to their parent.

## Repeating tasks

Set **Repeat** in the task editor: every N days, weekdays, weeks, months or years, counted from the due/start date (a fixed
schedule; dates already past are skipped) or from the day you finish it. When the task is **completed or deleted** a new copy
is made with the next dates (start and due keep the same gap), same board, tags, people, importance, reminder and a fresh
subtask list. It goes to the stage you choose, else Scheduled if it has a start date, else the first open stage.

- Only that one item is affected. The finished one stops repeating, so reopening and completing it again does not make a
  second copy; the new copy repeats, so the series goes on. Both completing and deleting show an Undo that removes the copy.
- Month steps stay on the calendar (Jan 31 plus one month is Feb 28 or 29).
- Copies are made on the device where you complete or delete, never by syncing.

## Moving cards by date

Settings, Automation has the built-in flow (tasks you place in Scheduled move to Near-Term and Up Next as the start date
approaches; important tasks move up as the due date approaches). For your own rules, use board settings, Automations:

- **When a task's scheduled start date** / **due date** ... **N days before, on the day, or N days after**, then move it,
  set importance, flag, tag, assign or archive it. Add **Only if in stage X** so tasks you have already moved on are left alone.
- A rule runs once for each date a task has (a new date fires it again), on load, every 30 seconds and after edits, only for
  tasks that are not done. The record of what fired is on the task, so it syncs and a second device does not repeat it.

## Paste lines as tasks

The **Paste tasks** button (next to New task) turns pasted lines into tasks, for example a list copied from OneNote, an email
or a document. One task per line. Leading bullets, numbers and check boxes are dropped (a ticked box makes the task Done),
`#words` become tags, and indented lines become subtasks of the line above (switch that off to make every line a task). Pick
the board, stage and project, check the preview, then Add. Undo removes what was added. "Paste from clipboard" reads the
clipboard where the browser allows it; otherwise paste into the box with Ctrl/Cmd+V.

## Follow-up when a task moves to In Progress

When you move a task into the In Progress stage (by dragging, the table, the task editor or the context menu), a box asks
**When do you want to follow up?** with a name (default "Follow up: <task>"), quick dates, a date and an optional time.
Create follow-up makes a new task on the same board (stage Scheduled, start and due on that date, same importance, tags,
people and project, with a link back to the original) and a reminder at the time you gave, or that morning if you gave none.
Skip creates nothing; Undo removes the new task. Moves made by automation, by rules, from the Done circle or by a parent
task moving its stuck subtasks do not ask. Turn the prompt off in Settings, Automation.

## Cards, views and board settings

- **Cards:** the circle completes a task (Done column; click again to reopen). Right-click a card, or use its "..." button
  (or F2 to rename), for: Mark complete, Rename, Change Position (top, bottom, or another column/group), Share link, Edit
  personal tags, Duplicate, Move Task / Copy Task to another board, Subscribe, Archive, and Delete (both undoable).
  *Personal tags* and *Subscribe* are kept on this device only. Subscribed tasks toast when a sync changes them.
- **Views:** each board has tabs (Kanban, List, Table, Calendar; add more with "+"). The "..." button opens that view's
  settings: name, horizontal and vertical grouping (stage, importance, project, assignee, due date, board or any custom
  label field; vertical grouping makes swimlanes), aggregation, sort order and a Task Details slider. Dropping a card
  into another group rewrites that value. Choose a default view per board.
- **Task panel:** assignees, attachments (links and file paths only; files are not stored), subtasks, dependencies,
  custom fields, and Comments / Activities tabs.
- **Board settings** (board name's pencil in the sidebar): Settings (default view, new-task defaults, folder, Import CSV,
  Export CSV / JSON, Print as table / list, Email this list), Access (a members list; this app is local-first, so it
  does not enforce permissions), Automations (when X moves/importance/overdue/created/start date/due date, then move, set importance, tag,
  assign, set due, flag, archive), Archive, Activities, Fields (reorder, hide, add custom text/number/date/label/checkbox
  fields), and add-ons: iCalendar export (.ics file, not a live subscription), Colored Tasks rules, Email to Project.

## Layout

```
src/index.html          app shell (strict CSP, local scripts only)
src/js/core.js          pure logic: automation rules, reminder times, data model, sync merge (no DOM)
src/js/host.js          platform adapters: web / Electron / Capacitor
src/js/sync.js          sync transports: shared file, WebDAV/HTTP, OneDrive
src/js/onedrive.js      OneDrive: device-code sign-in, Graph file sync, live change alerts (injected deps, unit tested)
src/js/ingest.js        email adapters (Exchange mapping)
src/js/zenkit.js        Zenkit JSON export importer (pure, editable stage mapping)
src/js/tools.js         pure helpers: grouping/sorting, rules engine, CSV, ICS, print
src/js/app.js           UI: board, table, calendar, editors, drag and drop
src/styles/app.css      design tokens + components;  tailwind.input.css -> compiled Tailwind
electron/               Windows shell: main.js (tray, reminders, files) + preload.js (the API the page gets)
capacitor.config.json   Android shell config
scripts/build.mjs       builds ./www (and optionally the single file)
test/                   core and importer unit tests + headless UI/sync/import test
```

## What has and hasn't been verified

Verified by the tests here: automation rules, reminder timing, data repair, change stamping, merge convergence
(order-independent, idempotent, deletes), the full UI flow, settings closing on an outside click, and two simulated devices
syncing through a fake WebDAV-style server, plus the archive flow and a Zenkit import (preview, mapping edits, remembered
choices, undo, no duplicates).

**Not run in the environment this was written in:** launching the Electron app, building the `.exe`, building or running
the Android app, real notifications on either platform, and a real WebDAV server. Expect to spend a little time on the first
`npm run dist:win` and the first Android Studio build; the code paths are written to the plugins' documented APIs.

## If the Windows app crashes or shows a blank window
- Start it with `"Cursus CoS.exe" --disable-gpu` (or tick **Safe graphics mode** in the tray menu and restart).
- Errors (including ones inside the page) are written to `%APPDATA%\Cursus CoS\crash.log`. Send that file if the problem continues.
- Restoring a backup now repairs damaged or old data, and if a restore fails it leaves your current data unchanged.
- To see live messages, run the exe from a Command Prompt.

## Host the web app on GitHub Pages, with OneDrive sync
A hosted copy gives you the app on every device (phone, tablet, other PCs) at one address, and it can sync through OneDrive.

1. **Create the repository.** On github.com: New repository, name it `cursus-cos`, set it to **Public** (Pages on a private repository needs a paid plan). Your tasks are never in the repository, only the app's code.
2. **Upload the project** (in this folder, with Git installed):
   ```
   git init
   git add .
   git commit -m "Cursus CoS"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/cursus-cos.git
   git push -u origin main
   ```
3. **Turn on Pages.** In the repository: Settings → Pages → Build and deployment → Source: **GitHub Actions**. The workflow in `.github/workflows/pages.yml` then builds and publishes the site (about 2 minutes, watch it on the Actions tab). The site is at `https://YOUR-NAME.github.io/cursus-cos/`. Every later `git push` republishes it.
4. **Register the address with Microsoft.** Open the site, Settings → Sync → OneDrive. It shows the exact address to copy. In entra.microsoft.com → App registrations → your Cursus CoS app → Authentication → Add a platform → **Single-page application** → paste the address → Save. (Under *Single-page application*, not *Web*. The Windows app's existing setup can stay as it is; one registration serves both.)
5. **Sign in** on the site with the Application (client) ID. Repeat on each device.
   - On a device that already has its own data, the first sync merges it with what is in OneDrive.
   - A brand-new browser starts with sample data, and sync waits until you clear it (Settings → Data → Erase everything). Then it pulls your real data from OneDrive.
   - On an iPhone or iPad, use Share → Add to Home Screen. Safari forgets sites it has not seen for a week; an installed app is kept.

Microsoft limits web sign-ins to about a day. The page renews it quietly (it briefly reloads); you are only asked again if Microsoft wants a password.
