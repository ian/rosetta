import type { TranslationIssue } from "./types";

/**
 * Structural signature of a message: the arguments, ICU cases, and rich-text
 * tags a translation must keep. Produced by a small ICU MessageFormat parser
 * that understands `{arg}`, `{arg, type, style}`, `plural`/`select`/
 * `selectordinal` with nested messages, `#`, apostrophe quoting, and
 * next-intl style `<tag>…</tag>` / `<tag/>` rich text.
 */
export interface MessageSignature {
	/** Argument name → type (`"simple"` for a bare `{name}`). */
	args: Map<string, string>;
	/** `select` argument name → case keys. */
	selectKeys: Map<string, Set<string>>;
	/** `plural`/`selectordinal` argument name → case keys. */
	pluralKeys: Map<string, Set<string>>;
	/** Tag name → number of occurrences. */
	tags: Map<string, number>;
}

export class MessageSyntaxError extends Error {}

const TAG_NAME = /[A-Za-z][\w-]*/y;
const ARG_NAME = /[^\s,{}#<>'"]+/y;
const WORD = /[A-Za-z][\w]*/y;

class Parser {
	pos = 0;
	sig: MessageSignature = {
		args: new Map(),
		selectKeys: new Map(),
		pluralKeys: new Map(),
		tags: new Map(),
	};

	constructor(private text: string) {}

	parse(): MessageSignature {
		this.message(false, []);
		if (this.pos < this.text.length) {
			throw new MessageSyntaxError(
				`unexpected "${this.text[this.pos]}" at ${this.pos}`,
			);
		}
		return this.sig;
	}

	/** Parse until `}` (when nested) or end of input. */
	private message(nested: boolean, tagStack: string[]): void {
		const depth = tagStack.length;
		while (this.pos < this.text.length) {
			const ch = this.text[this.pos];
			if (ch === "'") {
				this.quote();
			} else if (ch === "{") {
				this.pos++;
				this.argument(tagStack);
			} else if (ch === "}") {
				if (!nested) throw new MessageSyntaxError(`unbalanced "}"`);
				if (tagStack.length !== depth) {
					throw new MessageSyntaxError(`unclosed <${tagStack.at(-1)}>`);
				}
				return;
			} else if (ch === "<") {
				this.tag(tagStack);
			} else {
				this.pos++;
			}
		}
		if (nested) throw new MessageSyntaxError(`unbalanced "{"`);
		if (tagStack.length > 0) {
			throw new MessageSyntaxError(`unclosed <${tagStack.at(-1)}>`);
		}
	}

	/** ICU apostrophe quoting: `''` is a literal `'`; `'{…'` quotes syntax. */
	private quote(): void {
		const next = this.text[this.pos + 1];
		if (next === "'") {
			this.pos += 2;
			return;
		}
		if (next === "{" || next === "}" || next === "#" || next === "<") {
			const end = this.text.indexOf("'", this.pos + 1);
			this.pos = end === -1 ? this.text.length : end + 1;
			return;
		}
		this.pos++;
	}

	private tag(tagStack: string[]): void {
		const start = this.pos;
		const closing = this.text[this.pos + 1] === "/";
		TAG_NAME.lastIndex = this.pos + (closing ? 2 : 1);
		const match = TAG_NAME.exec(this.text);
		if (!match) {
			this.pos++; // a literal "<", e.g. "a < b"
			return;
		}
		let cursor = TAG_NAME.lastIndex;
		const selfClosing = !closing && this.text.startsWith("/>", cursor);
		if (selfClosing) cursor += 2;
		else if (this.text[cursor] === ">") cursor += 1;
		else {
			this.pos = start + 1; // not a tag after all
			return;
		}
		const name = match[0];
		this.pos = cursor;
		if (closing) {
			const open = tagStack.pop();
			if (open !== name) {
				throw new MessageSyntaxError(
					open ? `</${name}> closes <${open}>` : `unexpected </${name}>`,
				);
			}
			return;
		}
		this.sig.tags.set(name, (this.sig.tags.get(name) ?? 0) + 1);
		if (!selfClosing) tagStack.push(name);
	}

	private ws(): void {
		while (/\s/.test(this.text[this.pos] ?? "")) this.pos++;
	}

	private expect(ch: string): void {
		if (this.text[this.pos] !== ch) {
			throw new MessageSyntaxError(
				`expected "${ch}" at ${this.pos}, found "${this.text[this.pos] ?? "end"}"`,
			);
		}
		this.pos++;
	}

	private argument(tagStack: string[]): void {
		this.ws();
		ARG_NAME.lastIndex = this.pos;
		const nameMatch = ARG_NAME.exec(this.text);
		if (!nameMatch) throw new MessageSyntaxError("invalid argument name");
		const name = nameMatch[0];
		this.pos = ARG_NAME.lastIndex;
		this.ws();

		if (this.text[this.pos] === "}") {
			this.pos++;
			this.record(name, "simple");
			return;
		}
		this.expect(",");
		this.ws();
		WORD.lastIndex = this.pos;
		const typeMatch = WORD.exec(this.text);
		if (!typeMatch) throw new MessageSyntaxError(`missing type for {${name}}`);
		const type = typeMatch[0];
		this.pos = WORD.lastIndex;
		this.record(name, type);
		this.ws();

		if (type === "plural" || type === "select" || type === "selectordinal") {
			this.expect(",");
			const keys = new Set<string>();
			(type === "select" ? this.sig.selectKeys : this.sig.pluralKeys).set(
				name,
				keys,
			);
			this.cases(keys, tagStack);
			this.expect("}");
			return;
		}

		// number/date/time/etc: optional style, possibly with nested braces.
		if (this.text[this.pos] === ",") {
			this.pos++;
			let depth = 0;
			while (this.pos < this.text.length) {
				const ch = this.text[this.pos];
				if (ch === "{") depth++;
				else if (ch === "}") {
					if (depth === 0) break;
					depth--;
				}
				this.pos++;
			}
		}
		this.ws();
		this.expect("}");
	}

	private cases(keys: Set<string>, tagStack: string[]): void {
		this.ws();
		if (this.text.startsWith("offset:", this.pos)) {
			this.pos += "offset:".length;
			while (/[\d\s]/.test(this.text[this.pos] ?? "")) this.pos++;
		}
		while (true) {
			this.ws();
			if (this.text[this.pos] === "}" || this.pos >= this.text.length) break;
			const start = this.pos;
			while (
				this.pos < this.text.length &&
				!/[\s{}]/.test(this.text[this.pos])
			) {
				this.pos++;
			}
			const key = this.text.slice(start, this.pos);
			if (!key) throw new MessageSyntaxError("missing case selector");
			keys.add(key);
			this.ws();
			this.expect("{");
			this.message(true, [...tagStack]);
			this.expect("}");
		}
		if (keys.size === 0) throw new MessageSyntaxError("no cases");
	}

	private record(name: string, type: string): void {
		const existing = this.sig.args.get(name);
		if (existing && existing !== type) {
			throw new MessageSyntaxError(
				`argument {${name}} used as both ${existing} and ${type}`,
			);
		}
		this.sig.args.set(name, type);
	}
}

/** Parse an ICU message into its structural signature. Throws on bad syntax. */
export function parseMessage(text: string): MessageSignature {
	return new Parser(text).parse();
}

const LOOSE_PLACEHOLDER = /\{\{\s*[^{}\s]+\s*\}\}|\{[^{}\s]+\}|%\{[^}]+\}/g;
const LOOSE_TAG = /<\/?([A-Za-z][\w-]*)\s*\/?>/g;

