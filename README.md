# tyto-plugin-google

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin that reads and writes Google Sheets and
Google Drive from a recipe. Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything
Google-specific lives here, in its own repository, and reaches Tyto only through the plugin API.
This repository is public and unlicensed.

Nine recipe verbs, all in the `google` namespace:

| Verb                  | Kind      | What it does                                                       |
| --------------------- | --------- | ------------------------------------------------------------------ |
| `google.sheet-rows`   | source    | One tab of a spreadsheet as a table.                               |
| `google.sheet-write`  | sink      | Writes the table into a tab, replacing it or under its last row.   |
| `google.sheet-sync`   | sink      | Makes a tab hold the table's rows, matched by a key column.        |
| `google.drive-list`   | source    | A Drive folder's children, one row per file or folder.             |
| `google.drive-read`   | source    | What a JSON or text file in Drive holds, as rows.                  |
| `google.drive-move`   | action    | Moves each row's file or folder into a folder under the root.      |
| `google.drive-folder` | action    | Creates a folder per row as you, and shares it with listed people. |
| `google.drive-count`  | transform | Adds the number of PNG and JPEG files in each row's folder.        |
| `google.sheet-lookup` | transform | Adds a tab's columns to each row, found by a key column.           |

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

| Permission                    | Why                                                            |
| ----------------------------- | -------------------------------------------------------------- |
| `net:oauth2.googleapis.com`   | Exchanges the service account's signed assertion for a token.  |
| `net:sheets.googleapis.com`   | The Sheets API: reading and writing a spreadsheet.             |
| `net:www.googleapis.com`      | The Drive API: listing, reading and moving files.              |
| `credentials:service-account` | The service account's JSON key, kept by Tyto, never in a file. |
| `signin:google`               | Your own Google sign-in, run by Tyto in your browser.          |

