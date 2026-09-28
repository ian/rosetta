import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			// The Next entry imports the client provider by package name so the
			// "use client" boundary survives bundling. In tests (which run before
			// `dist` is built) resolve that to the source.
			"rosetta-i18n/react": fileURLToPath(
				new URL("./src/react.tsx", import.meta.url),
			),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
	},
});
