# Trilingua

Self-hosted AI translation engine. One text, every language — translate key-value content across locales through any OpenAI-compatible LLM, with brand voice and glossary enforcement.

Named after the Rosetta Stone: one text, three scripts, every language readable.

No vendor lock-in and no per-seat translation SaaS — bring your own LLM endpoint and API key.

## Install

```bash
pnpm add trilingua
# or
npm install trilingua
```

## Quick start

```ts
import { Rosetta } from "trilingua";

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