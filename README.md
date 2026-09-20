# Rosetta i18n

Self-hosted AI translation engine. One text, every language — translate key-value content across locales through any OpenAI-compatible LLM, with brand voice and glossary enforcement.

Named after the Rosetta Stone: one text, three scripts, every language readable.

No vendor lock-in and no per-seat translation SaaS — bring your own LLM endpoint and API key.

## Install

```bash
pnpm add rosetta-i18n
# or
npm install rosetta-i18n
```

## Quick start

```ts
import { Rosetta } from "rosetta-i18n";

const rosetta = new Rosetta({
	apiKey: process.env.OPENROUTER_API_KEY,
	model: "anthropic/claude-sonnet-4.5",
	brandVoice: {
		variations: {
			"*": "Confident, precise, editorial. Short sentences, active voice.",
			es: "Tono editorial de gastronomía, accesible. Tercera persona.",
		},
	},
	glossary: {
		es: { "award-winning": "premiado" },
	},
});

const translated = await rosetta.translate(
	{ hero: "Every awarded restaurant in the world" },
	{ source: "en", target: "es" },
);
```

### Single strings

```ts
const text = await rosetta.translateText("Every awarded restaurant", {
	source: "en",
	target: "ja",
});
```

## How it works

Every request is sent to an OpenAI-compatible `/chat/completions` endpoint
(OpenRouter by default). The system prompt layers three signals, in this
precedence:

1. **Glossary** — exact term match, overrides model judgment
2. **Rules** — locale-specific conventions embedded in the brand voice
3. **Brand voice** — sets overall tone per locale

The user prompt carries the payload plus optional broad context and per-key
disambiguation hints.

## API

### `new Rosetta(config)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | — | **Required.** Key for the LLM endpoint. |
| `model` | `string` | — | **Required.** Model id, e.g. `anthropic/claude-sonnet-4.5`. |
| `brandVoice` | `BrandVoice` | — | **Required.** Tone + conventions per locale. `*` is the fallback. |
| `baseURL` | `string` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. |
| `glossary` | `Glossary` | `{}` | Exact term mappings per locale. |
| `temperature` | `number` | `0.3` | Sampling temperature. |
| `batchSize` | `number` | `25` | Keys per LLM request. |
| `concurrency` | `number` | `4` | Parallel batch requests in flight. |
| `retries` | `number` | `2` | Retries per batch on failure. |

### `rosetta.translate(data, options)`

Translates a key-value payload. Keys are preserved; only values are translated.
Batches run concurrently and failed batches are logged and skipped, so the
result carries only successfully translated keys — the caller can fall back to
the source locale for the rest.

```ts
const out = await rosetta.translate(
	{ hero: "…", subhead: "…" },
	{
		source: "en",
		target: "pt-BR",
		context: "restaurant listing page",
		hints: { hero: ["home", "top banner"] },
	},
);
```

### `rosetta.translateText(text, options)`

Translates a single string. Throws on a non-OK response (unlike `translate`,
which degrades gracefully at the batch level).

## CLI

Translate a JSON catalog from the command line — run it in CI or as a release
step. It reads a source catalog, translates it, and writes one file per target
locale.

```bash
OPENROUTER_API_KEY=sk-... npx rosetta-i18n translate-catalog messages/en.json \
  --target es --target pt-BR \
  --merge \
  --context "Next.js UI catalog"
```

Writes `messages/es.json` and `messages/pt-BR.json` (flattened keys preserved).

| Flag | Description |
| --- | --- |
| `--target <locale>` | Target locale (repeatable, required) |
| `--source <locale>` | Source locale (default `en`) |
| `--out <dir>` | Output directory (default: the input file's directory) |
| `--merge` | Only translate keys missing from an existing `<target>.json` |
| `--context <text>` | Broad context passed to the model |
| `--brand-voice <text>` | Brand voice briefing (default `ROSETTA_BRAND_VOICE`) |
| `--glossary <file>` | JSON file of per-locale exact term mappings |
| `--model <id>` / `--base-url <url>` | Override the endpoint/model |
| `--concurrency` / `--batch-size` / `--retries` | Tune batching |
| `--dry-run` | Print the plan without calling the model |

`--merge` is the CI-friendly mode: add keys to `en.json`, rerun, and only the new
keys hit the model — existing translations are preserved for diffing and review.

## React & Next.js

Rosetta calls an LLM with your API key, so it runs **server-side only**. Never
import it in a Client Component (`"use client"`) — bundle the key out with
[`server-only`](https://www.npmjs.com/package/server-only) and expose
translations through server code.

### Server helpers (`rosetta-i18n/next`)

The `next` entrypoint (optional `next` peer) wires env config, a memoized
instance, and Next's data cache:

```ts
// lib/rosetta.ts
import "server-only";
import { cachedTranslate, getRosetta } from "rosetta-i18n/next";

// Memoized instance built from env (see table below).
export const rosetta = getRosetta();

// Cached translation — keyed on source/target/payload.
export async function translateCopy(
  data: Record<string, string>,
  target: string,
) {
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

`createRosetta(overrides)` is also exported if you'd rather pass config
explicitly.

### Recommended: pre-translate message catalogs with the CLI

For `next-intl` / `react-i18next`, translate the locale JSON once and ship it —
no LLM call in the request path. Use the [CLI](#cli) above, then load the files:

```ts
// i18n/request.ts (next-intl)
import { getRequestConfig } from "next-intl/server";

export default getRequestConfig(async ({ locale }) => ({
	messages: (await import(`../messages/${locale}.json`)).default,
}));
```

### Server Component (RSC)

```tsx
// app/[locale]/hero.tsx
import { getRosetta } from "rosetta-i18n/next";

export async function Hero({ locale }: { locale: string }) {
	const copy = await getRosetta().translate(
		{ hero: "Every awarded restaurant in the world" },
		{ source: "en", target: locale, context: "home hero" },
	);
	return <h1>{String(copy.hero)}</h1>;
}
```

Prefer `cachedTranslate` from `rosetta-i18n/next` (above) or React's `cache` so
repeated renders reuse the result instead of re-calling the model.


### Route Handler

```ts
// app/api/translate/route.ts
import { NextResponse } from "next/server";
import { rosetta } from "@/lib/rosetta";

export async function POST(req: Request) {
	const { data, target, context } = await req.json();
	const translated = await rosetta.translate(data, {
		source: "en",
		target,
		context,
	});
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

Client Components consume already-translated strings via props, context, or the
catalog — they never import Rosetta. To trigger a translation from the browser,
call the route handler or Server Action above.

> **Edge runtime:** Rosetta only uses `fetch`, so it works on the Edge runtime as
> long as your endpoint does. Node runtime is recommended for large catalogs.

## Releasing

Releases publish automatically from GitHub Actions via npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no npm
token required.

```bash
pnpm bump patch   # bump package.json, commit, tag, push
pnpm release      # create the GitHub Release -> triggers npm-publish
```

- `pnpm bump` accepts `patch`, `minor`, or `major` (default `patch`).
- `pnpm release` creates the GitHub Release for the latest tag with generated
  release notes, which triggers `.github/workflows/npm-publish.yml`.

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

Source lives in `src/`. `rollup` produces `dist/esm`, `tsc` emits declarations
to `dist/types`.

## License

MIT © Ian Hunter