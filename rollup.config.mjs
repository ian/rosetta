import esbuild from "rollup-plugin-esbuild";

const esbuildPlugin = esbuild({
	include: /\.[jt]sx?$/,
	exclude: /node_modules/,
	sourceMap: true,
	minify: process.env.NODE_ENV === "production",
	target: "esnext",
	tsconfig: "tsconfig.json",
	jsx: "automatic",
});

const isNodeBuiltin = (id) => id.startsWith("node:");

// Framework packages are peer dependencies, and the runtime entries import each
// other by package name (so client boundaries survive) — never bundle them.
const external = (id) =>
	isNodeBuiltin(id) ||
	id === "next" ||
	id.startsWith("next/") ||
	id === "react" ||
	id.startsWith("react/") ||
	id === "rosetta-i18n" ||
	id.startsWith("rosetta-i18n/");

export default [
	{
		input: ["src/index.ts", "src/config.ts"],
		output: {
			dir: "dist/esm",
			format: "esm",
			sourcemap: true,
		},
		external,
		plugins: [esbuildPlugin],
	},
	{
		input: "src/cli.ts",
		output: {
			file: "dist/esm/cli.js",
			format: "esm",
			sourcemap: true,
			banner: "#!/usr/bin/env node",
		},
		external,
		plugins: [esbuildPlugin],
	},
	{
		input: "src/next.ts",
		output: {
			file: "dist/esm/next.js",
			format: "esm",
			sourcemap: true,
		},
		external,
		plugins: [esbuildPlugin],
	},
	{
		input: "src/react.tsx",
		output: {
			file: "dist/esm/react.js",
			format: "esm",
			sourcemap: true,
			// Client component boundary — must be the first line of the file.
			banner: '"use client";',
		},
		external,
		plugins: [esbuildPlugin],
	},
	{
		input: "src/locale/core.ts",
		output: {
			file: "dist/esm/locale.js",
			format: "esm",
			sourcemap: true,
		},
		external,
		plugins: [esbuildPlugin],
	},
	{
		input: "src/locale/astro.ts",
		output: {
			file: "dist/esm/astro.js",
			format: "esm",
			sourcemap: true,
		},
		external,
		plugins: [esbuildPlugin],
	},
];
