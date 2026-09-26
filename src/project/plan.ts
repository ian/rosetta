import type { TranslationIssue } from "../types";
import { validateTranslation } from "../validate";
import { hashSource, isTranslatable, type Leaf } from "./entries";
import { createKeyMatcher } from "./glob";

export type PlanAction = "translate" | "copy" | "keep" | "adopt" | "omit";

export type PlanReason =
	| "ignored"
	| "locked"
	| "untranslatable"
	| "non-string"
	| "forced"
	| "missing"
	| "preserved"
	| "invalid"
	| "untracked"
	| "changed"
	| "unchanged";

export interface PlanItem {
	key: string;
	action: PlanAction;
	reason: PlanReason;
	source: Leaf;
	/** The existing target value, if any. */
	target?: unknown;
	/** Validation problems with the existing target (reason `invalid`). */
	issues?: Omit<TranslationIssue, "key">[];
}

export interface KeyControls {
	lockedKeys?: string[];
	preservedKeys?: string[];
	ignoredKeys?: string[];
}

export interface PlanScope {
	/** `--key` patterns: retranslate matching keys even if unchanged. */
	keys?: string[];
	/** `--force`: retranslate every key in scope. */
	force?: boolean;
}

export interface LocalePlan {
	items: PlanItem[];
	/** Keys present in the target but not in the source (or ignored). */
	removed: string[];
}

/**
 * Plan one (source file, locale) pair. First matching rule wins — see
 * docs/spec-v1.md §10.1.
 */
export function planLocale(input: {
	source: Map<string, Leaf>;
	target: Map<string, Leaf> | undefined;
	lock: Record<string, string> | undefined;
	controls?: KeyControls;
	scope?: PlanScope;
}): LocalePlan {
	const { source, target, lock, controls = {}, scope = {} } = input;
	const ignored = createKeyMatcher(controls.ignoredKeys ?? []);
	const locked = createKeyMatcher(controls.lockedKeys ?? []);
	const preserved = createKeyMatcher(controls.preservedKeys ?? []);
	const scoped = createKeyMatcher(scope.keys ?? []);

	const items: PlanItem[] = [];
	for (const [key, value] of source) {
		const existing = target?.get(key);
		const item = (action: PlanAction, reason: PlanReason): PlanItem => ({
			key,
			action,
			reason,
			source: value,
			...(existing !== undefined ? { target: existing } : {}),
		});

		if (ignored(key)) {
			items.push(item("omit", "ignored"));
			continue;
		}
		if (typeof value !== "string") {
			items.push(item("copy", "non-string"));
			continue;
		}
		if (locked(key)) {
			items.push(item("copy", "locked"));
			continue;
		}
		if (!isTranslatable(value)) {
			items.push(item("copy", "untranslatable"));
			continue;
		}
		if (scope.force || scoped(key)) {
			items.push(item("translate", "forced"));
			continue;
		}
		if (typeof existing !== "string" || existing.trim() === "") {
			items.push(item("translate", "missing"));
			continue;
		}
		if (preserved(key)) {
			items.push(item("keep", "preserved"));
			continue;
		}
		const issues = validateTranslation(value, existing);
		if (issues.length > 0) {
			items.push({ ...item("translate", "invalid"), issues });
			continue;
		}
		const recorded = lock?.[key];
		if (recorded === undefined) {
			items.push(item("adopt", "untracked"));
			continue;
		}
		if (recorded !== hashSource(value)) {
			items.push(item("translate", "changed"));
			continue;
		}
		items.push(item("keep", "unchanged"));
	}

	const removed: string[] = [];
	if (target) {
		for (const key of target.keys()) {
			if (!source.has(key) || ignored(key)) removed.push(key);
		}
	}
	return { items, removed };
}

/** The lock entries a locale should have once its plan is fully applied. */
export function nextLockEntries(items: PlanItem[]): Record<string, string> {
	const entries: Record<string, string> = {};
	for (const item of items) {
		if (item.action === "omit" || typeof item.source !== "string") continue;
		entries[item.key] = hashSource(item.source);
	}
	return entries;
}

/** Nearest-ancestor translator notes for each key (own note first). */
export function notesFor(
	keys: Iterable<string>,
	notes: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of keys) {
		const parts = key.split(".");
		const found: string[] = [];
		for (let i = parts.length; i > 0; i--) {
			const note = notes[parts.slice(0, i).join(".")];
			if (note) found.push(note);
		}
		if (found.length > 0) out[key] = found.join(" / ");
	}
	return out;
}
