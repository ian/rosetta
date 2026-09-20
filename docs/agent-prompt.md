# Agent prompt — migrate an app to rosetta-i18n

Copy everything below the line into your agent. Fill in the `<placeholders>`.
This prompt is self-contained but assumes the agent can read
[`migration-guide.md`](./migration-guide.md) from the `rosetta-i18n` repo (or the
package README) for the full spec.

---

You are a senior engineer migrating **`<APP_REPO>`** from `<CURRENT_TRANSLATION_STACK>`
to **`rosetta-i18n`**. Work deliberately: diagnose before changing code, make the
smallest correct change, verify it, and ship one focused pull request. Do not
stop at a local diff.

## Read first

- The spec: `docs/migration-guide.md` in `ian/rosetta` (or
  https://github.com/ian/rosetta/blob/main/docs/migration-guide.md).
- The package: https://www.npmjs.com/package/rosetta-i18n — entrypoints
  `rosetta-i18n` (engine), `rosetta-i18n/next` (server helpers), and the
  `rosetta-i18n` CLI (`translate-catalog`).
- A reference implementation: `bestrestaurantsguide/brg` PR #943 and
  `apps/api/src/lib/translation.ts`.

## Phase 0 — Discovery (no edits)

Answer these with file paths and line numbers. Do not guess.

1. What i18n runtime is used, and where is its config? (`next-intl`,
   `react-i18next`, `FormatJS`, custom.) Find the loader (e.g.
   `i18n/request.ts`), provider, and message files.
2. What is the current translation engine? Find the vendor/in-repo code that
   produces translated strings. Grep for names like
   `translate`, `lingo`, `i18n`, `locale`, `crowdin`, `lokalise`, `phrase`.
3. Classify every translated surface:
   - static UI strings → **Mode A (catalogs)**
   - database/CMS content → **Mode B (server content)**
   - per-request dynamic copy / RSC → **Mode C (on-demand)**
4. Where do translations live? JSON files, a DB table, a KV store, a vendor?
   Show the storage shape.
5. Source locale and full target-locale list. Where is that list defined, and is
   it mirrored anywhere (SEO config, sitemaps, switcher)?
6. When does translation run today — build, request, or mutation? Is it
   blocking? How do failures behave?
7. Is `OPENROUTER_API_KEY` available in the deploy environment? If not, flag it;
   the migration must no-op gracefully without it.

Produce a short report: a table of surfaces → chosen mode, the storage
location, and the locale list.

## Phase 1 — Plan

State the plan before editing:

- Modes chosen per surface, and why.
- Files to add/change/delete.
- How source-locale fallback works.
- What runs at build vs. request vs. mutation.
- The verification you will run.

If a decision is genuinely ambiguous (e.g. the locale list is inconsistent),
pick the safest option, state the tradeoff in one line, and proceed.

## Phase 2 — Implement

**Install and configure** (server-side only):

```bash
pnpm add rosetta-i18n
pnpm add server-only   # if any importer must never reach the client bundle
```

Add `OPENROUTER_API_KEY` (and optionally `ROSETTA_MODEL`, `ROSETTA_BASE_URL`,
`ROSETTA_BRAND_VOICE`) to the server env. Never expose them to the client.

Create a single server-only instance:

```ts
// lib/rosetta.ts
import "server-only";
import { getRosetta } from "rosetta-i18n/next";
export const rosetta = getRosetta();
```

If the app is not Next.js, construct `new Rosetta({ ... })` from
`rosetta-i18n` directly.

**Mode A — catalogs.** Add an `i18n:translate` script using the CLI with
`--merge` and the app's real target list and context. Generate the locale files,
commit them, and wire the existing runtime loader to read them. Do not call the
model at request time.

**Mode B — server content.** Add storage keyed by `(entityId, field, locale)`.
Write a non-throwing `translateAndStore` wrapper (English/source is the source of
truth; only successfully translated keys are persisted). Queue it off the request
path on mutations. Fall back to the source locale at read time. Add a backfill
script ordered by traffic. Re-translate on edit via the existing change/webhook
path.

**Mode C — on-demand.** Use `cachedTranslate` from `rosetta-i18n/next` with a
sensible `revalidate` and cache tags. Prefer Mode A when strings are known ahead
of time.

**Brand voice & glossary.** Author a per-locale brand voice with a `*` fallback,
list proper nouns that must not be translated, and add glossary entries for
recurring terms. Keep them in the repo.

## Phase 3 — Verify (all must pass)

- `pnpm install` (keep the lockfile in sync — a stale lockfile breaks
  `--frozen-lockfile` CI).
- `pnpm typecheck` and `pnpm lint`.
- `pnpm test` (or the repo's test command), including any new tests.
- Add a unit test for the wrapper with a mocked `fetch` (batching, retries,
  partial failure).
- Prefer an e2e check that needs no API key: run the CLI against a local
  OpenAI-compatible mock and assert the output files, and that `--merge` only
  sends new keys.
- Confirm the client bundle has no API key and no `rosetta-i18n` import.
- Run the app's build.

## Phase 4 — Deliver

- One branch, one focused PR. Do not mix in unrelated changes.
- Rebase on the default branch; do not merge the default branch into the feature
  branch.
- PR body: inventory → chosen modes → files changed → verification output →
  rollback note (env-gated, so disabling the key reverts behavior).
- Remove the old engine and prune now-unused dependencies in the same PR, only
  after the new path is verified.

## Guardrails

- Server-only: the API key and `rosetta-i18n` must never ship to the client.
- Translation must never block or break a user mutation or a page render.
- Always fall back to the source locale for missing translations.
- Do not commit secrets, `.env*`, or vendor dashboards' exports as source of
  truth.
- Do not rewrite unrelated i18n config or "improve" copy beyond the migration.
- If the app has no place to store translations and no build-time catalog, stop
  and report the gap instead of inventing infrastructure.

## Definition of done

- [ ] Discovery report with file paths.
- [ ] Mode(s) implemented per surface.
- [ ] Single server-only instance, env-driven.
- [ ] Source-locale fallback verified.
- [ ] Unit + e2e tests added and passing.
- [ ] typecheck / lint / build green.
- [ ] Client bundle free of the key and of `rosetta-i18n`.
- [ ] Old engine removed, deps pruned.
- [ ] Focused PR opened with the inventory and verification in the description.
