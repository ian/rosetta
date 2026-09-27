# Rosetta i18n

**A free, open-source localization tool you run yourself — a DIY [Lingo.dev](https://lingo.dev).**

Edit your source-language strings, run `rosetta push`, and every target locale gets
the new and changed strings translated by an LLM — with your brand voice, rules, and
glossary applied, and every placeholder, ICU plural, and `<tag>` validated before
anything is written. It runs on your machine or CI runner with **your own API key**
against any OpenAI-compatible model (OpenRouter, OpenAI, Ollama, …). No account, no
server, no per-seat SaaS — all state lives in your repo.

Named after the Rosetta Stone: one text, every language readable.

```bash
npm install --save-dev rosetta-i18n
npx rosetta init      # once: writes .rosetta/config.json
npx rosetta push      # translate what changed, write files + .rosetta/lock.json
npx rosetta check     # CI gate: fails if anything is stale or broken (no API key)
```

> The npm package is **`rosetta-i18n`** and installs a `rosetta` command. Without a
> local install, use `npx rosetta-i18n <command>`. A bare `npx rosetta` would
> fetch an unrelated package.

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Commands](#commands)
- [Validation](#validation)
- [Getting translations into your repo](#getting-translations-into-your-repo)
- [Coming from Lingo.dev](#coming-from-lingodev)
- [Library API](#library-api)
- [React & Next.js](#react--nextjs)
- [Development](#development)

## Quick start

Requires Node 20+.

```bash
npm install --save-dev rosetta-i18n    # or pnpm add -D / bun add -d
npx rosetta init
```

`init` finds your source-locale files (`messages/en.json`, `locales/en/*.json`,
`pages.en.json`, …), infers target locales from the files next to them, and writes
`.rosetta/config.json`. Pass `--pattern`, `--target`, or `--model` to set them
explicitly, or `--from-lingo` to import a Lingo.dev config.

Then set a key and push:

```bash
export ROSETTA_API_KEY=sk-or-...        # or OPENROUTER_API_KEY
npx rosetta push
```

Commit `.rosetta/` together with the translated files. From now on the loop is:
**edit English → `rosetta push` → commit.** Add `rosetta check` to CI to catch
anything that was missed.

Already have translations? The first `push` **adopts** them — it records them in
the lockfile without retranslating, so it's free. Only strings that are missing,
changed, or broken go to the model.

## How it works

Rosetta keeps a lockfile, `.rosetta/lock.json`, that records — for every file,
locale, and key — a fingerprint of the source string each translation was made
from. On `push`, each key falls into exactly one bucket:

| Situation | What `push` does |
| --- | --- |
| New key, or the target is missing/empty | Translate it |
| **Source string changed** since it was translated | Retranslate it |
| Existing translation fails [validation](#validation) (e.g. a dropped `{placeholder}`) | Retranslate it |
| Source unchanged | Keep the translation — **including hand edits** |
| Translation exists but isn't in the lockfile yet | Adopt it (no model call) |
| Key removed from the source | Remove it from every target |
| Key in `lockedKeys`, or not translatable (URL, number, date, `{count}`…) | Copy the source value |
| Key in `preservedKeys` | Translate once, then never overwrite |
| Key in `ignoredKeys` | Leave it out of target files |

Guarantees:

- **Only changed strings cost tokens.** A 10,000-key catalog with 12 edits sends 12 keys.
- **Edited source strings are always picked up** — no force flags or manual cleanup.
- **No partial files.** Every translated value is validated; failing keys are retried
  on their own. If a key still fails, that locale's file and lock entries are left
  untouched and the error is reported. Other locales still land.
- **Output mirrors the source.** Target files keep the source's structure and key
  order (2-space JSON, trailing newline), so diffs stay small and reviewable.

The full behavior is specified in [`docs/spec-v1.md`](docs/spec-v1.md).

## Configuration

```
.rosetta/
  config.json      # hand-edited (comments allowed)
  lock.json        # written by Rosetta — commit it, don't edit it
  glossary.json    # optional
  voice/*.md       # optional brand-voice files
```

Rosetta finds the config by walking up from the current directory, so commands work
from any subdirectory. Paths in `files` are relative to the directory containing
`.rosetta/`.

```jsonc
// .rosetta/config.json
{
  "$schema": "https://unpkg.com/rosetta-i18n@1/schema/config.json",
  "sourceLocale": "en",
  "targetLocales": ["es", "ja", "zh-CN"],
  "files": [
    { "pattern": "messages/en.json", "context": "Web app UI (next-intl)." },
    {
      "pattern": "content/en/**/*.json",
      "lockedKeys": ["**.href", "meta.version"],
      "preservedKeys": ["legal"],
      "ignoredKeys": ["internal"]
    }
  ],
  "engine": {
    "model": "anthropic/claude-sonnet-4.5",
    "baseURL": "https://openrouter.ai/api/v1",
    "brandVoice": { "*": "voice/default.md", "ja": "Polite and concise (です/ます)." },
    "rules": ["Never translate the product name Acme."],
    "glossary": "glossary.json"
  }
}
```

### Top-level fields

| Field | Required | Description |
| --- | --- | --- |
| `sourceLocale` | yes | Locale your source files are written in, e.g. `en`. Source files are never written. |
| `targetLocales` | yes | Locales to translate into. |
| `files` | yes | Source files to translate (see below). |
| `engine` | for `push` | Model, endpoint, and prompt settings (see below). `check`/`status`/`purge` don't need it. |

### `files[]`

| Field | Description |
| --- | --- |
| `pattern` | Source file path or glob (`*`, `**`). Must contain the source locale — see [target paths](#target-paths). |
| `format` | `json` or `jsonc` (default: from the extension). |
| `context` | Sent with every request for this file ("Checkout flow", "Marketing site"…). |
| `lockedKeys` | Copied from the source untranslated, kept in sync with it. |
| `preservedKeys` | Translated the first time, never overwritten afterwards (reviewed legal copy, etc.). |
| `ignoredKeys` | Omitted from target files. |

Key patterns use dotted paths: `auth.login` matches that key and everything under it
(but not `auth.loginUrl`), `*` matches one segment, and `**` matches any depth —
`**.href` matches every `href`. If a key matches more than one control, ignored wins
over locked, which wins over preserved.

### Target paths

Target paths are derived by swapping the locale code into the source path:

| Source pattern | Target (for `es`) |
| --- | --- |
| `messages/en.json` | `messages/es.json` |
| `locales/en/**/*.json` | `locales/es/**/*.json` (subtree mirrored) |
| `lib/pages.en.json` | `lib/pages.es.json` |
| `l10n/app_en.json` | `l10n/app_es.json` |

If the source locale appears nowhere in the path, Rosetta refuses the pattern rather
than guessing where targets should go.

### `engine`

| Field | Default | Description |
| --- | --- | --- |
| `model` | — | Model id. Overridden by `ROSETTA_MODEL`. |
| `baseURL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint, e.g. `http://localhost:11434/v1` for Ollama. Overridden by `ROSETTA_BASE_URL`. |
| `apiKeyEnv` | `ROSETTA_API_KEY` | Env var holding the key. `OPENROUTER_API_KEY` is always tried as a fallback. |
| `brandVoice` | — | Map of locale (or `*` fallback) to a voice briefing, inline or as a path to a `.md`/`.txt` file in `.rosetta/`. |
| `rules` | — | String or list of linguistic rules added to every prompt. |
| `glossary` | — | Inline object or path to a JSON/JSONC file: `{ "ja": { "workspace": "ワークスペース" }, "*": { "Acme": "Acme" } }`. Terms under `*` are never translated. |
| `temperature` | `0.3` | Sampling temperature. |
| `batchSize` | `25` | Max keys per request. |
| `concurrency` | `4` | Max requests in flight across all locales. |
| `retries` | `2` | Retries per request and per failing key. |
| `timeoutMs` | `120000` | Per-request timeout. |

The prompt applies, in order: brand voice → rules → glossary → output rules.

### Translator notes (JSONC)

In `.jsonc` source files, a comment above a key — or at the end of its line — is sent
to the model as context for that key. A comment above an object applies to every key
inside it. Notes never appear in the output.

```jsonc
{
  // Top navigation — keep labels short
  "nav": {
    "light": "Light", // the theme, not weight
    "records": "Records"
  }
}
```

## Commands

| Command | What it does |
| --- | --- |
| `rosetta init` | Create `.rosetta/config.json`. Flags: `--pattern`, `--target`, `--source`, `--model`, `--from-lingo`, `--yes`. Never overwrites an existing config. |
| `rosetta push [patterns…]` | Translate new/changed strings, prune removed ones, write targets and the lockfile. |
| `rosetta check [patterns…]` | Exit 3 if any target is stale, missing, untracked, has extra keys, or fails validation. Never calls a model. |
| `rosetta status [patterns…]` | Show per-locale counts of what `push` would translate, adopt, and remove. `--exit-code` exits 3 if anything is pending. |
| `rosetta purge --locale <code>` | Delete a locale's files and lock entries so the next `push` redoes it. |
| `rosetta pull` | No-op, so Lingo.dev scripts keep working — Rosetta translates locally in `push`. |

`push` flags:

| Flag | Description |
| --- | --- |
| `--locale <code>` | Only these locales (repeatable or comma-separated). |
| `--key <pattern>` | Retranslate matching keys even if the source is unchanged — the cheap way to redo a few strings. |
| `--force` | Retranslate everything in scope (e.g. after changing model or glossary). Asks for confirmation. |
| `--estimate`, `--dry-run` | Print the plan and a rough token estimate; don't call the model. |
| `-y`, `--yes` | Skip confirmations. Implied when `CI` is set. |
| `--backfill-missing` | Accepted for Lingo.dev compatibility; missing files are always backfilled. |

Positional patterns (`rosetta push 'content/en/**'`) limit a run to matching source
files.

Global flags: `--config <path>`, `--json`, `--quiet`, `--help`, `--version`.

### Scripting, agents, and CI

- **`--json`** on any command prints a single JSON result to stdout — including
  failures: `{ "ok": false, "error": { "type": "ConfigError", "message": "…" } }`.
- **Exit codes** are stable:

  | Code | Meaning |
  | --- | --- |
  | `0` | Success (for `check`: everything up to date) |
  | `1` | One or more locales failed to translate and were not written |
  | `2` | Usage or config error, including a missing API key |
  | `3` | `check` / `status --exit-code` found stale or broken translations |

- **Never hangs:** outside a TTY, destructive commands (`push --force`, `purge`)
  require `--yes` instead of prompting. `CI=true` implies `--yes`.
- **API key only when needed:** `push` asks for a key only if something actually
  needs translating, so adopting or pruning works without one.

### Environment variables

| Variable | Description |
| --- | --- |
| `ROSETTA_API_KEY` | API key (or whatever `engine.apiKeyEnv` names). |
| `OPENROUTER_API_KEY` | Fallback API key. |
| `ROSETTA_MODEL` | Overrides `engine.model`. |
| `ROSETTA_BASE_URL` | Overrides `engine.baseURL`. |
| `CI` | Non-interactive mode; implies `--yes`. |

## Validation

Every translation the model returns — and every existing translation, on `push` and
`check` — is checked against its source string:

- the same `{placeholders}`, with none dropped, renamed, or added;
- the same ICU arguments and types (`plural`, `select`, `selectordinal`, `number`,
  `date`, `time`), the same `select` cases, and `plural` keeping its `other` case —
  while allowing each language's own plural categories (`zero`/`few`/`many`…);
- the same rich-text tags (`<strong>…</strong>`, `<link/>`), balanced;
- a non-empty string.

Sources that aren't ICU (e.g. i18next `{{name}}`) fall back to comparing
placeholder-looking tokens and tag names. Rosetta also asks for JSON output, strips
code fences, retries with exponential backoff (honoring `Retry-After`), and times out
hung requests.

## Getting translations into your repo

Rosetta doesn't prescribe how translations land — pick what fits your team:

- **Locally or with a coding agent:** run `rosetta push` and commit the result with
  the English change. Agents can use `rosetta status --json` and `rosetta push --json`.
- **CI gate:** run `rosetta check` on pull requests. It needs no API key, so forks
  stay green.
- **Automated:** run `rosetta push` in CI after merges and commit the output or open a
  pull request.

A check-only workflow:

```yaml
# .github/workflows/i18n-check.yml
name: i18n
on: pull_request
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx --yes rosetta-i18n@1 check
```

A GitHub Action with `pull-request`, `commit`, and `check` modes is in progress.
Note that GitHub doesn't run other workflows on commits or PRs made with the default
`GITHUB_TOKEN`; use a GitHub App token or PAT if you need CI to run on bot commits.

## Coming from Lingo.dev

Rosetta mirrors the Lingo.dev CLI's layout and vocabulary, but everything their
hosted engine does runs locally from your config.

```bash
npx rosetta init --from-lingo   # imports .lingo/config.json or legacy i18n.json
```

| Lingo.dev | Rosetta |
| --- | --- |
| `.lingo/config.json` | `.rosetta/config.json` |
| `.lingo/lock.json` / `i18n.lock` | `.rosetta/lock.json` (per-key source hashes) |
| `sourceLocale`, `targetLocales`, `files[].pattern` | same |
| `lockedKeys`, `preservedKeys`, `ignoredKeys` | same (dotted paths; legacy `a/b` paths are converted) |
| `orgId` + `engineId` (hosted engine) | `engine` in the config: model, brand voice, rules, glossary |
| `lingo push` (`--key`, `--force`, `--estimate`) | `rosetta push` (same flags) |
| `lingo pull` | not needed — `push` writes the files directly |
| `lingo check` | `rosetta check` |
| `lingo purge --locale` | `rosetta purge --locale` |
| `LINGO_API_KEY` | `ROSETTA_API_KEY` — your model provider's key |

Rosetta v1 supports JSON and JSONC; other formats are skipped on import with a
warning. Markdown/MDX support is tracked in
[#1](https://github.com/ian/rosetta/issues/1).

## Library API

The engine behind the CLI is also usable directly.

```ts
import { Rosetta } from "rosetta-i18n";

const rosetta = new Rosetta({
	apiKey: process.env.OPENROUTER_API_KEY!,
	model: "anthropic/claude-sonnet-4.5",
	brandVoice: {
		variations: {
			"*": "Confident, precise, editorial. Short sentences, active voice.",
			es: "Tono editorial de gastronomía, accesible. Tercera persona.",
		},
	},
	rules: ["Keep product names in English."],
	glossary: { es: { "award-winning": "premiado" } },
});

const translated = await rosetta.translate(
	{ hero: "Every awarded restaurant in the world", count: "{n, plural, one {# place} other {# places}}" },
	{ source: "en", target: "es", context: "home page hero" },
);

const text = await rosetta.translateText("Every awarded restaurant", {
	source: "en",
	target: "ja",
});
```

### `new Rosetta(config)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | — | **Required.** Key for the LLM endpoint. |
| `model` | `string` | — | **Required.** Model id. |
| `brandVoice` | `BrandVoice` | — | **Required.** `{ variations: { [locale or "*"]: text } }`. |
| `baseURL` | `string` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. |
| `rules` | `string[]` | — | Rules added to every prompt. |
| `glossary` | `Glossary` | — | Exact term mappings per locale; `*` terms are never translated. |
| `temperature` | `number` | `0.3` | Sampling temperature. |
| `batchSize` | `number` | `25` | Max keys per request. |
| `concurrency` | `number` | `4` | Max requests in flight for this instance. |
| `retries` | `number` | `2` | Retries per request and per failing key. |
| `timeoutMs` | `number` | `120000` | Per-request timeout. |
| `onBatchError` | `"throw" \| "skip"` | `"throw"` | What `translate()` does when keys still fail. |

### Methods

- **`translate(data, options)`**: translates a key-value payload with validation and
  targeted retries. Throws `RosettaValidationError` (with `.failures` and `.partial`)
  if any key still fails. With `onBatchError: "skip"`, it logs failures and returns
  only the keys that succeeded (the 0.x behavior). Options: `source`, `target`,
  `context`, `notes` (per-key), `hints` (per-key breadcrumbs).
- **`translateEntries(data, options)`**: like `translate` but never throws for
  per-key problems; it returns `{ translations, failures, usage }`.
- **`translateText(text, options)`**: translates one string and throws on a non-OK
  response.

### Programmatic workflow

The CLI commands are exported too:

```ts
import { check, loadConfig, push } from "rosetta-i18n";

const project = loadConfig();                       // finds .rosetta/config.json
const result = await push(project, { locales: ["es"] });
if (!result.ok) console.error(result.locales.flatMap((l) => l.errors));
console.log(check(project).ok);
```

`push` accepts a custom `translator` implementing `translateEntries`, which is
useful for tests or for routing through your own service. Also exported:
`plan`, `purge`, `validateTranslation`, `parseMessage`, `resolveTargetPath`.

## React & Next.js

Rosetta calls an LLM with your API key, so it runs **server-side only**. Never import
it in a Client Component (`"use client"`). Keep the key out of client bundles with
[`server-only`](https://www.npmjs.com/package/server-only) and expose translations
through server code.

### Recommended: pre-translate message catalogs

For `next-intl` / `react-i18next`, translate the locale JSON with `rosetta push` and
ship it, so there's no LLM call in the request path:

```ts
// i18n/request.ts (next-intl)
import { getRequestConfig } from "next-intl/server";

export default getRequestConfig(async ({ locale }) => ({
	messages: (await import(`../messages/${locale}.json`)).default,
}));
```

### Server helpers (`rosetta-i18n/next`)

For dynamic content (CMS entries, user-generated text), the `next` entrypoint
(optional `next` peer) provides env config, a memoized instance, and Next's data
cache:

```ts
// lib/rosetta.ts
import "server-only";
import { cachedTranslate, getRosetta } from "rosetta-i18n/next";

export const rosetta = getRosetta();

export async function translateCopy(data: Record<string, string>, target: string) {
	return cachedTranslate(data, { source: "en", target }, {
		revalidate: 60 * 60 * 24,
		tags: ["i18n"],
	});
}
```

| Env var | Required | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | — |
| `ROSETTA_MODEL` | no | `anthropic/claude-sonnet-4.5` |
| `ROSETTA_BASE_URL` | no | `https://openrouter.ai/api/v1` |
| `ROSETTA_BRAND_VOICE` | no | — (the `*` brand voice) |

`createRosetta(overrides)` is also exported if you'd rather pass config explicitly.

### Server Component (RSC)

```tsx
// app/[locale]/hero.tsx
import { cachedTranslate } from "rosetta-i18n/next";

export async function Hero({ locale }: { locale: string }) {
	const copy = await cachedTranslate(
		{ hero: "Every awarded restaurant in the world" },
		{ source: "en", target: locale, context: "home hero" },
	);
	return <h1>{String(copy.hero)}</h1>;
}
```

### Route Handler

```ts
// app/api/translate/route.ts
import { NextResponse } from "next/server";
import { rosetta } from "@/lib/rosetta";

export async function POST(req: Request) {
	const { data, target, context } = await req.json();
	const translated = await rosetta.translate(data, { source: "en", target, context });
	return NextResponse.json(translated);
}
```

### Server Action

```ts
// app/actions.ts
"use server";
import { rosetta } from "@/lib/rosetta";

export async function translateBlurb(blurb: string, target: string) {
	return rosetta.translateText(blurb, { source: "en", target });
}
```

### Client Components

Client Components consume already-translated strings through props, context, or the
catalog; they never import Rosetta. To trigger a translation from the browser, call
the route handler or Server Action above.

> **Edge runtime:** `rosetta-i18n/next` only uses `fetch`, so it works on the Edge
> runtime as long as your endpoint does. The main `rosetta-i18n` entry also exports the
> Node-only workflow (`push`, `check`, …, which read and write files), so prefer the
> `next` entrypoint in edge code.

## Legacy `translate-catalog`

The 0.x one-shot command still works but is deprecated and will be removed in v2:

```bash
npx rosetta translate-catalog messages/en.json --target es --merge
```

Replace it with a `.rosetta/config.json` (`rosetta init --pattern messages/en.json --target es`)
and `rosetta push`, which also retranslates edited strings, validates output, and
never writes partial files.

## Migrating an existing app

- [`docs/migration-guide.md`](docs/migration-guide.md): a playbook for switching an app
  from another translation stack (inventory → modes → verification).
- [`docs/agent-prompt.md`](docs/agent-prompt.md): a ready-to-run agent prompt that
  executes the migration.

## Releasing

Releases publish automatically from GitHub Actions via npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no npm token
is required.

```bash
pnpm bump patch   # bump package.json, commit, tag, push
pnpm release      # create the GitHub Release -> triggers npm-publish
```

- `pnpm bump` accepts `patch`, `minor`, or `major` (default `patch`).
- `pnpm release` creates the GitHub Release for the latest tag with generated release
  notes, which triggers `.github/workflows/npm-publish.yml`.

One-time setup (first publish and Trusted Publisher) is documented in
[`.github/workflows/npm-publish.yml`](.github/workflows/npm-publish.yml).

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Source lives in `src/`: the translation engine in `src/rosetta.ts`, validation in
`src/validate.ts`, the config/lockfile/planner/workflow in `src/project/`, and the CLI
in `src/cli.ts`. `rollup` produces `dist/esm`; `tsc` emits declarations to
`dist/types`.

## License

MIT © Ian Hunter