function multiset(values: string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
	return out;
}

function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) if (b.get(k) !== v) return false;
	return true;
}

function describe(map: Map<string, number>): string {
	return [...map.keys()].sort().join(", ") || "none";
}

/**
 * For sources that aren't valid ICU (e.g. i18next `{{name}}`), compare
 * placeholder-looking tokens and tag names verbatim.
 */
function looseIssues(
	source: string,
	target: string,
): Omit<TranslationIssue, "key">[] {
	const issues: Omit<TranslationIssue, "key">[] = [];
	const sp = multiset(source.match(LOOSE_PLACEHOLDER) ?? []);
	const tp = multiset(target.match(LOOSE_PLACEHOLDER) ?? []);
	if (!sameMultiset(sp, tp)) {
		issues.push({
			rule: "placeholder",
			message: `placeholders differ: expected ${describe(sp)}, got ${describe(tp)}`,
		});
	}
	const tagNames = (s: string) =>
		[...s.matchAll(LOOSE_TAG)]
			.filter((m) => !m[0].startsWith("</"))
			.map((m) => m[1]);
	const st = multiset(tagNames(source));
	const tt = multiset(tagNames(target));
	if (!sameMultiset(st, tt)) {
		issues.push({
			rule: "tags",
			message: `tags differ: expected ${describe(st)}, got ${describe(tt)}`,
		});
	}
	return issues;
}

