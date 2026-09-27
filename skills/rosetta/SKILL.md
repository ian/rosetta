---
name: rosetta
version: 1.0.0-beta.1
description: Set up and use Rosetta (rosetta-i18n), a free, open-source, self-run localization CLI (a DIY Lingo.dev). Use when the user wants to add or migrate translations for JSON/JSONC locale files (next-intl, i18next, vue-i18n, …), replace Lingo.dev or hand-maintained locale files, translate new or changed strings, fix broken translations, or wire translation into CI.
requires:
  bins: ["node"]
  env: ["OPENROUTER_API_KEY"]
---

# Rosetta

Rosetta translates a project's source-language strings into every target locale
with an LLM. All of its state lives in the repo:

```
.rosetta/
  config.json    # locales, source files, key controls, model, brand voice, glossary (JSONC)
  lock.json      # per file, locale and key: a hash of the source string each translation came from
```

The whole loop is: **edit the source language → `rosetta push` → commit.**
`rosetta check` gates CI without needing an API key.

**There is no Rosetta service, account, or Rosetta API key.** The only credential
is the model provider's key: `OPENROUTER_API_KEY` by default, or whatever variable
`engine.apiKeyEnv` names, pointing at any OpenAI-compatible endpoint via
`engine.baseURL`.

Full docs: https://github.com/ian/rosetta (README, `docs/spec-v1.md`,
`docs/delivery.md`, `docs/migrating-from-lingo.md`).

## Agent rules

- **Read before you write.** Run `rosetta status` (free, no key) before any `push`,
  and `push --estimate` before large or forced runs.
- **Never hand-edit target-locale files** unless the user asks you to. Edit the
  source locale and push. (Hand edits are kept until the source string changes.)
- **Never commit or print API keys.** If `push` exits 2 with "No API key", stop and
  ask the user to set the variable. Don't invent keys or look for them.
- **Always use `--json`** when you need to parse output. Exit codes: `0` ok,
  `1` some locales failed (not written), `2` usage/config error, `3` stale (`check`,
  `status --exit-code`).
- **Commands never prompt** when not attached to a TTY. `push --force` and `purge`
  need `--yes`, and `CI=true` implies it. Don't pass `--yes` for destructive
  operations without the user's approval.
- **The package is `rosetta-i18n` and its command is `rosetta`.** Use the local
  install (`npx rosetta`, `bunx rosetta`, `pnpm exec rosetta`). Without a local
  install, use `npx rosetta-i18n <cmd>`, **never** a bare `npx rosetta`, which
  fetches an unrelated package.

## Setting up Rosetta in a project

Work through these phases in order. Report what you found after phase 1 and your
plan after phase 2 before making changes, unless the user told you to just do it.

### 1. Discover (no edits)

Find, with file paths:

1. **i18n runtime and loader**: next-intl (`i18n/request.ts`), i18next,
   vue-i18n, custom. Rosetta feeds the runtime; it doesn't replace it.
2. **Source-locale files and their format.** Rosetta v1 translates **JSON and
   JSONC** only.
   - Source copy that lives in **TypeScript/JS objects** needs an export-to-JSON step
     (phase 3).
   - Markdown/MDX, YAML, and PO aren't supported yet. Leave them as they are and
     say so.
3. **The canonical list of target locales** (e.g. `LOCALES` in `i18n/locales.ts`)
   and every place it's mirrored.
4. **The current translation engine**, e.g. Lingo.dev (`.lingo/config.json` or
   `i18n.json`), custom scripts, a vendor, or hand-written files. Note any
   "do-not-translate" lists, brand-voice text, context strings, and structural-field
   lists: they become config.
5. **Tests that enforce locale parity** (e.g. "every locale has the same keys"
   or the same page shape). These decide the workflow (phase 6).
6. **CI**: how translations currently land (bot PR, direct push, manual), branch
   protection, and whether `OPENROUTER_API_KEY` exists as a CI secret. Check
   workflow files for `secrets.OPENROUTER_API_KEY`, or ask the user.
