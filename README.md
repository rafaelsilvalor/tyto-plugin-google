# tyto-plugin-google

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin that reads and writes Google Sheets and
Google Drive from a recipe. Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything
Google-specific lives here, in its own repository, and reaches Tyto only through the plugin API.
This repository is public and unlicensed.

Twelve recipe verbs, all in the `google` namespace:

| Verb                  | Kind      | What it does                                                       |
| --------------------- | --------- | ------------------------------------------------------------------ |
| `google.sheet-rows`   | source    | One tab of a spreadsheet as a table.                               |
| `google.sheet-write`  | sink      | Writes the table into a tab, replacing it or under its last row.   |
| `google.sheet-sync`   | sink      | Makes a tab hold the table's rows, matched by a key column.        |
| `google.drive-list`   | source    | A Drive folder's children, one row per file or folder.             |
| `google.drive-read`   | source    | What a JSON or text file in Drive holds, as rows.                  |
| `google.drive-move`   | action    | Moves each row's file or folder into a folder under the root.      |
| `google.drive-folder` | action    | Creates a folder per row as you, and shares it with listed people. |
| `google.sheet-create` | action    | Creates a spreadsheet per row as you, and shares it likewise.      |
| `google.drive-upload` | action    | Sends each row's workspace file or folder into a Drive folder.     |
| `google.drive-count`  | transform | Adds the number of PNG and JPEG files in each row's folder.        |
| `google.sheet-lookup` | transform | Adds a tab's columns to each row, found by a key column.           |
| `google.drive-url`    | transform | Adds the address of the Drive folder an upload sent each row to.   |

A sink or an action plans: it shows what it would write, and nothing is written until you
apply the plan.

## Install

Straight from this repository:

```
tyto plugin install git+https://github.com/rafaelsilvalor/tyto-plugin-google.git
```

Tyto copies the folder and never builds it, so `dist/index.js` is committed. The install shows
the permissions below and asks for your approval.

### What it may reach

| Permission                  | Why                                                   |
| --------------------------- | ----------------------------------------------------- |
| `net:sheets.googleapis.com` | The Sheets API: reading and writing a spreadsheet.    |
| `net:www.googleapis.com`    | The Drive API: listing, reading, moving and creating. |
| `signin:google`             | Your own Google sign-in, run by Tyto in your browser. |
| `workspace:read`            | The open folder's files, for `google.drive-upload`.   |

**The plugin acts only as you, the person signed in**, with your own Google sign-in, on every
verb: in the desktop app, and in a terminal (`tyto recipe run`, `tyto mcp`) after
`tyto signin google`. It never acts as a robot: there is no service account, no key to store and
no fallback of any kind (TYTO-701). See [Signing in as yourself](#signing-in-as-yourself).

**A machine with no system keychain cannot run the plugin's verbs.** A terminal there (a headless
machine, CI) has nowhere to keep a sign-in, so it cannot sign in, and every verb fails with
`E_GOOGLE_SIGNIN`, saying the terminal cannot sign in and that Tyto's Google verbs act only as a
signed-in person. Run the step in the desktop app, or in a terminal on a machine with a keychain
after `tyto signin google`.

## Signing in as yourself

In the desktop app, and in a terminal after `tyto signin google`, every verb acts as you: the
verbs that read, write and move see what your own
account sees, so a spreadsheet or a folder needs no sharing with anyone else, and a file you
cannot open answers as missing, with an error that says it is not shared with the account signed
in on the plugins screen. `google.drive-folder` and `google.sheet-create` create what is yours,
in your Drive or a shared drive you can write to, shared only with the people a row lists. Every
verb needs Tyto's desktop app 0.24.1 or later (plugin API 0.24), which runs the sign-in and
reads workspace files in parts; the plugin installs on no older Tyto. Tyto runs that sign-in, not the plugin: the
browser opens only when you click **Sign in** on the plugins screen, and the plugin receives a
short-lived access token and never the refresh token, which Tyto keeps in the system keychain
(Tyto ADR 0174).

The manifest declares Google's endpoints and the scopes it asks for, `openid`, `email` and
`https://www.googleapis.com/auth/drive`, but **no OAuth client**: this repository is public, and
a client belongs to whoever registered it. You supply one on the plugins screen (Tyto ADR 0192):

1. In Google Cloud, in a project of your own or your organisation's, open **APIs & Services**,
   enable the Google Drive API and the Google Sheets API, and set up the OAuth consent screen.
2. Under **Credentials**, choose **Create credentials**, **OAuth client ID**, application type
   **Desktop app**. Google shows a client ID and a client secret; a desktop client's secret is
   not confidential, but it is still the project's to hand out.
3. In Tyto's desktop app, on the plugins screen, find the `google` sign-in row, type the client
   ID and the client secret, and choose **Save**. Then choose **Sign in** and finish in the
   browser.
