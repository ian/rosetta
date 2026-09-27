# Rosetta v1 Spec

- **Status:** Accepted, in implementation
- **Package:** `rosetta-i18n@1.0.0`
- **License:** MIT
- **Runtime:** Node >= 20, zero runtime dependencies

## 1. Summary

Rosetta is a **free, open-source Lingo.dev that you run yourself**. It uses the same workflow as Lingo.dev v1: a `.rosetta/` directory committed to the repo holds a config and a lockfile, and a `push` command translates only what changed. Everything runs on your own machine or CI runner, against any OpenAI-compatible model, with your own API key. There's no account, no server and no hosted engine. The brand voice, glossary and rules are files in your repo.

The day-to-day workflow:

```
rosetta init     # once: writes .rosetta/config.json
rosetta push     # translate new/changed strings, prune removed ones, update .rosetta/lock.json
rosetta check    # CI gate: fail if anything is stale, missing, or broken (no API key needed)
```

Edit the source language, run `push` (or let CI or an agent run it), and commit the result.

## 2. Goals and non-goals

### Goals

- One command, `rosetta push`, translates new and **changed** strings and prunes removed ones. You never pass a force flag just because you edited a source string.
- A broken or partial translation file is never written.
- It's close enough to Lingo.dev v1 (file layout, field names, commands) that migrating takes minutes.
- It doesn't dictate how translations land. It works locally, from an agent, in CI, as a direct commit, or as a pull request.
- Output is machine-readable (`--json`) and exit codes are stable, so agents and scripts can drive it.
- It has zero runtime dependencies.

### Non-goals for v1

- A hosted service, a UI, or a "pull" of runs from a server.
- Any file format other than JSON and JSONC. Markdown/MDX is tracked as a separate issue.
- Detecting renamed keys, a translation-memory cache, or AI review scoring.
- Loading TypeScript or JavaScript source modules. Projects export those to JSON themselves.

## 3. Concepts

| Term | Meaning |
|---|---|
| Source file | A file in `sourceLocale`. Rosetta reads it and never writes it. |
| Target file | A file derived from a source file for one target locale. Rosetta generates it. |
| Key | A dotted path to a string leaf, such as `Auth.signIn.title` or `sections.0.items.2.title`. |
| Engine | The local translation setup: model, endpoint, brand voice, rules and glossary. |
| Lockfile | Records the hash of the source string that each target key was translated from. |

## 4. Repository layout

```
.rosetta/
  config.json        # required, edited by hand; comments and trailing commas allowed
  lock.json          # written by Rosetta; plain JSON with sorted keys
  glossary.json      # optional, referenced from config
  voice/*.md         # optional brand-voice files, referenced from config
```

- **Finding the config.** Rosetta walks up from the current directory to the nearest `.rosetta/config.json`. `--config <path>` overrides this.
- **Project root.** This is the directory that contains `.rosetta/`. File patterns are relative to it. File references inside `engine` are relative to `.rosetta/`.
- **What to commit.** Commit both `.rosetta/config.json` and `.rosetta/lock.json`. Target files are committed next to their source files.

## 5. Configuration: `.rosetta/config.json`

