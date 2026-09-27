export class PathResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PathResolutionError";
	}
}

/** Filename without its final extension: `pages.en.json` → `pages.en`. */
function stem(name: string): { base: string; ext: string } {
	const dot = name.lastIndexOf(".");
	return dot > 0
		? { base: name.slice(0, dot), ext: name.slice(dot) }
		: { base: name, ext: "" };
}

/**
 * Derive a target path from a source path by substituting the locale code,
 * Lingo.dev-style. Rules, in order:
 *
 * 1. The filename (minus extension) or a directory segment equals the source
 *    locale: `messages/en.json` → `messages/es.json`,
 *    `content/en/app.json` → `content/es/app.json`. The filename wins, then
 *    the deepest directory.
 * 2. The filename stem ends with the locale after `.`, `_`, or `-`:
 *    `pages.en.json` → `pages.es.json`, `app_en.json` → `app_es.json`.
 * 3. Otherwise, throw — Rosetta never invents a directory.
 */
export function resolveTargetPath(
	sourcePath: string,
	sourceLocale: string,
	targetLocale: string,
): string {
	const segments = sourcePath.split("/");
	const last = segments.length - 1;
	const { base, ext } = stem(segments[last]);

	if (base === sourceLocale) {
		segments[last] = `${targetLocale}${ext}`;
		return segments.join("/");
	}
	for (let i = last - 1; i >= 0; i--) {
		if (segments[i] === sourceLocale) {
			segments[i] = targetLocale;
			return segments.join("/");
		}
	}
	for (const sep of [".", "_", "-"]) {
		const suffix = `${sep}${sourceLocale}`;
		if (base.endsWith(suffix) && base.length > suffix.length) {
			segments[last] =
				`${base.slice(0, -sourceLocale.length)}${targetLocale}${ext}`;
			return segments.join("/");
		}
	}
	throw new PathResolutionError(
		`Can't derive target paths from "${sourcePath}": the source locale "${sourceLocale}" must appear as a path segment (content/${sourceLocale}/app.json), the filename (${sourceLocale}.json), or a filename suffix (app.${sourceLocale}.json).`,
	);
}
