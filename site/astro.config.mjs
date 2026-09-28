import { defineConfig } from "astro/config";

// Static output: `astro build` writes plain HTML/CSS/JS to dist/, which
// Cloudflare Pages serves as-is (no adapter needed).
export default defineConfig({
	site: "https://rosetta.tools",
	output: "static",
});
