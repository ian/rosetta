import esbuild from "rollup-plugin-esbuild";

const esbuildPlugin = esbuild({
	include: /\.[jt]s?$/,
	exclude: /node_modules/,
	sourceMap: true,
	minify: process.env.NODE_ENV === "production",
	target: "esnext",
	tsconfig: "tsconfig.json",
});

const isNodeBuiltin = (id) => id.startsWith("node:");

export default [
	{
		input: ["src/index.ts", "src/config.ts"],
		output: {
			dir: "dist/esm",
			format: "esm",
			sourcemap: true,
		},
		external: isNodeBuiltin,
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
		external: isNodeBuiltin,
		plugins: [esbuildPlugin],
	},
	{
		input: "src/next.ts",
		output: {
			file: "dist/esm/next.js",
			format: "esm",
			sourcemap: true,
		},
		external: (id) => id === "next/cache" || isNodeBuiltin(id),
		plugins: [esbuildPlugin],
	},
];
