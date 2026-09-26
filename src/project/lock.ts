import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** `.rosetta/lock.json`: source file → locale → key → source hash. */
export interface Lockfile {
	version: 1;
	files: Record<string, Record<string, Record<string, string>>>;
}

export class LockfileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LockfileError";
	}
}

export function emptyLock(): Lockfile {
	return { version: 1, files: {} };
}

export function readLock(path: string): Lockfile {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLock();
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new LockfileError(
			`${path} is not valid JSON. If this is a merge conflict, pick either side and run \`rosetta push\`.`,
		);
	}
	const lock = parsed as Partial<Lockfile>;
	if (lock.version !== 1 || typeof lock.files !== "object" || !lock.files) {
		throw new LockfileError(
			`${path} has an unsupported format (expected version 1).`,
		);
	}
	return lock as Lockfile;
}

function sortDeep(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.fromEntries(
		Object.keys(value as object)
			.sort()
			.map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
	);
}

/** Write atomically (temp file + rename), with sorted keys. */
export function writeFileAtomic(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, contents);
	renameSync(tmp, path);
}

export function writeLock(path: string, lock: Lockfile): void {
	const files: Lockfile["files"] = {};
	for (const [file, locales] of Object.entries(lock.files)) {
		const kept = Object.fromEntries(
			Object.entries(locales).filter(
				([, keys]) => Object.keys(keys).length > 0,
			),
		);
		if (Object.keys(kept).length > 0) files[file] = kept;
	}
	writeFileAtomic(
		path,
		`${JSON.stringify({ version: 1, files: sortDeep(files) }, null, 2)}\n`,
	);
}