4. Set the section's `root` to the folder everything is created under, and run a step, such as
   one of these over a table with a `name` column and a `share` column:

   ```
   google.drive-folder share=share
   google.sheet-create parent=Clients share=share notify=no
   ```

   A `share` cell reads `ana@example.com:writer; bo@example.com:reader`: each person and the
   role they get, `reader`, `commenter` or `writer`. Nobody else is given access. Drive emails
   them its sharing notice only with `notify=yes`; `no` is the default. Read the plan, then
   apply it.

Saving another client, or clearing it, ends the sign-in made with the previous one. The fields
are write-only: Tyto keeps the client in the keychain and never shows it again.

In a terminal, `tyto signin google` signs you in the same way (Tyto ADR 0194): Tyto keeps the
sign-in in the system keychain, and `tyto recipe run` and `tyto mcp` then act as you.

When nobody is signed in, every verb fails with `E_GOOGLE_SIGNIN` and says to sign in on the
plugins screen or with `tyto signin google`. A terminal with no system keychain cannot sign in:
there every verb fails with `E_GOOGLE_SIGNIN` saying so, and makes no request. Your access token
is redacted from every message.

## The `google` section of `.tyto/project.json`

```json
{
  "google": {
    "spreadsheet": "https://docs.google.com/spreadsheets/d/<id>/edit",
    "root": "https://drive.google.com/drive/folders/<id>",
    "tabs": {
      "Queue": {
        "table": "QueueTable",
        "header": "#D9EAD3",
        "dropdowns": { "Status": ["To do", "Doing", "Done"] }
      },
      "Shipped": { "table": true }
    }
  }
}
```

- `spreadsheet`: the spreadsheet the Sheets verbs read and write unless a step names another,
  as its id or its address.
- `root`: the Drive folder the Drive verbs stay under, as its id or its address.
- `tabs`: how a tab looks, by the tab's name (case is ignored), for `google.sheet-sync`:
  - `table`: a native table (Format › Convert to table) over the header and every row, by this
    name, or `true` for `Table_<tab>`. A name holds letters, digits and `_` only, and is unique
    in the spreadsheet.
  - `header`: row 1's background colour, as `#RRGGBB`.
  - `dropdowns`: per column, the values its dropdown offers.

## `google.sheet-rows`

A source: one tab of a spreadsheet as a table, one row per sheet row under the header.

```
google.sheet-rows tab=Tasks key=ID links=Brief notes=Owner
```

| Argument       | What it does                                                                       |
| -------------- | ---------------------------------------------------------------------------------- |
| `spreadsheet=` | The spreadsheet, as its id or its address; the section's `spreadsheet` by default. |
| `tab=`         | The tab, by its name (case is ignored when only one tab matches); the first tab.   |
| `key=`         | The column whose value keys each row; without it a row's key is `row-<n>`.         |
| `links=`       | Columns, comma-separated, whose cell links become a `<column>_url` link column.    |
| `notes=`       | Columns, comma-separated, whose cell notes become a `<column>_note` text column.   |
| `max=`         | The most rows the tab may have, 100,000 by default; more is an error, never a cut. |

- **Columns** are row 1's names, in order. A column that holds values under a blank name, or
  two names that differ only in case, is refused rather than renamed: a recipe reads a column
  by its name. A column is a number, or a boolean, only when every filled cell in it is one;
  otherwise it is text, and a number in it is written as its digits. Dates come as the text the
  sheet shows.
- **Rows** whose cells, links and notes are all empty are skipped. A `key=` value that is blank
  or repeated is refused, naming both rows. Each row's provenance is
  `<spreadsheetId>/<sheetId>/<row number>`, which the write verbs find the row by.
- **Links** are read wherever Sheets keeps them: the cell's `hyperlink` (which covers
  `=HYPERLINK`), a linked run of text, or the cell's format, where Sheets moves a link that
  covers the whole cell. Links and notes are asked for only when `links=` or `notes=` names a
  column, and only the fields asked for.
- **The tab is read once.** The first page reads it and keeps it in the plugin's cache with the
  file's Drive `version`; the following pages, up to 5,000 rows each, are cut from that one
  copy, so a sheet edited during a run is never two tables stitched together (a later page that
  finds another copy fails and asks you to run again). The next run uses the cached copy only
  while Drive still gives the same `version`, and running again without cache reads Google.
  When Drive does not give a version, the tab is read live and nothing is cached. Only copies
  read as you are kept; one an earlier version kept for a service account is never served.

## `google.sheet-write`

A sink: writes the table into one tab of a spreadsheet, as a plan you read and then apply.
Nothing is written until you apply it.

```
google.sheet-write tab=Report mode=replace formulas=Total
```

| Argument       | What it does                                                                       |
| -------------- | ---------------------------------------------------------------------------------- |
| `spreadsheet=` | The spreadsheet, as its id or its address; the section's `spreadsheet` by default. |
| `tab=`         | The tab, by its name, as `google.sheet-rows` finds it; the first tab by default.   |
| `mode=`        | `replace` or `append`; required, because `replace` clears the tab.                 |
| `formulas=`    | Columns, comma-separated, whose cells starting with `=` are written as formulas.   |

