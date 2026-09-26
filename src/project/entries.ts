import { createHash } from "node:crypto";

export type Leaf = string | number | boolean | null;

const isContainer = (
	value: unknown,
): value is Record<string, unknown> | unknown[] =>
	typeof value === "object" && value !== null;

/**
 * Flatten a JSON value to dotted leaf paths, in document order. Arrays use
 * numeric segments. Empty objects/arrays produce no leaves (they're kept
 * when rebuilding from the source template).
 */
export function flatten(value: unknown): Map<string, Leaf> {
	const out = new Map<string, Leaf>();
	const walk = (node: unknown, path: string) => {
		if (Array.isArray(node)) {
			node.forEach((child, i) => {
				walk(child, path ? `${path}.${i}` : String(i));
			});
		} else if (isContainer(node)) {
			for (const [key, child] of Object.entries(node)) {
				walk(child, path ? `${path}.${key}` : key);
			}
		} else if (path) {
			out.set(path, node as Leaf);
		}
	};
	walk(value, "");
	return out;
}

/**
 * Rebuild a document with the source's structure and key order. `resolve`
 * returns the value for each leaf path, or `undefined` to omit it.
 */
export function rebuild(
	template: unknown,
	resolve: (key: string, sourceValue: Leaf) => unknown,
): unknown {
	const walk = (node: unknown, path: string): unknown => {
		if (Array.isArray(node)) {
			const out: unknown[] = [];
			node.forEach((child, i) => {
				const value = walk(child, path ? `${path}.${i}` : String(i));
				if (value !== undefined) out.push(value);
			});
			return out;
		}
		if (isContainer(node)) {
			const out: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(node)) {
				const value = walk(child, path ? `${path}.${key}` : key);
				if (value !== undefined) out[key] = value;
			}
			return out;
		}
		return resolve(path, node as Leaf);
	};
	return walk(template, "");
}

/** Serialize the way Rosetta writes every file: 2-space JSON + newline. */
export function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

/** Lockfile fingerprint of a source string. */
export function hashSource(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|mailto:\S+|tel:\S+|www\.\S+)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC = /^[-+]?[\d.,\s%]+$/;
const ONLY_PLACEHOLDERS = /^(?:\s*\{[^{}]*\}\s*)+$/;

/**
 * Whether a source string needs a model at all. Empty strings, URLs, email
 * addresses, UUIDs, ISO dates, numbers, bare placeholders, and strings
 * without letters are copied verbatim instead.
 */
export function isTranslatable(value: string): boolean {
	const text = value.trim();
	if (!text) return false;
	if (!/\p{L}/u.test(text)) return false;
	return !(
		URL_LIKE.test(text) ||
		EMAIL.test(text) ||
		UUID.test(text) ||
		ISO_DATE.test(text) ||
		NUMERIC.test(text) ||
		ONLY_PLACEHOLDERS.test(text)
	);
}
