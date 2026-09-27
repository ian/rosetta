import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_FIELDS, FILE_FIELDS, LINGO_ONLY, TOP_LEVEL } from "./config";

const schema = JSON.parse(
	readFileSync(join(__dirname, "../../schema/config.json"), "utf8"),
);
const keys = (o: object) => Object.keys(o).sort();

describe("schema/config.json", () => {
	it("stays in sync with the config validator", () => {
		expect(keys(schema.properties)).toEqual(
			[...TOP_LEVEL, ...LINGO_ONLY].sort(),
		);
		expect(keys(schema.definitions.file.properties)).toEqual(
			[...FILE_FIELDS].sort(),
		);
		expect(keys(schema.definitions.engine.properties)).toEqual(
			[...ENGINE_FIELDS].sort(),
		);
	});

	it("is referenced by generated configs", async () => {
		const { buildConfig } = await import("./init");
		const config = buildConfig({
			sourceLocale: "en",
			targetLocales: ["es"],
			files: [{ pattern: "messages/en.json" }],
		});
		expect(config.$schema).toBe(schema.$id);
	});
});
