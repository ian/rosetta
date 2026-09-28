# Rosetta website

A single static page built with [Astro](https://astro.build) and deployed to
Cloudflare Pages. The agent prompt and version are read from the repo's
`README.md` and `package.json` at build time, so the site stays in sync with the
docs.

Requires Node 22.12+.

```bash
cd site
pnpm install
pnpm dev        # http://localhost:4321
pnpm build      # static output in dist/
pnpm preview    # serve dist/ locally
```

## Deploy to Cloudflare Pages

The site is the Cloudflare Pages project **`rosetta`** (account "01"), a direct-upload
project, live at **https://rosetta-1xp.pages.dev** until `rosetta.tools` is set up.

### Automatically (GitHub Actions)

`.github/workflows/site.yml` builds and deploys:

- pushes to `main` that touch `site/`, `README.md`, or `package.json` deploy to production;
- pull requests get a preview deployment (`<branch>.rosetta-1xp.pages.dev`).

It needs two repository secrets, and skips the deploy step when they're missing:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `317663104fe4e8ac83fc201c50aec201` |
| `CLOUDFLARE_API_TOKEN` | An API token with **Account → Cloudflare Pages → Edit** (Dashboard → My Profile → API Tokens → Create Token → Custom token) |

### From your machine

```bash
cd site
npx wrangler login          # once
pnpm pages:deploy           # astro build && wrangler pages deploy (uses wrangler.jsonc)
```

Deploying from a branch other than `main` creates a preview. For production, add
`-- --branch main`.

### Custom domain

When `rosetta.tools` is registered: **Pages project `rosetta` → Custom domains → Set up a
custom domain → `rosetta.tools`**. If the domain's DNS is on Cloudflare (for example,
Cloudflare Registrar), the record is created for you. Otherwise, add the CNAME it
shows. `astro.config.mjs` already sets `site: "https://rosetta.tools"` for canonical
and Open Graph URLs.