/**
 * Check that `target` is a faithful translation of `source` structurally:
 * non-empty string, same placeholders, same ICU arguments/types, same
 * `select` cases, `plural` keeps `other`, same rich-text tags. Returns an
 * empty array when valid. The `key` field is left empty for the caller.
 */
export function validateTranslation(
	source: string,
	target: unknown,
): Omit<TranslationIssue, "key">[] {
	if (typeof target !== "string") {
		return [
			{ rule: "type", message: `expected a string, got ${typeof target}` },
		];
	}
	if (target.trim() === "" && source.trim() !== "") {
		return [{ rule: "type", message: "translation is empty" }];
	}

	let src: MessageSignature;
	try {
		src = parseMessage(source);
	} catch {
		return looseIssues(source, target);
	}

	let tgt: MessageSignature;
	try {
		tgt = parseMessage(target);
	} catch (error) {
		return [{ rule: "syntax", message: (error as Error).message }];
	}

	const issues: Omit<TranslationIssue, "key">[] = [];

	for (const [name, type] of src.args) {
		const got = tgt.args.get(name);
		if (!got) {
			issues.push({
				rule: type === "simple" ? "placeholder" : "icu",
				message: `missing ${type === "simple" ? "placeholder" : `${type} argument`} {${name}}`,
			});
		} else if (got !== type) {
			issues.push({
				rule: "icu",
				message: `{${name}} changed from ${type} to ${got}`,
			});
		}
	}
	for (const [name, type] of tgt.args) {
		if (!src.args.has(name)) {
			issues.push({
				rule: type === "simple" ? "placeholder" : "icu",
				message: `unexpected argument {${name}}`,
			});
		}
	}

	for (const [name, keys] of src.selectKeys) {
		const got = tgt.selectKeys.get(name);
		if (!got) continue; // already reported as a missing/changed argument
		const expected = [...keys].sort().join(", ");
		const actual = [...got].sort().join(", ");
		if (expected !== actual) {
			issues.push({
				rule: "icu",
				message: `select {${name}} cases changed: expected ${expected}, got ${actual}`,
			});
		}
	}
	for (const [name, keys] of src.pluralKeys) {
		const got = tgt.pluralKeys.get(name);
		if (got && keys.has("other") && !got.has("other")) {
			issues.push({
				rule: "icu",
				message: `plural {${name}} is missing the "other" case`,
			});
		}
	}

	if (!sameMultiset(src.tags, tgt.tags)) {
		issues.push({
			rule: "tags",
			message: `tags differ: expected ${describe(src.tags)}, got ${describe(tgt.tags)}`,
		});
	}

	return issues;
}
