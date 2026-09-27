# Set up Rosetta with an AI agent

Paste the prompt below into your coding agent (Claude Code, Cursor, Codex,
opencode, …) from the root of your project. The agent will find your locale files,
configure Rosetta, adopt your existing translations for free, report any
translations that are broken today, wire up CI, and open one PR.

For ongoing use, also install the [Rosetta skill](../skills/rosetta/SKILL.md) so
your agent knows the day-to-day commands. See
[Install the skill](#install-the-skill).

## The prompt

````text
Set up Rosetta (npm: rosetta-i18n) for translations in this repository, then open one focused PR.

Rosetta is a free, open-source, self-run localization CLI (a DIY Lingo.dev). It translates our source-language JSON/JSONC locale files into every target locale with an LLM, and keeps all state in the repo: .rosetta/config.json (JSONC) and .rosetta/lock.json (a hash of the source string each translation came from). There's no Rosetta service or account. The only credential is our model provider's key: OPENROUTER_API_KEY by default, or the variable named by engine.apiKeyEnv. Never print, commit, or go looking for keys.

First, read the full instructions and follow them: https://raw.githubusercontent.com/ian/rosetta/main/skills/rosetta/SKILL.md
If you can't fetch URLs, follow this summary:

1. Discover, with no edits, and report back:
   - the i18n runtime and loader;
   - the source-locale files (Rosetta v1 supports JSON/JSONC; source copy in TS/JS needs an export-to-JSON script; Markdown/YAML/PO stay as they are);
   - the canonical locale list and everywhere it's mirrored;
   - the current translation engine (Lingo.dev, scripts, vendor, hand-written) and its brand voice, context, do-not-translate and structural-field lists;
   - tests that enforce locale parity;
   - how translations land in CI today, and whether OPENROUTER_API_KEY is a CI secret;
   - formatters that touch locale files;
   - in a monorepo, which package owns the locale files (put .rosetta/ there).
2. Install: `npm i -D rosetta-i18n@next` (the `next` tag until 1.0.0 is stable; use the repo's package manager), then `npx rosetta init` (auto-detect), or `init --pattern <source file> --target <locales> --model <id>`, or `init --from-lingo`. Always run the local `rosetta` command. Never run a bare `npx rosetta` without a local install; it's an unrelated package.
3. Configure .rosetta/config.json:
   - targetLocales = the app's locale list minus the source;
   - one files[] entry per source file or glob. The path must contain the source locale, e.g. messages/en.json, locales/en/**/*.json, pages.en.json;
   - a context per file;
   - lockedKeys ("**.href" style) for structural strings;
   - move the old engine's brand voice, rules, and do-not-translate terms into engine.brandVoice, engine.rules, and engine.glossary["*"];
   - keep the model the project already uses, if any.
4. Adopt: run `npx rosetta status` and `npx rosetta status --json` (no key needed).
   - Existing valid translations show as "adopt", and push records them for free.
   - Keys marked translate/invalid are translations that are broken today. List them for me by key and locale.
   - Run `npx rosetta push` if nothing needs a model, or if a key is set. Otherwise leave lock.json for the first CI run.
   - Confirm that `git diff` on target files shows no formatting churn, and that `npx rosetta check` passes after a push.
5. Add tests: config targetLocales equals the app's locale list (use loadConfig from rosetta-i18n); lockedKeys matches any structural-field list in code; any export script exports the expected keys.
6. CI: keep whatever landing flow already works and swap in `rosetta push`, or propose one of:
   - local/agent pushes plus a `rosetta check` gate;
   - `uses: ian/rosetta@<pinned version>` with mode: pull-request, commit, or check.
   Watch for these:
   - a locale-parity test means PRs that add or remove keys must run `rosetta push` themselves (removals need no key);
   - `check` on PRs conflicts with post-merge bots;
   - GITHUB_TOKEN commits and PRs don't trigger other workflows, so use an App token or PAT, or the existing landing logic;
   - push exits 1 when some locales failed validation: land the rest, then fail the job.
7. Clean up and document:
   - delete the old engine (scripts, manifests, force-retranslate workarounds, .lingo/, i18n.json/i18n.lock) and unused deps;
   - add one AGENTS.md paragraph: edit the source only, never hand-edit other locales, the status/push commands, how translations land, and the add/remove-key rule;
   - add package scripts for status/push (plus an export step if there is one).
   Run typecheck, lint, and tests. Open one PR that includes the broken translations you found.

Stop and ask me before: choosing how translations land if it's unclear, running `push --force`, or anything that would send a large number of strings to the model (check with `npx rosetta push --estimate`).
````

## Install the skill

The skill teaches your agent Rosetta's commands, config, and troubleshooting, so
day-to-day requests like "add a Spanish string for X" or "why is the i18n job red?"
just work.

```bash
# Claude Code (project-level)
mkdir -p .claude/skills/rosetta && curl -fsSL https://raw.githubusercontent.com/ian/rosetta/main/skills/rosetta/SKILL.md -o .claude/skills/rosetta/SKILL.md

# opencode / other agents that read ~/.agents/skills (user-level)
mkdir -p ~/.agents/skills/rosetta && curl -fsSL https://raw.githubusercontent.com/ian/rosetta/main/skills/rosetta/SKILL.md -o ~/.agents/skills/rosetta/SKILL.md
```

The skill also ships in the npm package at
`node_modules/rosetta-i18n/skills/rosetta/SKILL.md`, so you can copy or symlink it
from there to keep it matched to your installed version.

## Runtime translation (DB/CMS content, per-request copy)

The prompt covers locale files. For content stored in a database or generated per
request, add this to the prompt:

````text
Also translate <entity> content stored in <table/CMS>: on create/update, call Rosetta's library server-side (new Rosetta({...}).translateEntries(fields, { source, target, context })). It returns { translations, failures } and doesn't throw for per-key problems. Store only `translations`, keyed (entityId, field, locale), and queue the work off the request path. Fall back to the source locale at read time, and backfill existing rows ordered by traffic. For Next.js server code, use cachedTranslate from rosetta-i18n/next. Never import Rosetta in client code.
````

See [`migration-guide.md`](./migration-guide.md) for the full playbook for those
modes.