7. **Formatters** that touch locale files (Prettier, Biome). Rosetta writes 2-space
   JSON with a trailing newline in source key order. A formatter that rewrites
   generated files causes churn, so it should exclude them.
8. **Monorepos**: which package owns the locale files. Put `.rosetta/` in that
   package so `node_modules/.bin/rosetta` resolves there and paths stay short.

### 2. Plan

State which files become `files[]` entries, the target list, which keys to lock,
how translations will land (phase 6), and what you'll delete. Keep existing runtime
code unchanged.

### 3. Install and configure

```bash
npm install -D rosetta-i18n@next   # or: pnpm add -D / bun add -d / yarn add -D
# (`@next` until 1.0.0 is stable; after that use the default tag)
npx rosetta init                   # detects files + locales; or:
npx rosetta init --pattern messages/en.json --target es,ja,de --model <model-id>
npx rosetta init --from-lingo      # imports .lingo/config.json or legacy i18n.json
```

Then edit `.rosetta/config.json`. It's JSONC, so comments are allowed; keep a short
header comment explaining the workflow.

```jsonc
{
  "$schema": "https://unpkg.com/rosetta-i18n@1/schema/config.json",
  "sourceLocale": "en",
  "targetLocales": ["es", "ja", "de"],
  "files": [
    { "pattern": "messages/en.json", "context": "Acme web app UI (next-intl)." },
    {
      "pattern": "lib/pages.en.json",                  // exported from TS; see below
      "context": "Marketing pages; top-level keys are page ids.",
      "lockedKeys": ["**.href", "**.path", "**.type"] // structural: copied, never translated
    }
  ],
  "engine": {
    "model": "anthropic/claude-sonnet-4.5",            // any OpenRouter model id
    "brandVoice": { "*": "voice/default.md" },          // file relative to .rosetta/, or inline text
    "rules": ["Keep plan names (Free, Pro) consistent."],
    "glossary": { "*": { "Acme": "Acme" } }             // "*" = never translate
  }
}
```

Rules for the config:

- **`pattern`** is the source file (or glob), and it must contain the source locale.
  Targets are derived by swapping it: `messages/en.json` → `messages/es.json`,
  `locales/en/**/*.json` → `locales/es/**/*.json`, `pages.en.json` →
  `pages.es.json`. Rosetta refuses patterns where the locale isn't in the path.
  Rename or restructure instead.
- **`targetLocales`** must match the app's locale list exactly (minus the source).
  Add a test that asserts this (phase 5).
- **Key controls** use dotted paths. `auth` matches `auth` and everything under it;
  `*` matches one segment and `**` any depth.
  - `lockedKeys`: copied from the source untranslated, e.g. URLs, enum-like values,
    prices, terminal commands, anything a structural "don't translate" list already
    names.
  - `preservedKeys`: translated once, then never overwritten (reviewed legal copy).
  - `ignoredKeys`: left out of target files.
- URLs, emails, numbers, dates, UUIDs, bare `{placeholder}` strings, and
  non-string values are copied automatically; you don't need to lock them.
- Move existing brand voice, context strings, and do-not-translate lists from the
  old engine into `engine.brandVoice`, `files[].context`, and `engine.glossary["*"]`.
- **Model:** the user's choice. Rosetta asks for JSON output and strips code
  fences, so most instruction-following models work. Keep the one the project
  already uses if there is one.
- For a non-OpenRouter provider, set `engine.baseURL` (e.g.
  `https://api.openai.com/v1`, `http://localhost:11434/v1` for Ollama) and
  `engine.apiKeyEnv` (e.g. `"OPENAI_API_KEY"`).

**Source copy in code.** When strings live in a TS/JS module (often because they're
computed from constants), write a small script that imports the module and writes
the source-locale JSON (e.g. `lib/pages.en.json`), restricted to what's localized.
Then:

- Keep the TS module as the source of truth.
- Either gitignore the exported JSON and regenerate it before every Rosetta
  command, or commit it and add a test that it's in sync. Gitignoring is simpler.
- Add package scripts, e.g. `"i18n:export"`, `"i18n:status": "<export> && rosetta status"`,
  and `"i18n:push": "<export> && rosetta push"`.