The verbs that read, write and move act as the service account. `google.drive-folder`, which
creates, acts only as you, with your own sign-in, and shares only with the people its table
lists: the service account is never given access to what it creates. See
[Signing in as yourself](#signing-in-as-yourself).

## Credentials

The plugin signs in as a Google Cloud service account, with the account's JSON key. Create
one in Google Cloud (IAM, Service accounts, Keys, **Add key**, JSON), enable the Sheets and
Drive APIs in its project, and share each spreadsheet or folder with the account's email, the
key's `client_email`, such as `tyto@example-project.iam.gserviceaccount.com`: as an editor for
anything a sink or an action writes, as a viewer for what is only read. A file the account
cannot see answers as missing, and the error names the email to share it with.

| Where        | The whole JSON key, from `{` to `}`          |
| ------------ | -------------------------------------------- |
| Command line | `TYTO_PLUGIN_GOOGLE_SERVICE_ACCOUNT`         |
| Desktop app  | the system keychain, from the plugins screen |

The key must be a `service_account` key with a PKCS#8 `private_key`. Its assertion goes only to
`https://oauth2.googleapis.com/token`, whatever the key's `token_uri` says; a key naming another
endpoint is refused. The access token it buys is kept in the plugin's memory only, never in a
file or in Tyto's cache, and is renewed a minute before it expires.

## Signing in as yourself

A service account owns no storage in a person's Drive, so what the plugin creates there it
creates as you, with your own Google sign-in. Tyto runs that sign-in, not the plugin: the
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

Saving another client, or clearing it, ends the sign-in made with the previous one. The fields
are write-only: Tyto keeps the client in the keychain and never shows it again.

When a verb needs your sign-in and nobody is signed in, it fails with `E_GOOGLE_SIGNIN` and says
to sign in on the plugins screen. The command line has no window to sign in from, so there the
same verb fails with `E_GOOGLE_SIGNIN` saying the command line cannot sign in; run that step in
the desktop app. Your access token is redacted from every message, as the service account's is.

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
  When Drive does not give a version, the tab is read live and nothing is cached.

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
  time), `url` (the item's page in Drive, a link) and `parent_id` (the folder listed). Each
  row's key and provenance is the item's Drive id.
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
```

| Argument  | What it does                                                                                    |
| --------- | ----------------------------------------------------------------------------------------------- |
| `file=`   | One file, as its id or its address.                                                             |
| `folder=` | Every JSON file directly in the folder, oldest first; the section's `root` when neither is set. |
| `type=`   | `json` or `text`, how `file=` is read; by default its type or name decides. A folder is JSON.   |

- **JSON**: an array gives one row per element, keyed `<file id>:<index>` from 0; an object
  gives one row, `<file id>:0`. An element's keys are its columns, after `file_id` and
  `file_name`; an element that is not an object goes into `value`. A column is a number, a
  boolean or a list only when every filled value in it is one, otherwise text; a nested object
  is kept as its JSON text.
- **Text**: one row per line, keyed `<file id>:<line>` from 1, with `file_id`, `file_name`,
  `line` and `text`.
- **A folder** is read one file per page, so each call downloads one file. Every file is read
  into the first file's columns: a later file's missing key is empty, a key the first file did
  not have is refused, and so is a value its column cannot hold. A folder or a file that
  changes between two pages of one run is refused; run again.
- **Refused**: a native Google file (Docs, Sheets, Slides), which has no content to download
  (read a spreadsheet with `google.sheet-rows`); a folder named as `file=`; a file over 8 MiB,
  by Drive's size before the download and by its bytes after; a folder of more than 1,000 JSON
  files.

## `google.drive-move`

An action: moves each row's Drive file or folder into one folder, as a plan you read and then
apply. Nothing moves until you apply it.

```
google.drive-list folder=https://drive.google.com/drive/folders/<inbox id> type=json
google.drive-move to=processed
```

| Argument | What it does                                                                         |
| -------- | ------------------------------------------------------------------------------------ |
| `to=`    | The folder the files move into: its address, its name, or its id; required.          |
| `file=`  | The column holding each file's id or address; `id`, as `google.drive-list` names it. |

- **The destination by name** is a folder of that name directly in the folder the row was
  listed from: the row's `parent_id`, as `google.drive-list` writes it, or the section's `root`
  when the table has no such column. Two folders of that name are refused; name one by its
  id. When no folder has the name and `to=` looks like a Drive id, it is read as one.
- **Everything stays under `root`.** The section's `root` is required, and the plan reads each
  file's folders upwards, at most six levels, to find it: a file outside it, deeper than six
  folders, or whose folders loop is shown as one that will fail, and is never moved. A
  destination outside it stops the plan. Folders the files share are read once per plan.
- **A missing destination stops the plan**: this version never creates a folder.
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
  Apply is signed with your sign-in; nobody signed in is `E_GOOGLE_SIGNIN`. The service account
  is not used and is shared nothing: a recipe that reads the new folder as it needs the folder
  shared with it by hand, or a `share=` entry naming it.
- **The parent stays under `root`**, which is required: a parent outside it, missing, or
  ambiguous stops the plan. This version creates no parent.
- **A second run creates nothing twice.** The plan asks Drive for a folder of the row's name
  directly in the parent, not in the trash; one found is left out, with a warning naming it,
  and so are its shares. Several found stop the plan. Two rows of one name fail the second.
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
fails with that reason and sends nothing; a share Drive refuses, such as an address outside a
domain that forbids it, fails alone. One batch spends at most 20 s; what it did not reach is
`skipped`, and applying again picks it up.

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

- Only the folder's direct children count, never a subfolder's, and never the trash.
- A blank cell gets an empty count; a cell that is not a folder id or address is refused.
- Each distinct folder is counted once. More than 100 distinct folders in one table is refused
  before any request: narrow the table first.

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

## Retries

A 429, and Drive's `rateLimitExceeded` and `userRateLimitExceeded` 403s, are retried on any
request; a 5xx and a network failure only on a read, because a write that failed that way may
have been done. Each retry waits Google's `Retry-After`, or 10 s and then 20 s, and never past
20 s from the first try: Tyto gives one call of a plugin 30 s. Past that, the call answers
`E_GOOGLE_RATE` and asks you to run again in a minute. A redirect is never followed.

## Errors

| Code                | What happened                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `E_GOOGLE_CONFIG`   | No key, a key that is not a service account's, a wrong `google` section, or an API not enabled.    |
| `E_GOOGLE_AUTH`     | Google refused the key (`invalid_grant`: revoked, or the clock is off), or the file is not shared. |
| `E_GOOGLE_REDIRECT` | Google answered a redirect, which is never followed.                                               |
| `E_GOOGLE_HTTP`     | Any other failed answer, such as a missing file or a 5xx still failing after its retry.            |
| `E_GOOGLE_RATE`     | Google kept asking to slow down for the whole retry budget.                                        |
| `E_GOOGLE_NETWORK`  | No answer: Tyto refused the request, or the network failed.                                        |
| `E_GOOGLE_RESPONSE` | A 2xx that is not the JSON Google promises.                                                        |
| `E_GOOGLE_PLAN`     | A planned row that cannot be written as planned: run the cell again for a new plan.                |
| `E_GOOGLE_CHANGED`  | The tab or the file changed since the plan: run the cell again for a new plan.                     |

No message carries the token, the signed assertion or the key, even when Google echoes them.

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

`tests/live.test.ts` runs the plugin against the real Google, read-only: it buys a token, reads
one sheet with `google.sheet-rows` and lists one folder with `google.drive-list`, asserts only
the shape of what came back, and prints only counts. It is skipped unless all three variables
are set, so CI skips it:

```sh
pnpm build
GOOGLE_LIVE_SA_FILE=<path to the service account's JSON key> GOOGLE_LIVE_SHEET=<spreadsheet id or address> GOOGLE_LIVE_FOLDER=<folder id or address> pnpm test:live
```

Share the sheet and the folder with the key's `client_email` first. Keep the key outside this
repository.

The `contract` workflow runs every day, and on demand, against the newest published contract
rather than the range in `package.json`: a red run there is a Tyto release this plugin does not
yet work with.
