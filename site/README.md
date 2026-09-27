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

### Option A: connect the GitHub repo (recommended)

In the Cloudflare dashboard, go to **Workers & Pages → Create → Pages → Connect to
Git**, pick `ian/rosetta`, and use these build settings:

| Setting | Value |
| --- | --- |
| Framework preset | Astro |
| Root directory | `site` |
| Build command | `pnpm install && pnpm build` |
| Build output directory | `dist` |
| Environment variable | `NODE_VERSION` = `22` |

Every push to `main` deploys production, and every PR gets a preview URL.

Then add the custom domain: **Pages project → Custom domains → Set up a custom domain →
`rosetta.tools`**. If the domain's DNS is on Cloudflare (for example, bought through
Cloudflare Registrar), the record is created for you. Otherwise, add the CNAME it
shows at your DNS provider. `astro.config.mjs` sets `site: "https://rosetta.tools"`
for canonical and Open Graph URLs.

The build reads `../README.md` and `../package.json`. Cloudflare checks out the
whole repo, so those resolve even with `site` as the root directory.

### Option B: deploy from your machine

```bash
cd site
npx wrangler login          # once
pnpm pages:deploy           # astro build && wrangler pages deploy
```

`wrangler.jsonc` sets the project name (`rosetta`) and the output directory. The
first deploy creates the Pages project.