- The existing target files must have the same structure as the export for adoption
  to work. If the old pipeline overlaid translations onto a clone of the English
  object, they will.

### 4. Adopt the existing translations (free)

```bash
npx rosetta status            # expect mostly "to adopt"
npx rosetta status --json     # inspect exactly which keys are "translate" and why
```

- **"adopt"** means an existing, valid translation that isn't recorded in the
  lockfile yet. `push` records it with no model call.
- **"translate"** with reason `invalid` means an existing translation that is
  broken today: a dropped `{placeholder}`, a mangled plural, or a broken tag.
  **Report these to the user as real bugs**, with key and locale. They're usually
  live bugs, e.g. `l'<privacy>` in Italian starts an ICU quote and kills the link.
- `missing` means an untranslated key, and `changed` means stale.

If nothing needs a model, run `npx rosetta push` now. Otherwise:

- **With a key available:** run `push`. Only the missing or invalid keys cost tokens.
- **Without a key:** leave `lock.json` for the first CI run. Don't hack around it.

Then verify:

- `npx rosetta check` passes (after a push).
- `git diff` on the target files is empty or only shows the intended fixes. If
  adoption rewrote formatting, fix the formatter exclusion. Don't commit the churn.

### 5. Guard it with tests

Add small tests in the project's framework:

- `.rosetta/config.json` `targetLocales` equals the app's locale list. Use
  `loadConfig({ cwd })` from `rosetta-i18n` to read it.
- If structural fields are listed in app code, `lockedKeys` matches that list.
- If there's an export script, it exports the expected set of keys or pages.

### 6. Choose how translations land

Ask the user, or keep whatever already works. All options use the same config:

| Workflow | How | Needs the key in CI |
| --- | --- | --- |
| Local or agent | Whoever edits the source runs `rosetta push` and commits with the change | no |
| Check-only gate | `rosetta check` on PRs, or `uses: ian/rosetta@v1` with `mode: check` | no |
| PR bot | `uses: ian/rosetta@v1` with `mode: pull-request` after merges to main | yes |
| Commit bot | `uses: ian/rosetta@v1` with `mode: commit`, or `rosetta push` plus your own landing step | yes |

Things to know before choosing:

- **Locale parity tests + post-merge bots.** If a test requires every locale to have
  the source's keys, a PR that **adds or removes keys** fails CI until it runs
  `rosetta push` itself. Removing keys never needs an API key. Edits to existing
  strings pass parity, so a post-merge bot can handle them. Document this for the
  team. Don't silently loosen the tests.
- **`check` on PRs conflicts with post-merge bots.** Every PR that edits source
  copy would fail. Use `check` only if translations are expected in the same PR.
- **`GITHUB_TOKEN` limitations.** Commits and PRs made with the default token don't
  trigger other workflows, so CI won't run on bot PRs, and protected branches may
  reject the push. Use a GitHub App token or PAT for bot modes, or keep the
  project's existing landing logic and just swap its translate step for
  `rosetta push`.
- **Partial failures.** `push` exits 1 when some locales failed validation. The
  others were written. Land them, then fail the job so someone notices.
- **Pinning.** Until 1.0.0 is stable, pin the Action to the installed version
  (`ian/rosetta@v1.0.0-beta.1`). By default the Action uses the project's own
  `node_modules/.bin/rosetta` when dependencies are installed.

Example of swapping in Rosetta while keeping an existing landing step:

```yaml
- name: Translate with Rosetta
  id: rosetta
  if: env.OPENROUTER_API_KEY != ''          # forks and unconfigured envs stay green
  working-directory: apps/web               # the package that owns .rosetta/
  run: |
    set +e
    npx rosetta push
    code=$?
    set -e
    echo "exit=$code" >> "$GITHUB_OUTPUT"
    if [ "$code" -ge 2 ]; then exit "$code"; fi   # config error: nothing written
# … existing "commit and land" step. Stage the locale files and .rosetta/lock.json
#   with quoted pathspecs so gitignored exports are skipped, e.g.
#   git add -- apps/web/messages 'apps/web/lib/pages.*.json' apps/web/.rosetta/lock.json
- if: steps.rosetta.outputs.exit == '1'
  run: echo "::error::Some locales failed validation and were not written" && exit 1
```

