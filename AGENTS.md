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

This file is the source of truth for how to work here. It is kept up to date
with the `startupkit` CLI (`npx startupkit agents`). This project does not run
the StartupKit Stack, so it carries no stack-specific section.

## How we work

- **Default to action.** Fix before reporting. Escalate only for strategy
  pivots, legal, or large spend.
- **Ship in small, reviewable increments.** Completing a task without an open
  pull request is an incomplete task.
- **Decide with options.** Bring options + a recommendation + the tradeoff. If
  there's no response in 30 minutes, go with your recommendation.
- **Automate aggressively** — twice script it, three times workflow it.
- **Link with full URLs.** Reference pull requests as
  `https://github.com/ian/rosetta/pull/123`, never a bare `#123`.

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

## Development workflow (git worktrees)

Keep the root checkout on a clean, up-to-date `main` — it represents production
and is used for live verification only. Do all task work in a worktree so the
root always stays deployable.

- **One task → one ticket → one branch → one worktree**, created from
  `origin/main`.
- Finish the active worktree (verify, commit, push, open a PR) before starting
  another. Don't run two unfinished tasks in the same tree.
- Don't leave actionable work uncommitted, unpushed, or outside a pull request.
- If the project tracks work in Linear (or another issue tracker), link every
  pull request to the ticket it closes — put the ticket ID in the PR title/body
  and attach the PR URL on the ticket. Never close a ticket with an unlinked PR.
- When a PR is merged or closed, remove its worktree and local branch, then
  fast-forward root `main`.
- Never `git stash pop` across differently-based worktrees — the stash carries
  the whole original-branch diff and leaks stale changes into your branch.
- Rebase onto `origin/main` before opening or updating a PR; never merge `main`
  into the feature branch.

```bash
git fetch origin main
git worktree add .worktrees/<short-desc> -b <type>/<short-desc> origin/main

# work inside .worktrees/<short-desc>
pnpm install                       # worktrees do NOT share node_modules
pnpm lint && pnpm typecheck && pnpm test
git commit -am "<type>: <short description>"
git push -u origin <type>/<short-desc>
gh pr create --fill

# after the PR merges or closes
git worktree remove .worktrees/<short-desc>
git branch -d <type>/<short-desc>
git checkout main && git merge --ff-only origin/main
```

`.worktrees/` is gitignored. Worktrees do **not** share `node_modules` — run
`pnpm install` in a fresh worktree before dev, build, lint, or tests, or the
first command fails on missing dependencies.

## Linear

- **Own the backlog**: create, triage, update, close. Urgent items get a ticket
  AND immediate work.
- **Keep statuses current** as you work — In Progress when you start, In Review
  when a PR is open, Done when merged. Never let tickets drift from reality.
- **Link the ticket to the code**: put the ticket ID in the branch name, commit
  messages, and PR title/body (`type(scope): summary (STARTUP-123)`), and attach
  the PR URL on the issue. A ticket is never closed by an unlinked PR.

## SDLC (software development lifecycle)

1. **Plan** — a ticket with the problem, scope, and acceptance criteria.
2. **Build** — branch + worktree, small commits, no unrelated changes.
3. **Verify** — lint, typecheck, tests, and a manual check of the change.
4. **Review** — open a PR, link the ticket, pass CI.
5. **Ship** — merge to `main`, then deploy from a clean, merged `main`.
6. **Operate** — watch errors, analytics, and revenue; fix regressions first.

## ADLC (agent development lifecycle)

The agent owns the loop end to end: **triage → ticket → research → implement →
verify → PR → merge → deploy → observe → close the ticket.** Nothing stops at
"reported" — a task ends merged and verified.

- **Compound context.** Keep this guide and project skills current, and write
  down decisions as you make them.
- **Verify before claiming done.** Run the checks; don't assume they pass.
- **Escalate only** for strategy pivots, legal, or large spend.

## Boundaries

- No irreversible financial decisions without checking (ad spend, hiring, legal).
- No deleting production databases or infrastructure without explicit
  confirmation.
- Never commit secrets.
- Never run publish/release commands directly — releases go through review and
  merge.

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
