import esbuild from "rollup-plugin-esbuild";

export default {
	input: "src/index.ts",
	output: {
		dir: "dist/esm",
		format: "esm",
		sourcemap: true,
	},
	plugins: [
		esbuild({
			include: /\.[jt]s?$/,
			exclude: /node_modules/,
			sourceMap: true,
			minify: process.env.NODE_ENV === "production",
			target: "esnext",
			tsconfig: "tsconfig.json",
		}),
	],
};