Trigger the workflow on changes to the source files, the export script and its
inputs, and `.rosetta/**`.

### 7. Clean up and document

- Delete the old engine: scripts, manifests, `force_keys`-style workarounds,
  `.lingo/`, `i18n.json`, `i18n.lock`, and unused dependencies.
- Update `AGENTS.md` (or the equivalent) with one paragraph: which files are the
  source, "never hand-edit other locales", the `i18n:status` / `i18n:push` commands,
  how translations land, and the parity-test rule for adding or removing keys.
- Add a short `docs/i18n.md` if the team needs more: recipes for adding a key,
  retranslating (`--key`), adding a locale, and troubleshooting.
- Run the project's typecheck, lint, and tests. Open one focused PR. List the
  broken translations you found and how the first run fixes them.

## Everyday use

```bash
npx rosetta status                      # what push would do (no key)
npx rosetta push                        # translate new/changed/broken, prune removed
npx rosetta push --locale ja            # one locale
npx rosetta push --key auth.login       # retranslate even though the source didn't change
npx rosetta push "content/en/**"        # only matching source files
npx rosetta push --estimate             # key counts and rough tokens; no model calls
npx rosetta push --force --yes          # redo everything in scope (expensive; ask first)
npx rosetta check                       # exit 3 if stale, missing, extra, or invalid (no key)
npx rosetta purge --locale fr --yes     # delete a locale so the next push redoes it
```

| Task | What to do |
| --- | --- |
| Add a string | Add it to the source file, then `push` |
| Change a string | Edit the source, then `push`. Only that key is retranslated |
| Remove a string | Remove it from the source, then `push` (prunes; no key needed) |
| A translation reads badly | `push --key <key>`, optionally after adding a rule or glossary entry |
| Changed model, voice, or glossary | `push --key <keys>` for what matters. `--force` redoes all (confirm the cost first) |
| Add a locale | Add it to the app's locale list **and** `targetLocales`, then `push` (creates its files) |
| Key never machine-translated | `preservedKeys`, then hand-write it once |
| Lockfile merge conflict | Take either side, then `push` (at worst a few keys are retranslated) |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `No API key: set OPENROUTER_API_KEY …` (exit 2) | Something needs translating. Ask the user to set the key (or `engine.apiKeyEnv`'s variable). |
| `✗ <locale> … not written` (exit 1) | Some keys failed validation after retries; they're listed. Re-run, since it's usually transient. If a key keeps failing, check its source for unbalanced `{`, or an apostrophe before `{` or `<`. Then `push --key <key>`. |
| `Can't derive target paths from "…"` | The source locale isn't in the path. Use `messages/en.json`, `en/…`, or `name.en.json`. |
| `Source file not found` | The pattern is wrong, or an export step didn't run first. |
| `check` reports `untracked` | Valid translations not yet in `lock.json`. `push` adopts them for free. |
| `check` reports `invalid` | A broken placeholder, ICU, or tag in a target (often a hand edit). `push` retranslates it. |
| Every push rewrites files with formatting-only diffs | A formatter reformats generated locale files. Exclude them from it. |
| `translate-catalog is deprecated` | The 0.x command. Migrate to `.rosetta/config.json` + `push`. |

## Library (runtime translation)

For content that isn't in locale files, such as DB/CMS records or per-request
copy, use the library server-side only:

- `new Rosetta({ apiKey, model, brandVoice: { variations: { "*": "…" } } })`
- `translateEntries(data, { source, target, context })` returns
  `{ translations, failures, usage }` and never throws for per-key problems. Store
  only `translations`, and fall back to the source for the rest.
- `translate()` throws `RosettaValidationError` on failures.
- `rosetta-i18n/next` provides `getRosetta()` and `cachedTranslate()` for Next.js.

Never import Rosetta in client code, and never expose the key.
