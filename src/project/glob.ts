import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ESCAPE = /[.+^${}()|[\]\\]/g;
const esc = (text: string) => text.replace(ESCAPE, "\\$&");

/** True when the string contains glob syntax. */
export function isGlob(pattern: string): boolean {
	return /[*?]/.test(pattern);
}

/**
 * Compile a glob to an anchored RegExp. `sep` is the segment separator:
 * `/` for file paths, `.` for key paths. `*` matches within one segment,
 * `**` matches any number of segments (including none), `?` one character.
 */
export function globToRegExp(glob: string, sep: "/" | "."): RegExp {
	const s = esc(sep);
	const notSep = `[^${s}]`;
	let out = "";
	let i = 0;
	while (i < glob.length) {
		if (glob.startsWith(`**${sep}`, i)) {
			out += `(?:.*${s})?`;
			i += 3;
		} else if (glob.startsWith(`${sep}**`, i) && i + 3 === glob.length) {
			out += `(?:${s}.*)?`;
			i += 3;
		} else if (glob.startsWith("**", i)) {
			out += ".*";
			i += 2;
		} else if (glob[i] === "*") {
			out += `${notSep}*`;
			i++;
		} else if (glob[i] === "?") {
			out += notSep;
			i++;
		} else {
			out += esc(glob[i]);
			i++;
		}
	}
	return new RegExp(`^${out}$`);
}

/**
 * Match a dotted key against a key pattern: exact, prefix on a `.` boundary
 * (`auth` claims `auth.login.title` but not `authority`), or glob.
 */
export function createKeyMatcher(patterns: string[]): (key: string) => boolean {
	if (patterns.length === 0) return () => false;
	const tests = patterns.map((pattern) => {
		if (isGlob(pattern)) {
			const re = globToRegExp(pattern, ".");
			const prefix = globToRegExp(`${pattern}.**`, ".");
			return (key: string) => re.test(key) || prefix.test(key);
		}
		return (key: string) => key === pattern || key.startsWith(`${pattern}.`);
	});
	return (key) => tests.some((test) => test(key));
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);

/**
 * Expand a path pattern (relative, forward slashes) to matching files under
 * `root`, sorted. Non-glob patterns return themselves if the file exists.
 */
export function expandPattern(root: string, pattern: string): string[] {
	if (!isGlob(pattern)) {
		try {
			return statSync(join(root, pattern)).isFile() ? [pattern] : [];
		} catch {
			return [];
		}
	}
	const segments = pattern.split("/");
	const firstGlob = segments.findIndex(isGlob);
	const base = segments.slice(0, firstGlob).join("/");
	const re = globToRegExp(pattern, "/");

	let entries: string[];
	try {
		entries = readdirSync(join(root, base || "."), {
			recursive: true,
		}) as string[];
	} catch {
		return [];
	}

	const out: string[] = [];
	for (const entry of entries) {
		const rel = (base ? `${base}/${entry}` : entry).split("\\").join("/");
		if (rel.split("/").some((segment) => SKIP_DIRS.has(segment))) continue;
		if (!re.test(rel)) continue;
		try {
			if (statSync(join(root, rel)).isFile()) out.push(rel);
		} catch {
			// vanished between readdir and stat
		}
	}
	return out.sort();
}
