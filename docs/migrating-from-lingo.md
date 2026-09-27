# Migrating from Lingo.dev

Rosetta follows the Lingo.dev CLI's layout, vocabulary, and flags. The difference
is that everything their hosted "localization engine" does (model choice, brand
voice, rules, glossary) is defined in your own config and runs locally with your
model key. There's no account, no server, and nothing to pull.

## 1. Import your config

```bash
npm install --save-dev rosetta-i18n
npx rosetta init --from-lingo
```

`init --from-lingo` reads, in order:

- **`.lingo/config.json`** (current CLI, v1): copies `sourceLocale`,
  `targetLocales`, and `files[].pattern` with their `lockedKeys`, `preservedKeys`,
  and `ignoredKeys`. `orgId` and `engineId` are dropped.
- **`i18n.json`** (legacy CLI, v0): copies `locale.source`, `locale.targets`, and
  `json`/`jsonc` bucket `include` patterns (with `[locale]` replaced by the source
  locale). Key paths are converted from `a/b` to `a.b`. `provider.model`,
  `provider.baseUrl`, and `provider.prompt` become `engine.model`,
  `engine.baseURL`, and `engine.rules`.

Rosetta v1 supports JSON and JSONC files. Anything else (Markdown, YAML, PO, …) is
skipped with a warning; see [#1](https://github.com/ian/rosetta/issues/1) and
[#4](https://github.com/ian/rosetta/issues/4).

## 2. Recreate your engine locally

Your Lingo.dev engine settings live on their platform. Copy them into `engine` in
`.rosetta/config.json`:

| Lingo.dev engine | Rosetta `engine` |
| --- | --- |
| LLM model (per language pair, with fallbacks) | `model` (one model; override per run with `ROSETTA_MODEL`) |
| Brand voice (one text per locale) | `brandVoice`: `{ "*": "...", "ja": "voice/ja.md" }` |
| Rules | `rules`: `["Put a space before % in French.", ...]` |
| Glossary (per locale, do-not-translate terms) | `glossary`: `{ "de": { "workspace": "Arbeitsbereich" }, "*": { "Acme": "Acme" } }` |
| AI reviewers / scoring | Not built in. Rosetta validates structure (placeholders, ICU, tags) instead |

The endpoint can be anything OpenAI-compatible: OpenRouter (the default), OpenAI,
Azure, a gateway, or Ollama (`"baseURL": "http://localhost:11434/v1"`).

## 3. Adopt your existing translations

```bash
npx rosetta status   # shows keys "to adopt"; nothing is retranslated
npx rosetta push     # records them in .rosetta/lock.json; no API calls if nothing is missing
npx rosetta check    # should pass
```

The first push adopts every existing translation that passes validation. Anything
missing, empty, or broken (a dropped `{placeholder}`, an unbalanced tag) is
retranslated. Keys that no longer exist in the source are removed.

Commit `.rosetta/` and delete `.lingo/` (or `i18n.json` and `i18n.lock`) once
you're happy.

## 4. Update CI

| Lingo.dev | Rosetta |
| --- | --- |
| Lingo.dev GitHub App (translation PRs) | `uses: ian/rosetta@v1` with `mode: pull-request` ([delivery guide](./delivery.md)) |
| `lingo push` + commit in your own runner | `uses: ian/rosetta@v1` with `mode: commit`, or `npx rosetta push` + your own commit step |
| `lingo check` | `rosetta check`, or the Action with `mode: check`; no secret needed |
| `LINGO_API_KEY` | `ROSETTA_API_KEY` (or `OPENROUTER_API_KEY`): your model provider's key |

## Command and flag reference

| Lingo.dev | Rosetta | Notes |
| --- | --- | --- |
| `lingo init` / `lingo link` | `rosetta init` | Nothing to link: the engine is in the config. |
| `lingo push` | `rosetta push` | Translates and writes files in one step. |
| `lingo push --key auth.login` | `rosetta push --key auth.login` | Same prefix semantics (`auth` claims `auth.*`, not `authority`). |
| `lingo push <pattern> --force --yes` | `rosetta push <pattern> --force --yes` | |
| `lingo push --backfill-missing` | `rosetta push` | Missing files are always backfilled; the flag is accepted. |
| `lingo push --estimate` | `rosetta push --estimate` | Heuristic token estimate. |
| `lingo pull` | not needed | `rosetta pull` exists and prints an explanation. |
| `lingo check` | `rosetta check` | Also validates placeholders, ICU, and tags. |
| `lingo purge --locale fr` | `rosetta purge --locale fr` | |
| `lingo login` / `logout` / `whoami` | not needed | Set `ROSETTA_API_KEY`. |

## Behavior differences

- **Lockfile granularity.** Lingo.dev's `.lingo/lock.json` hashes whole files.
  Rosetta's `.rosetta/lock.json` hashes each source string per locale, so an edit to
  one string retranslates only that string.
- **Hand edits.** Same model as Lingo.dev: an edited translation is kept until its
  source string changes, and `preservedKeys` protects a key permanently. Rosetta
  doesn't (yet) warn before a source change overwrites a hand edit
  ([#3](https://github.com/ian/rosetta/issues/3)).
- **Key renames.** Neither tool carries translations across a key rename today; a
  renamed key is retranslated ([#5](https://github.com/ian/rosetta/issues/5)).
- **Target paths.** The same substitution rules apply (`locales/en.json` →
  `locales/de.json`, `app.en.json` → `app.de.json`). Where Lingo.dev would invent a
  `<locale>/` directory, Rosetta refuses the pattern.
- **Translator notes.** JSONC comments above a key are sent to the model, like
  Lingo.dev. Same-line trailing comments work too.