- **`mode=replace`** plans a `clear` of the tab's values and links, then a `write-row` for the
  header (the table's column names, in row 1) and one for each row under it. Colours, borders
  and number formats stay as the sheet has them.
- **`mode=append`** plans a `write-row` for each row under the last row that holds anything,
  each cell under the header of its column's name (case is ignored). A column the header does
  not name is refused before anything is planned. An empty tab gets the header first.
- **Text is never a formula.** A cell that starts with `=` is written as text unless its column
  is in `formulas=`, so a recipe cannot be made to write a formula it read from a web page or a
  ticket. Numbers and booleans keep their type; a list is written as its items joined by `, `.
- **Formulas are written the English way and land in the sheet's.** Write `=SUM(A2,B2)`: in a
  spreadsheet whose locale separates arguments with `;` (`pt`, `es`, `fr`, `it`, `de`, `nl`,
  `pl`, `ru`, `tr`), the plan writes `=SUM(A2;B2)`, because Sheets reads a formula in its
  locale. Only a `,` outside text, a quoted tab name and `{…}` changes; decimals such as `1.5`
  are left as written.
- **Links** are written as a linked run of text, the link Ctrl+K makes, never as
  `=HYPERLINK`. A `<name>_url` link column beside a `<name>` column links that column's text
  and is not written as a column of its own, which is how `google.sheet-rows links=` reads it
  back; any other link column is written as its address, linked. A link that is not `http`,
  `https` or `mailto` is a planned failure.
- **A row that cannot be written** (a refused link, a cell over the 50,000 characters a Sheets
  cell holds) is shown in the plan as one that will fail, and fails on Apply with no request.

### Applying a plan

Tyto applies a plan 100 operations at a time. Each batch is **one `spreadsheets.batchUpdate`**:
the clear first when the batch holds it, then the rows and columns the grid lacks, then the
rows. Google writes a batch whole or not at all, so its operations share one outcome:

- A refusal (a 400, a 403, a 429 past the retries) wrote **none** of the batch.
- A 5xx or a lost answer **may** have written it, and is not retried, because a second try
  could write the rows twice: read the tab before you apply again.
- A row lands only where the tab is still empty, unless its batch clears the tab first; a row
  filled since the plan fails alone with `E_GOOGLE_CHANGED`. A replace plan's later batches
  write only after its clear was applied, so a refused clear never leaves new rows among old
  ones.
- One batch spends at most 20 s; what it did not reach is `skipped`, never half-written.

A plan keeps at most 2,048 bytes per row. A row whose cells take more is kept in the plugin's
cache until it is applied, under `plan/<digest>/<row>`, and the plan holds only its name and
digest; if the cache no longer holds it, or holds something else, the row fails with
`E_GOOGLE_PLAN` and asks you to run the cell again. Kept rows of plans over 7 days old are
forgotten when a new plan is made.

## `google.sheet-sync`

A sink: makes one tab hold the table's rows, matched by a key column, as a plan you read and
then apply. Rows the table no longer holds leave the tab, and rows marked done move to another
tab.

```
google.sheet-sync tab=Queue key=ID move=Filed keep=Notes archived=Archive
```

| Argument       | What it does                                                                        |
| -------------- | ----------------------------------------------------------------------------------- |
| `spreadsheet=` | The spreadsheet, as its id or its address; the section's `spreadsheet` by default.  |
| `tab=`         | The tab the rows live in; required. Row 1 holds the column names.                   |
| `key=`         | The column, in the table and in the tab, that says which row is which; required.    |
| `move=`        | A column of the table naming the tab a row moves to; blank keeps the row here.      |
| `keep=`        | Columns, comma-separated, that people write by hand: never overwritten.             |
| `archived=`    | Tabs, comma-separated, whose keys were filed away: the sync does not add them back. |
| `notes=`       | Tab columns, comma-separated, whose cell notes the table's `<column>_note` writes.  |
| `note-mode=`   | `set` (the default) replaces each note; `append` adds the value as a line under it. |

| In the tab | In the table           | Planned                                                   |
| ---------- | ---------------------- | --------------------------------------------------------- |
| yes        | yes, `move=` blank     | `update` of the cells that differ; nothing when none does |
| yes        | yes, `move=` names tab | `move` to that tab, after an `add-tab` when it is missing |
| yes        | no, `keep=` blank      | `delete`                                                  |
| yes        | no, `keep=` holds text | nothing: kept, with a warning naming it                   |
| no         | yes, in `archived=`    | nothing: it was filed away, with a warning                |
| no         | yes, `move=` names tab | nothing: a row never in the tab is not invented           |
| no         | yes                    | `add` under the last row                                  |

- **An empty table over a tab with rows plans nothing**, and warns: an empty input looks the
  same as a read that failed before this step, and every row would be deleted.
- **A key twice in the tab or in the table is refused**, naming the rows; the sync never
  guesses which one is meant. A tab row with a blank key is left as it is, with a warning.
- Every table column must be a column of the tab, except `move=`'s; `keep=` columns are written
  only by `add`. Cells are written as `google.sheet-write` writes them: text is never a
  formula, and a `<name>_url` column links its column.
- A **moved** row travels by `copyPaste`, so its formulas, date formats, colours and links,
  web or not, go with it. The cells the table changes are written over the row first, and the
  plan names them. Each cell lands under the column of the same name in the new tab; a column
  the new tab lacks, where the row holds something, fails that move in the plan. A new tab gets
  this tab's header.

### Writing cell notes

```
google.sheet-sync tab=Queue key=ID notes=Owner note-mode=append
```

With `notes=Owner`, the table's `Owner_note` column writes the note of each row's `Owner`
cell: the name `google.sheet-rows notes=Owner` reads it back as. The note column is not a
column of the tab, and a `keep=` column's note is written too, because a note leaves the cell's
value alone. A note change rides the row's `update`, `move` or `add`, and the plan shows it:

```
update EX-1 (row 2): Owner note: "Ana took it" → "Ana, since Monday"
update EX-2 (row 3): Owner note: + "Bruno → Caio"
```

- **`note-mode=set`** writes the value as the whole note, and plans nothing when the note is
  that already.
- **`note-mode=append`** adds the value as a new line under the note, and plans nothing when
  the note's last line is the value already, so running the recipe again does not write the
  same line twice. Only the last line counts: a value that went back to an earlier one, such
  as an assignee changed back, is added again.
- **A blank value leaves the note as it is**, in both modes: a read that failed before this
  step must not erase a note a person wrote. So `set` cannot clear a note.
- The note is written with a field mask of `note` alone, so the cell's value, link and format
  stay. The row's digest covers the notes `notes=` names: a note a person changed between the
  plan and Apply fails the row with `E_GOOGLE_CHANGED`, so an append never lands on a note it
  did not read.
- A `notes=` column the table has no `<column>_note` for, or the tab has no column for, is
  refused before anything is planned.

### Formatting a tab

With `tabs.<tab>` in the section, the sync plans a `format-tab` for the synced tab, and for
each tab rows move to, **only when the tab does not look as the settings ask** once the plan's
rows are written:

- **A table is added** over row 1 to the last row, after the tab's alternating colours are
  removed (Sheets refuses a table over them). A tab that has a table only has its range
  stretched to the rows it ends with; a second table is never added.
- **A dropdown is rewritten only when its values change**, because rewriting it drops the
  colours a person gave its options. In a table it is the column's type; elsewhere, a rule on
  the column from row 2, which warns on other values rather than refusing them.
- **The header colour** is set when any cell of row 1 has another.
- Settings that name a column the tab lacks show the `format-tab` as one that will fail.

### Applying a sync

Each batch of 100 is **one `spreadsheets.batchUpdate`**: new tabs, cell updates (a moved row's
included), moved rows copied, rows removed from the bottom up, new rows appended, then each
tab's format over the rows it ends with. A move's copy and its removal land together or not at
all. Before it writes, the batch reads the tab once and finds each row by its key, not by the
number it had when planned: a row whose cells **or links** changed since the plan fails alone
with `E_GOOGLE_CHANGED` "the row changed since the plan", as does an `add` whose key reached
the tab, or a move whose new tab's header changed, and the others are written. A refused or
lost batch reads as for `google.sheet-write`, and so do the 20 s budget and the rows kept in
the cache.

## `google.drive-list`

A source: a folder's children, one row per file or folder, oldest first.

```
google.drive-list type=json
```

| Argument  | What it does                                                                           |
| --------- | -------------------------------------------------------------------------------------- |
| `folder=` | The folder, as its id or its address; the section's `root` by default.                 |
| `type=`   | `folder`, `file` (anything but a folder), `image`, or `json`; every child by default.  |
| `max=`    | The most items the folder may have, 100,000 by default; more is an error, never a cut. |

- **Columns**: `id`, `name`, `mime_type`, `kind` (`folder`, `image`, `json` or `file`), `size`
  (bytes; empty for a folder or a native Google file), `created` and `modified` (date and
  time), `url` (the item's page in Drive, a link), `parent_id` (the folder listed), and
  `width` and `height` (an image's pixels, as Drive reports them; empty for anything Drive
  does not read as an image, a `.psd` included). Each row's key and provenance is the item's
  Drive id.
- **Dimensions** come in the same listing, from Drive's `imageMediaMetadata`: no request per
  file. The two columns are last, so a recipe written before them reads what it read.
- **What is listed**: the folder's direct children, never its trash. A JSON file is one whose
  type is `application/json` or whose name ends in `.json`, as a routine's inbox writes them.
- **Shared drives** are read as well as My Drive: every request carries `supportsAllDrives`
  and `includeItemsFromAllDrives`, without which a folder in a shared drive reads as empty.
- **Paging**: each page is one Drive listing of up to 1,000 items; the cursor carries Drive's
  own page token.

## `google.drive-read`

A source: what a JSON or text file holds, as rows.

```
google.drive-read
google.drive-read file=https://drive.google.com/file/d/<id>/view
google.drive-read folder=https://drive.google.com/drive/folders/<inbox id> rows=itens
google.drive-read rows=itens columns=task_filha,status
```

| Argument   | What it does                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `file=`    | One file, as its id or its address.                                                             |
| `folder=`  | Every JSON file directly in the folder, oldest first; the section's `root` when neither is set. |
| `type=`    | `json` or `text`, how `file=` is read; by default its type or name decides. A folder is JSON.   |
| `rows=`    | A key of a JSON object: each element of the list under it is a row.                             |
| `columns=` | Columns that always exist, comma-separated, whatever the files hold.                            |

- **JSON**: an array gives one row per element, keyed `<file id>:<index>` from 0; an object
  gives one row, `<file id>:0`. An element's keys are its columns, after `file_id` and
  `file_name`; an element that is not an object goes into `value`. A column is a number, a
  boolean or a list only when every filled value in it is one, otherwise text; a nested object
  is kept as its JSON text.
- **`rows=<key>`** reads each file as an object holding a list under `<key>`: each element of
  the list is a row, keyed `<file id>:<index>` from 0, and the object's other keys that hold a
  single value (text, a number, a boolean, null) are copied onto every row, before the
  element's own keys; an element's key of the same name wins. The object's other lists and
  objects are not copied. A file that is not an object, has no such key, or holds something
  other than a list under it is refused.
- **`columns=<a,b>`** names columns that exist whatever the files hold: an empty folder, or
  one whose every file is skipped, answers zero rows with these columns, so a later step that
  names one of them plans nothing instead of failing. They come first, after `file_id` and
  `file_name`, in the order written; a file key of the same name fills that column and is typed
  by its values, and the files' other keys follow. A file key that differs from a declared name
  only in case skips the file, as between two files. `file_id`, `file_name`, two names that
  differ only in case, and `type=text` are refused.
- **Text**: one row per line, keyed `<file id>:<line>` from 1, with `file_id`, `file_name`,
  `line` and `text`.
- **A folder** judges each file alone. The first page reads every JSON file once: a file that
  is not JSON, that `rows=` refuses, that is over 8 MiB or a native Google file, or whose keys
  cannot join the others' (a key that differs from another file's only in case, or more than
  200 keys between the files) is named in a warning and skipped, and the run goes on. The
  columns are every kept file's keys, in the order they first appear; a file's missing key is
  an empty cell, and a column is typed by the values of every file. The first page answers the
  first kept file; each later page downloads one more. Every row carries its file's
  `file_id` and `file_name`, so a later step can move the file. A folder whose files change
  between two pages of one run is refused; run again.
- **Refused**: a native Google file (Docs, Sheets, Slides) named as `file=`, which has no
  content to download (read a spreadsheet with `google.sheet-rows`); a folder named as
  `file=`; a file over 8 MiB, by Drive's size before the download and by its bytes after; a
  folder of more than 1,000 JSON files.

## `google.drive-move`

An action: moves each row's Drive file or folder into one folder, or each into its row's own
folder, as a plan you read and then apply. Nothing moves until you apply it.

```
google.drive-list folder=https://drive.google.com/drive/folders/<inbox id> type=json
google.drive-move to=processed
google.drive-move to-column=destination file=file_id
```

| Argument     | What it does                                                                         |
| ------------ | ------------------------------------------------------------------------------------ |
| `to=`        | The folder every file moves into: its address, its name, or its id.                  |
| `to-column=` | The column holding each row's own destination, written as `to=` is.                  |
| `file=`      | The column holding each file's id or address; `id`, as `google.drive-list` names it. |

- **One of `to=` or `to-column=`** is required, and giving both is refused.
- **`to-column=`** reads each row's destination from that column, so one step sends accepted
  files to one folder and rejected ones to another. A row whose destination is empty is left
  out, and a warning counts those rows. A row whose destination is missing, outside the root,
  or a file is a planned failure of that row alone; the others still move. Each destination is
  looked up once per plan, however many rows name it.

- **The destination by name** is a folder of that name directly in the folder the row was
  listed from: the row's `parent_id`, as `google.drive-list` writes it, or the section's `root`
  when the table has no such column. Two folders of that name are refused; name one by its
  id. When no folder has the name and `to=` looks like a Drive id, it is read as one.
- **Everything stays under `root`.** The section's `root` is required, and the plan reads each
  file's folders upwards, at most six levels, to find it: a file outside it, deeper than six
  folders, or whose folders loop is shown as one that will fail, and is never moved. A
  `to=` destination outside it stops the plan. Folders the files share are read once per plan.
- **A missing `to=` destination stops the plan**: this version never creates a folder.
- A file already in the destination is left out, with a warning naming it. The root itself and
  the destination itself are planned failures.
- Each `move` keeps the folders the file was in when planned. Each plan is checked within one
  call's time; a table too large for it is refused, and asks for fewer rows.

### Applying a move

Each file's folders are read again first. A file that moved since the plan fails alone with
`E_GOOGLE_CHANGED` and stays where it is; the others move. A move is one Drive `files.update`
that adds the destination and removes exactly the folders the plan saw, in shared drives too.
One batch spends at most 20 s; what it did not reach is `skipped`, and applying again picks it
up.

## `google.drive-folder`

An action: creates one Drive folder per row, as the signed-in person, and shares it with the
people the row lists, as a plan you read and then apply. Nothing is created until you apply it.

```
google.drive-folder name=Client parent=Clients share=Access
```

| Argument  | What it does                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `name=`   | The column holding each folder's name; `name` by default.                                                                |
| `parent=` | The folder they go in: a folder directly in the root by its name, or its id or address. The section's `root` by default. |
| `share=`  | The column naming who gets access: `email:role; email:role`, each role `reader`, `commenter` or `writer`.                |
| `notify=` | `yes` emails each person Drive's sharing notice; `no`, the default, does not.                                            |

- **As you, and shared only with whom the row lists.** Every request of the plan and of its
  Apply is signed with your sign-in; nobody signed in is `E_GOOGLE_SIGNIN`. A recipe that reads
  the new folder reads it as you too.
- **The parent stays under `root`**, which is required: a parent outside it, missing, or
  ambiguous stops the plan. This version creates no parent.
- **A second run creates nothing twice.** The plan asks Drive for a folder of the row's name
  directly in the parent, not in the trash; one found is not created again, with a warning
  naming it. Several found stop the plan. Two rows of one name fail the second.
- **A second run shares what is missing.** For a folder already there, the plan reads who it
  is shared with (Drive's `permissions.list`) and plans only the people of the row who do not
  hold that role or a stronger one (`reader` < `commenter` < `writer` < organizer < owner), so a
  share that failed on an earlier run is tried again. A person who holds a stronger role keeps
  it: **no permission is ever removed or lowered**. Access a person has only through a group is
  not seen, so they are shared with directly. A folder whose sharing you cannot read stops the
  plan.
- **The link is known before the folder exists.** The plan asks Drive for new ids
  (`files.generateIds`), so each `create` shows the folder's address and each `share` names it.
- A row with a blank name, a name over 500 characters, or a `share=` cell that is not
  `email:role` with one of the three roles fails in the plan, shares included: a folder half
  shared is worse than none. A blank `share=` cell shares with nobody.

### Applying a creation

Each `create` first asks for the name in the parent again: the folder the plan's id made (an
Apply run twice) counts as `applied`, and another folder of the name, made since the plan, fails
with `E_GOOGLE_CHANGED`. A create Drive refuses, or whose answer is lost, is checked by reading
its id: if the folder is there, it was made. A `share` whose `create` failed in the same batch
fails with that reason and sends nothing. Before a `share`, the folder's sharing is read again:
a person who holds that role or a stronger one by now is `applied` with nothing sent. A share
Drive refuses, such as an address outside a domain that forbids it, fails alone, and the next
run plans it again. One batch spends at most 20 s; what it did not reach is
`skipped`, and applying again picks it up.

## `google.sheet-create`

An action: creates one empty spreadsheet per row, as the signed-in person, and shares it with
the people the row lists, as a plan you read and then apply.

```
google.sheet-create name=Client parent=Clients share=Access
```

It takes the arguments of [`google.drive-folder`](#googledrive-folder) and follows its rules,
creation, second runs, missing shares and Apply alike: a spreadsheet is a Drive item of the type
`application/vnd.google-apps.spreadsheet`, created by Drive's `files.create` in the parent, so
no Sheets API request is made and Google names its first tab. Only a spreadsheet of the row's
name counts as already there: a folder or another file of that name is a different item. Each
`create` shows the spreadsheet's address, `https://docs.google.com/spreadsheets/d/<id>/edit`,
before it exists.

## `google.drive-upload`

An action: sends each row's file, or its folder with everything under it, from the open
workspace into a Drive folder under the root, as the signed-in person, as a plan you read and
then apply. It needs Tyto 0.24.1 or later (plugin API 0.24), which reads a workspace file in
parts.

```
google.drive-upload from=Path to=Deliveries
```

| Argument     | What it does                                                                          |
| ------------ | ------------------------------------------------------------------------------------- |
| `from=`      | The column holding each row's file or folder, relative to the workspace; required.    |
| `to=`        | The Drive folder for every row: a folder directly in the root by its name, or its id. |
| `to-column=` | The column naming each row's Drive folder instead, as `to=` names one.                |

- **The workspace is read only through Tyto** (Tyto ADR 0130, ADR 0212), never opened by the
  plugin itself. A row whose path is not in the workspace fails in the plan.
- **A folder goes as a folder of its name** inside the destination, found or created, and so
  does every folder under it, at most six deep. A folder the plan creates shows its address,
  because its id is generated first.
- **One line per file**: `upload` for a file Drive does not have, `replace` for one it has of
  that name in that folder. **A replace keeps the Drive file's id**, so a link to it, in a sheet
  or anywhere, still opens it. Two files or two folders of one name in a Drive folder fail the row.
- **A file is left alone when Drive has one of its name, size and modification time** in that
  folder, with one warning listing them. The plugin sets the time of every file it sends to the
  local file's, so the next run sees the same, and an edit that keeps the size still counts. **A
  file put in Drive another way (dragged in a browser) has its own time, and is replaced once**,
  on the first run that meets it; after that it is left alone.

### Applying an upload

Every file goes through a resumable upload, in 8 MiB chunks, one read of the workspace each, so
a 100 MB editable never sits in memory whole. A chunk Drive loses (a 5xx, no answer) is followed
by asking the session how far it got, and the upload goes on from there; a 429 waits as every
request does (see [Retries](#retries)).

**A big file takes more than one Apply.** One Apply spends at most 20 s, under Tyto's 30 s for a
plugin call, and starts a chunk only when the last one's time still fits. A file not finished is
`skipped`, saying how much was sent: run the cell and Apply again, and it goes on from there,
because the session is kept in the plugin's cache (Drive keeps one for a week). Until Tyto calls
an Apply again on its own for such a file (TYTO-791), you apply until it reads `applied`.

A local file changed since the plan, or while it was sent, fails with `E_GOOGLE_CHANGED`. An
Apply run twice sends nothing again: a file already in Drive as planned counts as `applied`.

## `google.drive-count`

A transform: adds `<column>_images`, the number of PNG and JPEG files directly in the folder
each row names.

```
google.drive-count folder=Folder
```

| Argument  | What it does                                                          |
| --------- | --------------------------------------------------------------------- |
| `folder=` | The column holding each row's folder, as its id or address; required. |
| `type=`   | `image`, the only kind counted so far, and the default.               |
| `shapes=` | `yes` also adds `<column>_shapes`, each image shape and its count.    |

- Only the folder's direct children count, never a subfolder's, and never the trash.
- A blank cell gets an empty count; a cell that is not a folder id or address is refused.
- Each distinct folder is counted once. More than 100 distinct folders in one table is refused
  before any request: narrow the table first.

### Image shapes

```
google.drive-count folder=Folder shapes=yes
```

`<column>_shapes` is a text cell of `ratio:count` pairs joined by `,`, the most frequent shape
first and ties in text order: three 1080x1350 images and one 1080x1920 read `4:5:3,9:16:1`.

- A ratio within 2% of 1:1, 4:5, 9:16, 16:9, 3:2 or 2:3 reads as it, so `1081x1350` reads `4:5`.
- Wider than 2:1 reads `wide`, whatever the exact ratio.
- Any other image reads its own ratio, reduced: `1000x700` reads `10:7`.
- An image Drive reports no width or height for reads `?`.
- A folder with no images gets an empty cell; a blank folder cell gets none.
- The width and height come from Drive's `imageMediaMetadata` in the same listing the count
  already makes: no request per file.
- Without `shapes=yes` the transform is the same as before: one column, and no dimensions asked.

## `google.sheet-lookup`

A transform: adds columns of one tab to each row of the table, found by the row's key. It is how
a recipe that starts from another source sees what a person typed in a synced sheet, since a
recipe carries one table and `google.sheet-rows` only starts one.

```
google.sheet-lookup tab=Tasks key=ID columns=Status,Owner
```

| Argument       | What it does                                                                       |
| -------------- | ---------------------------------------------------------------------------------- |
| `spreadsheet=` | The spreadsheet, as its id or its address; the section's `spreadsheet` by default. |
| `tab=`         | The tab, by its name, as `google.sheet-rows` finds it; required.                   |
| `key=`         | The table's column to match by, against the tab's column of the same name.         |
| `columns=`     | The tab's columns to add, comma-separated; required.                               |
| `prefix=`      | What each added column's name starts with; `sheet_` by default.                    |
| `links=`       | Tab columns whose cell links become a `<prefix><column>_url` link column.          |
| `notes=`       | Tab columns whose cell notes become a `<prefix><column>_note` text column.         |

- **Matching** is by the key's text, trimmed and with its case kept, exactly as
  `google.sheet-sync` matches rows: a number cell matches its digits. The table's column and the
  tab's column carry the same name (case ignored); a lookup across two differently named columns
  is not offered yet.
- A row whose key the tab lacks, or whose key is blank, gets null in every added column. A tab
  row with a blank key matches nothing. **A key the tab holds twice is refused**, naming both
  rows: the lookup never guesses which row is meant.
- Added columns are typed as `google.sheet-rows` types them, and are named `sheet_<column>` (the
  tab's header spelling) or with `prefix=`. A name the table already has is refused, never
  overwritten.
- **The tab is read as `google.sheet-rows` reads it**: once per step, from the same cache entry
  while Drive gives the same `version`, which any edit to the spreadsheet raises. Running again
  without cache does not reach a transform yet (Tyto's plugin API hands it to sources only), so
  the lookup relies on that version.

## `google.drive-url`

A transform: adds `<column>_url`, a link to the Drive folder that
[`google.drive-upload`](#googledrive-upload) sends each row's workspace folder to.

```
google.drive-url path=Path in=Deliveries
```

| Argument | What it does                                                                        |
| -------- | ----------------------------------------------------------------------------------- |
| `path=`  | The column holding each row's workspace folder, as `from=` of the upload; required. |
| `in=`    | The Drive folder the upload went to, as its `to=`; the root by default.             |

- The folder looked up is the one named as the path's last segment (`entregas/D1` reads `D1`),
  directly in `in=`, not in the trash: the folder the upload finds or creates.
- **Empty while the folder is not there**: a recipe can run it before the first upload is
  applied, and the next run fills it in. Two folders of one name leave it empty too, with a
  warning, as the upload refuses that row.
- Each distinct name is looked up once; more than 100 in one table is refused before any
  request. Nothing is written.

### Using the link

`<column>_url` is a link column, so the verbs that write a sheet link with it: beside a `Path`
column, `google.sheet-write` and `google.sheet-sync` write `Path` as text linked to the folder.
A step that writes a tracker field, such as a Jira card's folder field, can take its value from
the same column; which field, and in which flow, is the workspace recipe's to say (TYTO-758),
never this plugin's.

```
google.drive-upload from=Path to=Deliveries
google.drive-url path=Path in=Deliveries
google.sheet-sync tab=Deliveries key=Path
```

## Retries

A 429, and Drive's `rateLimitExceeded` and `userRateLimitExceeded` 403s, are retried on any
request; a 5xx and a network failure only on a read, because a write that failed that way may
have been done. Each retry waits Google's `Retry-After`, or 10 s and then 20 s, and never past
20 s from the first try: Tyto gives one call of a plugin 30 s. Past that, the call answers
`E_GOOGLE_RATE` and asks you to run again in a minute. A redirect is never followed.

## Errors

| Code                | What happened                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `E_GOOGLE_CONFIG`   | A wrong `google` section, or an API not enabled in the OAuth client's Cloud project.          |
| `E_GOOGLE_SIGNIN`   | Nobody is signed in, the sign-in failed, or this terminal has no keychain and cannot sign in. |
| `E_GOOGLE_AUTH`     | Google refused your token, or the file is not shared with the account signed in.              |
| `E_GOOGLE_REDIRECT` | Google answered a redirect, which is never followed.                                          |
| `E_GOOGLE_HTTP`     | Any other failed answer, such as a missing file or a 5xx still failing after its retry.       |
| `E_GOOGLE_RATE`     | Google kept asking to slow down for the whole retry budget.                                   |
| `E_GOOGLE_NETWORK`  | No answer: Tyto refused the request, or the network failed.                                   |
| `E_GOOGLE_RESPONSE` | A 2xx that is not the JSON Google promises.                                                   |
| `E_GOOGLE_PLAN`     | A planned row that cannot be written as planned: run the cell again for a new plan.           |
| `E_GOOGLE_CHANGED`  | The tab or the file changed since the plan: run the cell again for a new plan.                |

No message carries your access token, even when Google echoes it.

## Development

`pnpm check` runs Prettier, the type checker, ESLint and the tests; `pnpm build` writes
`dist/index.js`, which is committed and which CI rebuilds and compares.

The plugin depends on Tyto's published contract, `@tyto/plugin-api`, which GitHub Packages
holds as `@rafaelsilvalor/tyto-plugin-api` (Tyto ADR 0149); `package.json` aliases it, so the
code imports `@tyto/plugin-api`. Installing it needs a GitHub token with `read:packages`, and
pnpm reads that token only from your user-level `~/.npmrc`, never from the committed one:

```sh
gh auth refresh -s read:packages
echo '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}' >> ~/.npmrc
NODE_AUTH_TOKEN=$(gh auth token) pnpm install
```

The plugin imports only types from it, so the bundle does not change. The tests run the
committed `dist/index.js` through the contract's own harness, `@tyto/plugin-api/testing` (Tyto
ADR 0150): build before you test.

### The live suite

`tests/live.test.ts` runs the plugin against the real Google, read-only, as you: it reads one
sheet with `google.sheet-rows` and lists one folder with `google.drive-list`, signed with
`GOOGLE_LIVE_ACCESS_TOKEN` (an access token of your own sign-in, with the Drive scope), asserts
only the shape of what came back, and prints only counts. It is skipped unless all three
variables are set, so CI skips it:

```sh
pnpm build
GOOGLE_LIVE_ACCESS_TOKEN=<access token> GOOGLE_LIVE_SHEET=<spreadsheet id or address> GOOGLE_LIVE_FOLDER=<folder id or address> pnpm test:live
```

Use a sheet and a folder your own account can open. Keep the token out of this repository.

The same file holds a second, separate suite for the verbs that create, as you. It is skipped
unless `GOOGLE_LIVE_ACCESS_TOKEN` and
`GOOGLE_LIVE_PARENT` (the folder to create in, as its id or address) are set. It creates one
folder with `google.drive-folder` and one spreadsheet with `google.sheet-create`, each named
with the run's date and time, applies them, and checks that a second run plans nothing. With
`GOOGLE_LIVE_SHARE_EMAIL`, each is shared with that address as a reader, with no email sent.
**It deletes nothing**: remove the two items by hand afterwards.

```sh
pnpm build
GOOGLE_LIVE_ACCESS_TOKEN=<access token> GOOGLE_LIVE_PARENT=<folder id or address> pnpm test:live
```

The `contract` workflow runs every day, and on demand, against the newest published contract
rather than the range in `package.json`: a red run there is a Tyto release this plugin does not
yet work with.
