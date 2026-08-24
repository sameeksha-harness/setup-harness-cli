# GitHub Action to Setup Harness CLI

[![CI](https://github.com/sameeksha-harness/setup-harness-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/sameeksha-harness/setup-harness-cli/actions/workflows/ci.yml)
[![license badge](https://img.shields.io/github/license/sameeksha-harness/setup-harness-cli)](./LICENSE)

A GitHub Action that installs and authenticates the [Harness CLI (`hc`)](https://github.com/harness/harness-cli) so you can run `hc` commands directly in subsequent workflow steps.

## Usage

```yaml
- name: Setup Harness CLI
  uses: sameeksha-harness/setup-harness-cli@v1
  with:
    api-url: https://app.harness.io
    account: ${{ secrets.HARNESS_ACCOUNT_ID }}
    token: ${{ secrets.HARNESS_PAT_TOKEN }}

- name: Upload artifact
  run: hc artifact push generic my-registry ./artifact.tar.gz --name my-artifact --version ${{ github.sha }}
```

After `setup-harness-cli` runs, `hc` is on `PATH` and authenticated. Use **any `hc` command** in subsequent `run:` steps — artifact push, pipeline triggers, service management, or anything else the Harness CLI supports.

## Examples

### Upload multiple artifact types in one job

```yaml
- uses: sameeksha-harness/setup-harness-cli@v1
  with:
    api-url: https://app.harness.io
    account: ${{ secrets.HARNESS_ACCOUNT_ID }}
    token: ${{ secrets.HARNESS_PAT_TOKEN }}

- run: hc artifact push generic my-registry build.tar.gz --name my-app --version 1.0.0
- run: hc artifact push python my-registry dist/my_pkg-1.0.0.whl
- run: hc artifact push npm my-registry my-pkg-1.0.0.tgz
```

### Using environment variables (set once, reuse across jobs)

Set credentials at the workflow level so every job picks them up without repeating `with:`:

```yaml
env:
  HARNESS_URL:        https://app.harness.io
  HARNESS_ACCOUNT_ID: ${{ secrets.HARNESS_ACCOUNT_ID }}
  HARNESS_PAT_TOKEN:  ${{ secrets.HARNESS_PAT_TOKEN }}

jobs:
  upload-generic:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: sameeksha-harness/setup-harness-cli@v1
      - run: hc artifact push generic generictest test-artifact.txt --name test-artifact --version 1.0.0

  upload-rpm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: sameeksha-harness/setup-harness-cli@v1
      - run: hc artifact push rpm rpmtest /tmp/test-package.rpm

  upload-python:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: sameeksha-harness/setup-harness-cli@v1
      - run: hc artifact push python pythontest dist/my_pkg-1.0.0.whl
```

> `hc` is cached by version and OS after the first install. Subsequent jobs restore from cache instead of downloading, keeping install time under 1 second.

### Use a specific CLI version

```yaml
- uses: sameeksha-harness/setup-harness-cli@v1
  with:
    api-url: https://app.harness.io
    account: ${{ secrets.HARNESS_ACCOUNT_ID }}
    token: ${{ secrets.HARNESS_PAT_TOKEN }}
    hc-version: v1.3.43
```

By default the action installs `latest`. On GitHub-hosted runners it sends `GITHUB_TOKEN` when looking up that release so the GitHub API is less likely to rate-limit the call.

### Using the resolved version output

```yaml
- name: Setup Harness CLI
  id: setup
  uses: sameeksha-harness/setup-harness-cli@v1
  with:
    api-url: https://app.harness.io
    account: ${{ secrets.HARNESS_ACCOUNT_ID }}
    token: ${{ secrets.HARNESS_PAT_TOKEN }}

- run: echo "Using hc ${{ steps.setup.outputs.hc-version }}"
```

## Inputs

Credentials can be provided as action inputs or as environment variables. Inputs take precedence if both are set.

| Input | Env var | Required | Default | Description |
|-------|---------|----------|---------|-------------|
| `api-url` | `HARNESS_URL` | yes | — | Harness API base URL. No trailing slash (e.g. `https://app.harness.io`). |
| `account` | `HARNESS_ACCOUNT_ID` | yes | — | Harness account ID. |
| `token` | `HARNESS_PAT_TOKEN` | yes | — | Harness PAT token. Always pass via `${{ secrets.* }}` — the action masks it from logs automatically. |
| `hc-version` | — | no | `latest` | Harness CLI release tag to install (e.g. `v1.3.43`). Defaults to the latest release. If the requested version is already on `PATH`, install is skipped. |

## Outputs

| Output | Description |
|--------|-------------|
| `hc-version` | The resolved `hc` version that was installed (e.g. `v1.3.43`). |

## How it works

1. **Resolves version** — if `hc-version` is `latest`, fetches the current release tag from the GitHub Releases API (authenticated with `GITHUB_TOKEN` when available).
2. **Checks PATH** — if a matching `hc` version is already present, skips install entirely.
3. **Restores cache** — checks `@actions/cache` for a cached binary (keyed by version + OS/arch). On a hit, restores in ~1 second with no download.
4. **Installs** — on a cache miss, downloads the release tarball and `checksums.txt` directly from GitHub Releases, verifies the SHA-256 checksum, extracts the binary, and saves it to cache for future jobs.
5. **Authenticates** — runs `hc auth login` with the provided credentials. The PAT token is masked before any logging.
6. **Cleanup** — after the job finishes (even on failure), runs `hc auth logout` to remove credentials from the runner.

## Contributing

### Setup

```bash
npm install
```

### Test

```bash
npm test
```

### Build

```bash
npm run build
# Produces dist/index.js and dist/cleanup.js — commit alongside source changes.
```

### Architecture

- `src/install.ts` — resolves, caches, and installs `hc`. Handles `latest` resolution via GitHub API and cross-job caching via `@actions/cache`.
- `src/auth.ts` — pure login logic (`hc auth login`). No `@actions/*` imports, independently unit-testable.
- `src/index.ts` — wires `@actions/core` and `@actions/exec` to `install.ts` and `auth.ts`. Entry point for the main action step.
- `src/cleanup.ts` — runs `hc auth logout`. Entry point for the post-job cleanup step.
- `@vercel/ncc` bundles each entry point into a single file so `node_modules/` does not need to be committed.
