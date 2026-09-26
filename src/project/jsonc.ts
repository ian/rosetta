/**
 * A small JSONC parser: JSON plus `//` and `/* *\/` comments and trailing
 * commas. Besides the value it returns translator notes — the comment block
 * directly above a key (or trailing it on the same line), keyed by the
 * dotted path of that key.
 */

export class JsoncError extends Error {
	constructor(
		message: string,
		readonly line: number,
		readonly column: number,
	) {
		super(`${message} (line ${line}, column ${column})`);
		this.name = "JsoncError";
	}
}

export interface JsoncResult {
	value: unknown;
	/** Dotted key path → comment text. */
	notes: Record<string, string>;
}

class JsoncParser {
	private pos = 0;
	private pending: string[] = [];
	readonly notes: Record<string, string> = {};

	constructor(private readonly text: string) {}

	parse(): unknown {
		this.skip();
		const value = this.value([]);
		this.skip();
		if (this.pos < this.text.length) this.fail("unexpected trailing content");
		return value;
	}

	private fail(message: string): never {
		const before = this.text.slice(0, this.pos);
		const line = before.split("\n").length;
		const column = this.pos - before.lastIndexOf("\n");
		throw new JsoncError(message, line, column);
	}

	/** Skip whitespace and comments, collecting comments into `pending`. */
	private skip(): void {
		while (this.pos < this.text.length) {
			const ch = this.text[this.pos];
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
				this.pos++;
			} else if (this.text.startsWith("//", this.pos)) {
				const end = this.text.indexOf("\n", this.pos);
				const stop = end === -1 ? this.text.length : end;
				this.pending.push(this.text.slice(this.pos + 2, stop).trim());
				this.pos = stop;
			} else if (this.text.startsWith("/*", this.pos)) {
				const end = this.text.indexOf("*/", this.pos + 2);
				if (end === -1) this.fail("unterminated block comment");
				const body = this.text
					.slice(this.pos + 2, end)
					.split("\n")
					.map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
					.join("\n")
					.trim();
				this.pending.push(body);
				this.pos = end + 2;
			} else if (ch === "\uFEFF") {
				this.pos++;
			} else {
				return;
			}
		}
	}

	/** Take collected comments as a note (and clear them). */
	private takeNote(): string | undefined {
		const note = this.pending.filter(Boolean).join("\n").trim();
		this.pending = [];
		return note || undefined;
	}

	/** A comment on the same line after a value belongs to that value. */
	private trailingNote(path: string[]): void {
		let cursor = this.pos;
		while (this.text[cursor] === " " || this.text[cursor] === "\t") cursor++;
		if (this.text[cursor] === ",") {
			cursor++;
			while (this.text[cursor] === " " || this.text[cursor] === "\t") cursor++;
		}
		if (!this.text.startsWith("//", cursor)) return;
		const end = this.text.indexOf("\n", cursor);
		const stop = end === -1 ? this.text.length : end;
		const comment = this.text.slice(cursor + 2, stop).trim();
		if (!comment) return;
		const key = path.join(".");
		this.notes[key] = this.notes[key]
			? `${this.notes[key]}\n${comment}`
			: comment;
		// Blank out the consumed comment so skip() doesn't collect it again.
		const hasComma = this.text.slice(this.pos, cursor).includes(",");
		this.pos = stop;
		if (hasComma) this.commaConsumed = true;
	}

	private commaConsumed = false;

	private value(path: string[]): unknown {
		const ch = this.text[this.pos];
		if (ch === "{") return this.object(path);
		if (ch === "[") return this.array(path);
		if (ch === '"') return this.string();
		if (this.text.startsWith("true", this.pos)) {
			this.pos += 4;
			return true;
		}
		if (this.text.startsWith("false", this.pos)) {
			this.pos += 5;
			return false;
		}
		if (this.text.startsWith("null", this.pos)) {
			this.pos += 4;
			return null;
		}
		const num = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
		num.lastIndex = this.pos;
		const match = num.exec(this.text);
		if (match) {
			this.pos = num.lastIndex;
			return Number(match[0]);
		}
		this.fail(
			ch === undefined ? "unexpected end of input" : `unexpected "${ch}"`,
		);
	}

	private string(): string {
		const start = this.pos;
		this.pos++;
		while (this.pos < this.text.length) {
			const ch = this.text[this.pos];
			if (ch === "\\") this.pos += 2;
			else if (ch === '"') {
				this.pos++;
				try {
					return JSON.parse(this.text.slice(start, this.pos)) as string;
				} catch {
					this.pos = start;
					this.fail("invalid string");
				}
			} else if (ch === "\n") {
				this.fail("unterminated string");
			} else this.pos++;
		}
		this.pos = start;
		this.fail("unterminated string");
	}

	/** After a member: consume `,` (true) or detect the closing char (false). */
	private separator(close: string): boolean {
		if (this.commaConsumed) {
			this.commaConsumed = false;
			this.skip();
			return this.text[this.pos] !== close;
		}
		this.skip();
		if (this.text[this.pos] === ",") {
			this.pos++;
			this.skip();
			return this.text[this.pos] !== close; // trailing comma allowed
		}
		if (this.text[this.pos] === close) return false;
		this.fail(`expected "," or "${close}"`);
	}

	private object(path: string[]): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		this.pos++; // {
		this.skip();
		if (this.text[this.pos] === "}") {
			this.pending = [];
			this.pos++;
			return out;
		}
		while (true) {
			if (this.text[this.pos] !== '"') this.fail("expected a string key");
			const note = this.takeNote();
			const key = this.string();
			const childPath = [...path, key];
			if (note) this.notes[childPath.join(".")] = note;
			this.skip();
			if (this.text[this.pos] !== ":") this.fail('expected ":"');
			this.pos++;
			this.skip();
			this.pending = [];
			out[key] = this.value(childPath);
			this.trailingNote(childPath);
			if (!this.separator("}")) break;
		}
		this.pending = [];
		this.pos++; // }
		return out;
	}

	private array(path: string[]): unknown[] {
		const out: unknown[] = [];
		this.pos++; // [
		this.skip();
		if (this.text[this.pos] === "]") {
			this.pending = [];
			this.pos++;
			return out;
		}
		while (true) {
			const childPath = [...path, String(out.length)];
			const note = this.takeNote();
			if (note) this.notes[childPath.join(".")] = note;
			out.push(this.value(childPath));
			this.trailingNote(childPath);
			if (!this.separator("]")) break;
		}
		this.pending = [];
		this.pos++; // ]
		return out;
	}
}

/** Parse JSONC (or plain JSON) text into a value plus translator notes. */
export function parseJsonc(text: string): JsoncResult {
	const parser = new JsoncParser(text);
	const value = parser.parse();
	return { value, notes: parser.notes };
}
