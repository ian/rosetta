# Agent Guide

This repo is **Rosetta** (npm: `rosetta-i18n`): a free, open-source, self-run
localization CLI — a DIY Lingo.dev. It translates source-language JSON/JSONC
locale files into every target locale with an LLM, applying brand voice,
rules, and a glossary, and validating placeholders/ICU/`<tag>` before writing.
All state lives in the consuming repo (`.rosetta/config.json`,
`.rosetta/lock.json`); Rosetta has no service, account, or API key of its own.

The published package is `rosetta-i18n` and installs a `rosetta` binary. Source
is TypeScript, bundled with rollup + esbuild, declarations emitted by `tsc`.
The marketing site lives in `site/` (Astro, deployed to Cloudflare Pages).

This file is the source of truth for how to work here.

## Commands

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Typecheck | `pnpm typecheck` |
| Lint / format-check (biome) | `pnpm lint` |
| Lint / format autofix | `pnpm lint:fix` |
| Tests (vitest, run once) | `pnpm test` |
| Tests (watch) | `pnpm test:watch` |
| Build (`dist/esm` + `dist/types`) | `pnpm build` |
| Bump version + tag + push | `pnpm bump <patch\|minor\|major\|x.y.z>` |
| Create GitHub Release (triggers npm publish) | `pnpm release` |
| Site dev / build | `pnpm --dir site dev` / `pnpm --dir site build` |

Package manager is **pnpm** (`pnpm@9.7.1`). Node 20+ (CI runs 20, 22, 24).

Before opening a change, run `pnpm lint && pnpm typecheck && pnpm test`, and
`pnpm build` if you touched anything that affects the published output.

## Where things live

- `src/rosetta.ts` — the translation engine.
- `src/validate.ts` — placeholder, ICU, and tag validation.
- `src/project/` — config, lockfile, planner, and push workflow (`config.ts`,
  `lock.ts`, `plan.ts`, `workflow.ts`, `init.ts`, `paths.ts`, `glob.ts`,
  `jsonc.ts`, `entries.ts`).
- `src/cli.ts` — the `rosetta` command (`init`, `status`, `push`, `check`, …).
- `src/next.ts`, `src/config.ts`, `src/legacy.ts` — Next.js helper, config
  loader, and the deprecated 0.x path.
- `schema/config.json` — published JSON schema for `.rosetta/config.json`.
- `skills/rosetta/SKILL.md` — the agent skill shipped in the npm package.
- `action.yml`, `action/` — the GitHub Action (`pull-request`, `commit`, `check`).
- `docs/` — `spec-v1.md` (behavior spec), `delivery.md` (landing workflows),
  `agent-prompt.md` (the setup prompt users paste), migration guides.
- `examples/next-intl/` — an end-to-end example app.
- `site/` — Astro marketing site (independent pnpm project).
- `.github/workflows/` — `ci.yml` (lint/typecheck/test/build + CLI smoke test on
  three Node versions, plus a site build), `npm-publish.yml` (OIDC trusted
  publishing), `site.yml`.

## Conventions

- **Tests are colocated** as `*.test.ts` next to the code; run with vitest.
- **Biome** owns formatting and linting: tabs, 2-wide, 80 cols, double quotes,
  semicolons, trailing commas, `noExplicitAny` is an error. `dist/`,
  `node_modules/`, `examples/`, and `site/` are excluded from biome — do not
  reformat them.
- `dist/` is build output and gitignored. Never hand-edit it; it is regenerated
  by `pnpm build`.
- Keep the CLI's **exit codes stable** — `0` ok, `1` some locales failed, `2`
  usage/config error, `3` stale (for `check`). Agents and CI depend on them.
- When you change behavior, update the spec (`docs/spec-v1.md`) and the user-facing
  docs (`README.md`, `skills/rosetta/SKILL.md`, `docs/`) in the same change.
- Never print, commit, or search for API keys. `rosetta check` must stay
  key-free.

## Releasing

Releases publish from GitHub Actions via npm trusted publishing (OIDC); no npm
token is needed. `pnpm bump` bumps `package.json`, commits, tags, and pushes;
`pnpm release` creates the GitHub Release, which triggers `npm-publish.yml`.
Prereleases publish under the npm `next` dist-tag and don't move `latest`.

## Notes

- The npm name is `rosetta-i18n`. A bare `npx rosetta` fetches an unrelated
  package — always use the locally installed command or `npx rosetta-i18n`.
- For working **on a consuming project** rather than this repo, use the skill at
  `skills/rosetta/SKILL.md` (or `docs/agent-prompt.md` for the full migration
  prompt).