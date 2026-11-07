# tyto-plugin-google

A [Tyto](https://github.com/rafaelsilvalor/tyto) plugin that reads and writes Google Sheets and
Google Drive from a recipe. Tyto knows no provider (Tyto ADR 0011, ADR 0127): everything
Google-specific lives here, in its own repository, and reaches Tyto only through the plugin API.
This repository is public and unlicensed.

**Work in progress.** This version installs and activates, and adds no verb yet. The verbs
arrive one pull request at a time, all in the `google` namespace: `google.sheet-rows`,
`google.sheet-write`, `google.sheet-sync`, `google.drive-list`, `google.drive-read`,
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
