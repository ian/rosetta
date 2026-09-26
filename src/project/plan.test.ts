import { describe, expect, it } from "vitest";
import { hashSource } from "./entries";
import { nextLockEntries, notesFor, planLocale } from "./plan";

const src = (entries: Record<string, string | number>) =>
	new Map(Object.entries(entries));
const lockOf = (entries: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(entries).map(([k, v]) => [k, hashSource(v)]),
	);

const actions = (plan: ReturnType<typeof planLocale>) =>
	Object.fromEntries(
		plan.items.map((item) => [item.key, `${item.action}:${item.reason}`]),
	);

describe("planLocale", () => {
	it("translates everything for a new locale (no target file)", () => {
		const plan = planLocale({
			source: src({ a: "Hello", b: "World" }),
			target: undefined,
			lock: undefined,
		});
		expect(actions(plan)).toEqual({
			a: "translate:missing",
			b: "translate:missing",
		});
		expect(plan.removed).toEqual([]);
	});

	it("keeps unchanged keys and retranslates edited source strings", () => {
		const plan = planLocale({
			source: src({ a: "Hello", b: "World, again" }),
			target: src({ a: "Hola", b: "Mundo" }),
			lock: lockOf({ a: "Hello", b: "World" }),
		});
		expect(actions(plan)).toEqual({
			a: "keep:unchanged",
			b: "translate:changed",
		});
	});

	it("adopts existing translations without lock entries", () => {
		const plan = planLocale({
			source: src({ a: "Hello" }),
			target: src({ a: "Hola" }),
			lock: undefined,
		});
		expect(actions(plan)).toEqual({ a: "adopt:untracked" });
	});

	it("keeps hand edits while the source is unchanged", () => {
		const plan = planLocale({
			source: src({ a: "Hello" }),
			target: src({ a: "¡Hola, hand-edited!" }),
			lock: lockOf({ a: "Hello" }),
		});
		expect(actions(plan)).toEqual({ a: "keep:unchanged" });
	});

	it("retranslates missing, empty, and invalid targets", () => {
		const plan = planLocale({
			source: src({ a: "Hi", b: "Yo", c: "Hi {name}" }),
			target: src({ b: "  ", c: "Hola" }),
			lock: lockOf({ a: "Hi", b: "Yo", c: "Hi {name}" }),
		});
		expect(actions(plan)).toEqual({
			a: "translate:missing",
			b: "translate:missing",
			c: "translate:invalid",
		});
		expect(plan.items[2].issues?.[0].rule).toBe("placeholder");
	});

	it("applies key controls with ignored > locked > preserved precedence", () => {
		const plan = planLocale({
			source: src({
				"meta.version": "v2 beta",
				"legal.terms": "Terms",
				"debug.x": "Debug",
				both: "Both",
			}),
			target: src({
				"meta.version": "old",
				"legal.terms": "Términos (reviewed)",
				"debug.x": "Depurar",
			}),
			lock: lockOf({ "legal.terms": "Old terms" }),
			controls: {
				lockedKeys: ["meta.version", "both"],
				preservedKeys: ["legal"],
				ignoredKeys: ["debug", "both"],
			},
		});
		expect(actions(plan)).toEqual({
			"meta.version": "copy:locked",
			"legal.terms": "keep:preserved",
			"debug.x": "omit:ignored",
			both: "omit:ignored",
		});
		expect(plan.removed).toEqual(["debug.x"]);
	});

	it("copies non-strings and non-translatable strings", () => {
		const plan = planLocale({
			source: src({ n: 3, url: "https://jot.so", a: "Save" }),
			target: src({ a: "Guardar" }),
			lock: lockOf({ a: "Save" }),
		});
		expect(actions(plan)).toEqual({
			n: "copy:non-string",
			url: "copy:untranslatable",
			a: "keep:unchanged",
		});
	});

	it("honors --key and --force scopes but never translates locked keys", () => {
		const base = {
			source: src({
				"auth.login": "Log in",
				"auth.logout": "Log out",
				other: "Other",
				v: "v1 beta",
			}),
			target: src({
				"auth.login": "Entrar",
				"auth.logout": "Salir",
				other: "Otro",
				v: "v1 beta",
			}),
			lock: lockOf({
				"auth.login": "Log in",
				"auth.logout": "Log out",
				other: "Other",
				v: "v1 beta",
			}),
			controls: { lockedKeys: ["v"] },
		};
		expect(
			actions(planLocale({ ...base, scope: { keys: ["auth.login"] } })),
		).toMatchObject({
			"auth.login": "translate:forced",
			"auth.logout": "keep:unchanged",
		});
		expect(actions(planLocale({ ...base, scope: { force: true } }))).toEqual({
			"auth.login": "translate:forced",
			"auth.logout": "translate:forced",
			other: "translate:forced",
			v: "copy:locked",
		});
	});

	it("reports keys removed from the source", () => {
		const plan = planLocale({
			source: src({ a: "A" }),
			target: src({ a: "A!", gone: "Gone" }),
			lock: lockOf({ a: "A", gone: "Gone" }),
		});
		expect(plan.removed).toEqual(["gone"]);
	});
});

describe("nextLockEntries", () => {
	it("hashes every non-omitted string source", () => {
		const plan = planLocale({
			source: src({ a: "A", n: 1, skip: "S" }),
			target: undefined,
			lock: undefined,
			controls: { ignoredKeys: ["skip"] },
		});
		expect(nextLockEntries(plan.items)).toEqual({ a: hashSource("A") });
	});
});

describe("notesFor", () => {
	it("combines own and ancestor notes", () => {
		expect(
			notesFor(["nav.save", "nav.open", "x"], {
				nav: "Top nav",
				"nav.save": "Button",
			}),
		).toEqual({ "nav.save": "Button / Top nav", "nav.open": "Top nav" });
	});
});
