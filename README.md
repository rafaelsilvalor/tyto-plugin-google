# tyto-plugin-google

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin that reads and writes Google Sheets and
Google Drive from a recipe. Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything
Google-specific lives here, in its own repository, and reaches Tyto only through the plugin API.
This repository is public and unlicensed.

**Work in progress.** This version reads a spreadsheet tab with `google.sheet-rows` and writes
one with `google.sheet-write`. The other verbs arrive one pull request at a time, all in the
`google` namespace: `google.sheet-sync`, `google.drive-list`, `google.drive-read`,
`google.drive-move` and `google.drive-count`.

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

The plugin signs in as a Google Cloud service account only. Signing in as a person is a later
version.

## Credentials

The plugin signs in as a Google Cloud service account, with the account's JSON key. Create
one in Google Cloud (IAM, Service accounts, Keys, **Add key**, JSON), enable the Sheets and
Drive APIs in its project, and share each spreadsheet or folder with the account's email,
such as `tyto@example-project.iam.gserviceaccount.com`.

| Where        | The whole JSON key, from `{` to `}`          |
| ------------ | -------------------------------------------- |
| Command line | `TYTO_PLUGIN_GOOGLE_SERVICE_ACCOUNT`         |
| Desktop app  | the system keychain, from the plugins screen |

The key must be a `service_account` key with a PKCS#8 `private_key`. Its assertion goes only to
`https://oauth2.googleapis.com/token`, whatever the key's `token_uri` says; a key naming another
endpoint is refused. The access token it buys is kept in the plugin's memory only, never in a
file or in Tyto's cache, and is renewed a minute before it expires.

## The `google` section of `.tyto/project.json`

```json
{
  "google": {
    "spreadsheet": "https://docs.google.com/spreadsheets/d/<id>/edit",
    "root": "https://drive.google.com/drive/folders/<id>"
  }
}
```

- `spreadsheet`: the spreadsheet the Sheets verbs read and write unless a step names another,
  as its id or its address.
- `root`: the Drive folder the Drive verbs stay under, as its id or its address.
- `tabs`: settings per tab, by the tab's name, for the verbs that format a tab.

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
| `E_GOOGLE_CHANGED`  | The tab changed since the plan where a row would land: run the cell again for a new plan.          |

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

The `contract` workflow runs every day, and on demand, against the newest published contract
rather than the range in `package.json`: a red run there is a Tyto release this plugin does not
yet work with.