```jsonc
{
  "$schema": "https://unpkg.com/rosetta-i18n@1/schema/config.json",
  "sourceLocale": "en",
  "targetLocales": ["es", "ja", "zh-CN"],
  "files": [
    {
      "pattern": "apps/web/i18n/messages/en.json",
      "context": "Web app UI catalog (next-intl).",
      "lockedKeys": [],
      "preservedKeys": [],
      "ignoredKeys": []
    }
  ],
  "engine": {
    "model": "z-ai/glm-5.3-flash",
    "baseURL": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "ROSETTA_API_KEY",
    "temperature": 0.3,
    "brandVoice": { "*": "voice/_default.md", "ja": "Polite, concise (です/ます)." },
    "rules": ["Never translate product names Jot, Quip, Notion."],
    "glossary": "glossary.json",
    "batchSize": 25,
    "concurrency": 4,
    "retries": 2,
    "timeoutMs": 120000
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `sourceLocale` | yes | BCP 47 code. |
| `targetLocales` | yes | Must not be empty, and must not contain `sourceLocale`. |
| `files[].pattern` | yes | Path or glob (`*`, `**`) of the source files. The path must contain the source locale code (see §6). |
| `files[].format` | no | `json` or `jsonc`. Inferred from the file extension if omitted. |
| `files[].context` | no | Sent with every batch from this file. |
| `files[].lockedKeys` / `preservedKeys` / `ignoredKeys` | no | Key globs. See §8. |
| `engine.model` | for `push` | `ROSETTA_MODEL` overrides it. `check`, `status`, and `purge` work without it. |
| `engine.baseURL` | no | Any OpenAI-compatible endpoint. Defaults to OpenRouter. `ROSETTA_BASE_URL` overrides it. |
| `engine.apiKeyEnv` | no | Name of the environment variable holding the key. Defaults to `ROSETTA_API_KEY`, then falls back to `OPENROUTER_API_KEY`. |
| `engine.temperature` | no | Default `0.3`. |
| `engine.brandVoice` | no | Map from locale to text, or to a `.md`/`.txt` path. The `*` entry is the fallback. |
| `engine.rules` | no | A string or a list of strings, added to the prompt. |
| `engine.glossary` | no | An inline object or a path. See §10.3. |
| `engine.batchSize` / `concurrency` / `retries` / `timeoutMs` | no | Defaults are 25, 4, 2 and 120000. |

- Unknown fields are an error. The Lingo.dev fields `orgId`, `engineId` and `github` are the exception: they produce a warning and are otherwise ignored.
- The config is validated when it loads. Errors report the field path, for example `files[1].pattern`.

## 6. Resolving paths

A pattern names the source file. For each target locale, Rosetta derives the target path by replacing the source locale code with the target code. It tries these rules in order:

1. **A whole path segment or filename is the locale.** `messages/en.json` → `messages/es.json`, and `content/en/app.json` → `content/es/app.json`.
2. **The locale ends a filename stem after `.`, `_` or `-`.** `marketing-pages.en.json` → `marketing-pages.es.json`, and `app_en.json` → `app_es.json`.
3. **Otherwise it's an error** (exit code 2) that names the pattern. Rosetta never invents a directory.

Globs are matched against source files, and each match is resolved separately, so directory structure is mirrored. Missing target files and directories are created.

## 7. File formats

- **Parsing.** The file is flattened to dotted keys. Array elements use numeric segments. Only string values can be translated.
- **Non-string values.** Numbers, booleans and null are copied from the source unchanged.
- **Non-translatable strings.** These are copied as-is and never sent to the model:
  - empty strings;
  - strings that are only whitespace, a number, a URL, an email address, a UUID or an ISO date;
  - strings with no letters in them.
- **Serializing.** The target mirrors the source's structure and key order exactly. It's written with 2-space indentation and a trailing newline. Keys in the target that aren't in the source are removed.
- **JSONC.** Parsing tolerates comments and trailing commas.
  - A comment directly above a key is that key's **translator note**.
  - A comment directly above an object applies to every key inside it.
  - Notes are sent to the model and never written to target files. JSONC targets are written as plain JSON.

## 8. Key controls

Key globs use `*` for exactly one segment and `**` for any number of segments. For example, `**.href` matches `href` at any depth, and `Marketing.*` matches the direct children of `Marketing`.

| Control | Behaviour |
|---|---|
| `lockedKeys` | Copies the source value into every target, untranslated. The copy follows the source when it changes. |
| `preservedKeys` | Translated once, the first time it's missing. After that, an existing target value is never overwritten. |
| `ignoredKeys` | Left out of target files entirely. |

If a key matches more than one control, `ignored` wins over `locked`, and `locked` wins over `preserved`.

## 9. Lockfile: `.rosetta/lock.json`

```json
{
  "version": 1,
  "files": {
    "apps/web/i18n/messages/en.json": {
      "es": { "Auth.signIn.title": "3f9a1c0b7d2e4a61" },
      "ja": { "Auth.signIn.title": "3f9a1c0b7d2e4a61" }
    }
  }
}
```

- **The hash** is SHA-256 of the source string, truncated to 16 hex characters. It covers the value only, not translator notes or context.
- **Entries are stored per source file, locale and key.** A newly added locale simply has no entries, and a failure in one locale never affects the others.
- **Writes are atomic** (temp file, then rename) and keys are sorted. A locale's entries are updated only after its target file has been written successfully.
- **Merge conflicts.** Take either side and run `rosetta push`. At worst a few keys get retranslated. There is intentionally no "rebuild the lockfile from the current files" command, because it would silently mark out-of-date translations as fresh.
- **Difference from Lingo.dev.** Lingo.dev's lockfile hashes whole files. Rosetta hashes each key, which is what lets it retranslate only the strings that were edited.

## 10. Translation pipeline

### 10.1 Planning

For each source file, locale and key, the first matching rule wins:

| # | Condition | Action | Lock entry |
|---|---|---|---|
| 1 | Key matches `ignoredKeys` | Omit | Removed |
| 2 | Key matches `lockedKeys`, or the value is non-translatable (§7) | Copy the source value | Set |
| 3 | Key is inside the `--key` or `--force` scope | Translate | Set on success |
| 4 | Target value is missing or empty | Translate | Set on success |
| 5 | Key matches `preservedKeys` | Keep | Set |
| 6 | Existing target value fails validation (§10.4) | Translate | Set on success |
| 7 | No lock entry, but a target value exists | **Adopt**: keep the value | Set to the current source hash |
| 8 | Lock hash differs from the current source hash | Translate | Set on success |
| 9 | Otherwise | Keep | Unchanged |

Target keys that aren't in the source are removed, together with their lock entries.

As a result, **a hand-edited target value is kept until the source string for that key changes**. When the source changes, the key is retranslated, which matches Lingo.dev v1.

### 10.2 Requests

- **Batching.** Keys are grouped by locale and split into batches of at most `batchSize` keys and about 8,000 characters of source text.
- **Concurrency.** Batches run with up to `concurrency` in flight across the whole run.
- **The request.** `POST ${baseURL}/chat/completions` with `response_format: {type: "json_object"}`.
  - If the provider rejects `response_format`, Rosetta retries once without it and remembers that for the rest of the run.
- **Timeout.** Each request has a timeout of `timeoutMs`.
- **Retries.** Network errors, 5xx and 429 responses are retried with exponential backoff (1 s, 2 s, 4 s…, with jitter), honouring `Retry-After`. There are at most `retries` retries.

### 10.3 Prompt

- **System prompt**, in this order:
  1. The brand voice for the locale.
  2. The rules.
  3. Glossary entries for the locale (`"term" → "rendering"`), plus the `*` entries, which are left untranslated.
  4. Fixed instructions: return a JSON object with exactly the given keys; keep `{placeholders}`, ICU syntax and `<tags>`; translate only human-readable text; output nothing else.
- **User message:** the file `context`, then per-key notes and breadcrumb hints (the parent key path), then the JSON payload.
- **Glossary file shape:** `{ "*": { "Jot": "Jot" }, "ja": { "workspace": "ワークスペース" } }`.

### 10.4 Validation

Before validating, Rosetta strips any code fences from the reply and parses the JSON. Then each key is checked:

- **Keys.** The reply must contain exactly the requested keys. Extra keys are dropped and missing keys count as failures.
- **Type.** The value must be a non-empty string.
- **Placeholders.** The set of simple arguments (`{name}`) must be the same as in the source.
- **ICU arguments.** Arguments must keep the same names and types: `plural`, `select`, `selectordinal`, `number`, `date` and `time`.
  - `select` must keep the same case keys.
  - `plural` must include `other`. Its other plural categories can differ from the source's, because they depend on the target language.
  - Braces must be balanced.
- **Tags.** The same set of tag names (such as `<strong>`) must appear, and each must be balanced.

Keys that fail are re-requested in a smaller batch, up to `retries` times. **If any key in a locale still fails, that locale's target file and lock entries are left untouched.** The error is reported, the remaining locales carry on, and the run exits with code 1.

## 11. CLI

The binary is `rosetta` (`rosetta-i18n` stays as an alias).

- Global flags: `--config <path>`, `--json`, `--quiet`.
- When the `CI` environment variable is set, `--yes` is assumed and Rosetta never prompts.

### `rosetta init`

- Creates `.rosetta/config.json`. It detects likely locale files (`**/en.json`, `**/locales/en/**`) and asks for confirmation unless `--yes` is passed.
- `--from-lingo` converts `.lingo/config.json`. It keeps `sourceLocale`, `targetLocales` and `files`, and drops `orgId` and `engineId`.
- It never overwrites an existing config.

### `rosetta push [patterns…]`

Plans, translates and writes. Positional patterns narrow the run to the matching source files.

| Flag | Meaning |
|---|---|
| `--locale <code>` (repeatable) | Only these locales. |
| `--key <glob>` (repeatable) | Retranslate matching keys even if their source is unchanged. Matches a prefix on a `.` boundary, or a glob. |
| `--force` | Retranslate everything in scope. Asks for confirmation unless `--yes`. |
| `--yes`, `-y` | Skip confirmation prompts. |
| `--estimate` / `--dry-run` | Print the plan and estimated tokens per locale, then exit without translating. |
| `--backfill-missing` | Accepted for Lingo.dev compatibility. Does nothing, because missing files are always backfilled. |

### `rosetta check`

Needs no API key and makes no model calls. It fails if any of the following is true:

- a target key's lock hash doesn't match the current source string;
- a target key is missing or empty, or has no lock entry;
- a target file contains keys that aren't in the source;
- a target value fails validation (§10.4). This catches bad hand edits.

### `rosetta status`

Read-only summary of what's out of date, per file and locale, with counts to translate, adopt, remove and keep. `--json` prints the full plan. `--exit-code` exits with code 3 when anything is out of date.

### `rosetta purge --locale <code> [--yes]`

Deletes that locale's target files and lock entries. The next `push` retranslates them from scratch.

### `rosetta pull`

Prints a message explaining that Rosetta runs locally, so there's nothing to pull, and exits 0. It exists so scripts written for Lingo.dev don't break.

### `rosetta translate-catalog`

Deprecated. It's kept for 0.x users and prints a warning to stderr. It will be removed in v2.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. For `check`, everything is up to date. |
| 1 | A translation or validation failure left one or more locales unwritten. |
| 2 | Usage, config or path-resolution error, or a missing API key. |
| 3 | `check` or `status --exit-code` found stale or invalid translations. |

### `--json` output

```json
{
  "command": "push",
  "ok": false,
  "locales": [
    { "locale": "es", "file": "apps/web/i18n/messages/es.json", "written": true,
      "translated": 12, "adopted": 0, "copied": 3, "removed": 1, "kept": 700, "errors": [] },
    { "locale": "ja", "file": "apps/web/i18n/messages/ja.json", "written": false,
      "errors": [{ "key": "Shell.count", "rule": "icu", "message": "missing plural argument {count}" }] }
  ],
  "usage": { "requests": 9, "inputTokens": 4120, "outputTokens": 1980 }
}
```

### Environment

| Variable | Purpose |
|---|---|
| `ROSETTA_API_KEY` (or whatever `engine.apiKeyEnv` names) | Model API key. Falls back to `OPENROUTER_API_KEY`. |
| `ROSETTA_MODEL`, `ROSETTA_BASE_URL` | Override the engine's model and endpoint. |
| `CI` | Makes Rosetta non-interactive (implies `--yes`). |

If no key is found, `push` exits with code 2 and a clear message. Workflows that need to skip translation (forks, for example) should use `mode: check` or an `if:` condition.

## 12. Library API

- **`Rosetta` class.** `translate()` and `translateText()` are kept.
  - `translate()` now validates its output and **throws `RosettaValidationError`** listing the keys that failed.
  - The previous behaviour of silently skipping failed batches is still available with `{ onBatchError: "skip" }`.
- **New exports** for embedding the workflow: `loadConfig(path?)`, `plan(config, opts)`, `push(config, opts)`, `check(config)` and `validateTranslation(source, target)`.
- **`rosetta-i18n/next`** is unchanged, apart from inheriting the translator hardening.
- **Packaging fixes.** The `./config` export resolves to a real runtime module, and `schema/config.json` ships in the package.

## 13. GitHub Action (`action.yml` at the repo root)

A composite action, used as `uses: ian/rosetta@v1`.

| Input | Default | Meaning |
|---|---|---|
| `mode` | `pull-request` | `pull-request`, `commit` or `check`. |
| `token` | `${{ github.token }}` | Used to push and to open PRs. |
| `branch` | `rosetta/translations` | The PR branch, in `pull-request` mode. |
| `commit-message` | `chore(i18n): update translations` | |
| `pr-title` / `pr-body` | defaults | The PR body includes the `--json` summary. |
| `args` | `""` | Extra arguments for `rosetta push`. |
| `working-directory` | `.` | |
| `version` | the Action's own version | Which `rosetta-i18n` version to run. |

The Action's outputs are `changed` (a boolean), `pr-url` and `commit-sha`.

What each mode does:

- **`pull-request`** runs `push`. If anything changed, it commits to `branch`, resetting it onto the current commit on every run, force-pushes, and **creates or updates a single rolling PR**.
- **`commit`** runs `push` and commits to the branch that triggered the workflow. If that branch has moved, it rebases and retries, up to 3 times.
- **`check`** runs `rosetta check`. No key is needed.

The docs must be explicit that GitHub doesn't run other workflows on PRs or commits created with the default `GITHUB_TOKEN`. If you want CI to run on translation PRs, use a GitHub App token or a PAT. The docs will also include a "dispatch CI, then push" recipe for teams that can't use either.

## 14. Documentation

- **README.** Built around the positioning. Covers the quickstart (`init`, `push`, commit), the config reference, how the lockfile works, and the planning table from §10.1.
- **`docs/migrating-from-lingo.md`.** Field-by-field and command-by-command mappings from Lingo.dev.
- **`docs/delivery.md`.** Recipes for each way of landing translations: local or agent, PR bot, commit to `main`, and check-only gate.
- **`docs/migration-guide.md` and `docs/agent-prompt.md`.** Updated from the 0.x `--merge` flow to v1.
- **`examples/next-intl/`.** A working example with its config, lockfile and workflow.

## 15. Tests (Vitest)

- **Planner.** Every rule in §10.1, their precedence, and removal of keys.
- **Path resolution.** Each rule in §6, globs, and the error case.
- **JSON/JSONC.** Round-trips that keep source order and structure, translator notes, and the non-translatable filter.
- **Validator.** Placeholders; ICU (differing plural categories allowed, `select` keys enforced); tags; missing and extra keys.
- **Translator.** Code-fence stripping, the JSON-mode fallback, retries with `Retry-After`, timeouts, and retrying only the failing keys.
- **Lockfile.** Atomic writes, sorted output, and updates only after success.
- **CLI end-to-end**, in temporary directories with a fake engine:
  - `init --from-lingo`;
  - `push` with new, edited, removed and adopted keys, `--key`, `--force`, and a locale that partly fails;
  - `check` exit codes;
  - `purge`;
  - the shape of the `--json` output.

## 16. Release

1. Publish `1.0.0-beta.1` and point the Action's `v1` tag at it.
2. Migrate Jot (Appendix A) and fix whatever that turns up.
3. Publish `1.0.0`. The existing npm OIDC workflow is used, and the `v1` tag moves with each release.

The changelog lists these breaking changes:

- `translate()` throws on validation failures;
- the Node minimum is now 20;
- `translate-catalog` is deprecated.

## 17. Follow-up GitHub issues

1. **Markdown/MDX support** (#1). Translate prose and opted-in frontmatter. Keys are positional in these formats, so `--key` is refused for them.
2. **MCP server for agents** (#2): `status`, `push`, `check` and glossary edits.
3. **Warn before overwriting a hand edit** (#3). This requires storing a hash of the target value in the lockfile.
4. **More formats** (#4): YAML, PO, XLIFF, ARB.
5. **Key rename detection** (#5).

## 18. Implementation plan

Each phase is delivered as its own PR.

1. **PR 1: spec and groundwork.**
   - This document.
   - Node `>=20` and a CI matrix of 20, 22 and 24.
   - Fix the `./config` export.
   - File the issues from §17.
2. **PR 2: core.**
   - Config loader and validation.
   - Path resolution and a hand-written glob matcher.
   - JSON/JSONC parse and serialize.
   - Lockfile.
   - Planner.
   - Validator.
   - Translator hardening.
   - Programmatic API.
   - Unit tests for all of the above.
3. **PR 3: CLI.**
   - `init` (including `--from-lingo`), `push`, `check`, `status`, `purge` and `pull`.
   - `--json` output and exit codes.
   - The deprecated `translate-catalog` alias.
   - End-to-end tests.
4. **PR 4: Action and docs.**
   - `action.yml`.
   - README, the new docs, updates to the existing docs, and the example.
5. **Release and Jot.**
   - `1.0.0-beta.1`.
   - A PR migrating the Jot repo.
   - `1.0.0`.

## Appendix A: migrating Jot (a PR in the Jot repo)

1. **Export the marketing pages.** Add `scripts/export-marketing-en.ts`, which writes `lib/marketing-pages.en.json` from `marketingPages`, leaving out the English-only keys. CI runs it before Rosetta and fails if the output is stale.
2. **Add `.rosetta/config.json`** with two entries:
   - `apps/web/i18n/messages/en.json`;
   - `apps/web/lib/marketing-pages.en.json`, with `lockedKeys` covering `NON_TRANSLATABLE_CONTENT_KEYS` (`**.href`, `**.path`, `**.type`, `**.price*`, `**.unit*`, and the rest).
3. **Move the prompt settings into `engine`.** That means `DEFAULT_BRAND_VOICE`, `CONTEXT` and the product-name rules. Set the model to `z-ai/glm-5.3-flash`.
4. **Run `rosetta push` once.** It adopts all the existing translations, so it costs nothing, and it writes `lock.json`.
5. **Delete the old tooling**: `translate-catalogs.ts`, `translate-content.ts`, `marketing-content.sources.json` and `force_keys`. Either keep the generated `.ts` wrappers or replace them with a generic loader.
6. **Update the workflows.**
   - Replace `i18n.yml` with `uses: ian/rosetta@v1` in `mode: pull-request`, using a GitHub App token so CI runs on the translation PR.
   - Add `mode: check` to `ci.yml`.
