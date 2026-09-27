import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RUN_SH = resolve(__dirname, "../action/run.sh");

/** A fake `rosetta` that writes translations and prints a push --json result. */
const FAKE_ROSETTA = `#!/usr/bin/env node
const fs = require("node:fs");
const [cmd] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, "rosetta " + process.argv.slice(2).join(" ") + "\\n");
if (cmd === "check") process.exit(Number(process.env.FAKE_CHECK_CODE || 0));
const scenario = process.env.FAKE_SCENARIO || "translate";
if (scenario === "error") {
  console.log(JSON.stringify({ command: "push", ok: false, error: { type: "ConfigError", message: "No API key" } }));
  process.exit(2);
}
const locales = [];
if (scenario === "translate" || scenario === "partial") {
  fs.writeFileSync("messages/es.json", JSON.stringify({ hello: "Hola" }, null, 2) + "\\n");
  fs.mkdirSync(".rosetta", { recursive: true });
  fs.writeFileSync(".rosetta/lock.json", JSON.stringify({ version: 1, files: { "messages/en.json": { es: { hello: "abc" } } } }) + "\\n");
  locales.push({ locale: "es", sourceFile: "messages/en.json", file: "messages/es.json", written: true, ok: true, translated: 1, adopted: 0, copied: 0, removed: 0, kept: 0, errors: [] });
}
if (scenario === "partial") {
  locales.push({ locale: "ja", sourceFile: "messages/en.json", file: "messages/ja.json", written: false, ok: false, translated: 1, adopted: 0, copied: 0, removed: 0, kept: 0, errors: [{ key: "hello", rule: "icu", message: "bad" }] });
}
if (scenario === "noop") {
  locales.push({ locale: "es", sourceFile: "messages/en.json", file: "messages/es.json", written: false, ok: true, translated: 0, adopted: 0, copied: 0, removed: 0, kept: 1, errors: [] });
}
console.log(JSON.stringify({ command: "push", ok: scenario !== "partial", locales, usage: { requests: 1, inputTokens: 10, outputTokens: 5 } }));
process.exit(scenario === "partial" ? 1 : 0);
`;

/** A fake `gh` that logs calls and answers `pr list` / `pr create`. */
const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "pr list") echo "\${FAKE_EXISTING_PR:-}" ;;
  "pr create") echo "https://github.com/acme/app/pull/42" ;;
esac
`;

function git(cwd: string, ...args: string[]) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

function setup() {
	const base = mkdtempSync(join(tmpdir(), "rosetta-action-"));
	const remote = join(base, "remote.git");
	const work = join(base, "work");
	const bin = join(base, "bin");
	const log = join(base, "calls.log");
	mkdirSync(bin);
	writeFileSync(log, "");
	writeFileSync(join(bin, "rosetta"), FAKE_ROSETTA);
	writeFileSync(join(bin, "gh"), FAKE_GH);
	chmodSync(join(bin, "rosetta"), 0o755);
	chmodSync(join(bin, "gh"), 0o755);

	git(base, "init", "--quiet", "--bare", "-b", "main", remote);
	git(base, "clone", "--quiet", remote, work);
	git(work, "checkout", "--quiet", "-b", "main");
	git(work, "config", "user.name", "Test");
	git(work, "config", "user.email", "test@example.com");
	mkdirSync(join(work, "messages"));
	writeFileSync(join(work, "messages/en.json"), '{ "hello": "Hello" }\n');
	git(work, "add", ".");
	git(work, "commit", "--quiet", "-m", "init");
	git(work, "push", "--quiet", "origin", "main");

	const output = join(base, "github_output");
	const run = (env: Record<string, string> = {}) => {
		writeFileSync(output, "");
		const r = spawnSync("bash", [RUN_SH], {
			cwd: work,
			encoding: "utf8",
			env: {
				PATH: `${bin}:${process.env.PATH}`,
				HOME: base,
				RUNNER_TEMP: base,
				GITHUB_OUTPUT: output,
				ROSETTA_BIN: join(bin, "rosetta"),
				FAKE_LOG: log,
				GIT_CONFIG_NOSYSTEM: "1",
				...env,
			},
		});
		const outputs = Object.fromEntries(
			readFileSync(output, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => [
					line.slice(0, line.indexOf("=")),
					line.slice(line.indexOf("=") + 1),
				]),
		);
		return {
			code: r.status,
			stdout: r.stdout,
			stderr: r.stderr,
			outputs,
			calls: readFileSync(log, "utf8"),
		};
	};
	const remoteFile = (branch: string, path: string) =>
		git(remote, "show", `${branch}:${path}`);
	return { work, remote, run, remoteFile };
}

describe("action/run.sh", () => {
	it("check mode passes rosetta's exit code through", () => {
		const s = setup();
		expect(s.run({ INPUT_MODE: "check" }).code).toBe(0);
		const stale = s.run({ INPUT_MODE: "check", FAKE_CHECK_CODE: "3" });
		expect(stale.code).toBe(3);
		expect(stale.calls).toContain("rosetta check");
	});

	it("rejects unknown modes", () => {
		expect(setup().run({ INPUT_MODE: "yolo" }).code).toBe(2);
	});

	it("commit mode commits only translation files and pushes the current branch", () => {
		const s = setup();
		writeFileSync(join(s.work, "unrelated.txt"), "build artifact");
		const r = s.run({ INPUT_MODE: "commit", INPUT_ARGS: "--locale es" });

		expect(r.code).toBe(0);
		expect(r.calls).toContain("rosetta push --json --locale es");
		expect(r.outputs.changed).toBe("true");
		expect(r.outputs["commit-sha"]).toMatch(/^[0-9a-f]{40}$/);
		expect(JSON.parse(s.remoteFile("main", "messages/es.json"))).toEqual({
			hello: "Hola",
		});
		expect(s.remoteFile("main", ".rosetta/lock.json")).toContain(
			"messages/en.json",
		);
		expect(git(s.remote, "log", "-1", "--format=%s", "main")).toBe(
			"chore(i18n): update translations",
		);
		expect(git(s.work, "status", "--porcelain")).toBe("?? unrelated.txt");
	});

	it("does nothing when there are no changes", () => {
		const s = setup();
		const before = git(s.remote, "rev-parse", "main");
		const r = s.run({ INPUT_MODE: "commit", FAKE_SCENARIO: "noop" });
		expect(r.code).toBe(0);
		expect(r.outputs.changed).toBe("false");
		expect(git(s.remote, "rev-parse", "main")).toBe(before);
	});

	it("rebases and retries when the branch moved", () => {
		const s = setup();
		// Someone else pushes to main after our checkout.
		const other = join(s.work, "..", "other");
		git(join(s.work, ".."), "clone", "--quiet", s.remote, other);
		git(other, "config", "user.name", "Other");
		git(other, "config", "user.email", "o@example.com");
		writeFileSync(join(other, "README.md"), "hi\n");
		git(other, "add", ".");
		git(other, "commit", "--quiet", "-m", "concurrent");
		git(other, "push", "--quiet", "origin", "main");

		const r = s.run({ INPUT_MODE: "commit" });
		expect(r.code).toBe(0);
		expect(git(s.remote, "log", "--format=%s", "main").split("\n")).toEqual([
			"chore(i18n): update translations",
			"concurrent",
			"init",
		]);
	});

	it("commit mode refuses a detached HEAD", () => {
		const s = setup();
		git(s.work, "checkout", "--quiet", "--detach");
		const r = s.run({ INPUT_MODE: "commit" });
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/HEAD is detached/);
	});

	it("pull-request mode pushes a rolling branch and opens a PR", () => {
		const s = setup();
		const r = s.run({
			INPUT_MODE: "pull-request",
			GITHUB_REPOSITORY: "acme/app",
			INPUT_PR_BODY: "Hello reviewers",
		});

		expect(r.code).toBe(0);
		expect(r.outputs["pr-url"]).toBe("https://github.com/acme/app/pull/42");
		expect(
			JSON.parse(s.remoteFile("rosetta/translations", "messages/es.json")),
		).toEqual({ hello: "Hola" });
		expect(r.calls).toContain(
			"gh pr list --repo acme/app --head rosetta/translations --base main --state open",
		);
		expect(r.calls).toMatch(
			/gh pr create --repo acme\/app --base main --head rosetta\/translations --title chore\(i18n\): update translations --body-file \S+/,
		);
		expect(git(s.remote, "rev-parse", "main")).not.toBe(
			git(s.remote, "rev-parse", "rosetta/translations"),
		);
	});

	it("pull-request mode updates an existing PR instead of opening another", () => {
		const s = setup();
		const r = s.run({
			INPUT_MODE: "pull-request",
			FAKE_EXISTING_PR: "https://github.com/acme/app/pull/7",
			INPUT_BRANCH: "i18n/bot",
		});
		expect(r.code).toBe(0);
		expect(r.outputs["pr-url"]).toBe("https://github.com/acme/app/pull/7");
		expect(r.calls).toContain("gh pr edit https://github.com/acme/app/pull/7");
		expect(r.calls).not.toContain("gh pr create");
		expect(git(s.remote, "rev-parse", "i18n/bot")).toMatch(/^[0-9a-f]{40}$/);
	});

	it("lands successful locales but exits 1 when some failed", () => {
		const s = setup();
		const r = s.run({ INPUT_MODE: "commit", FAKE_SCENARIO: "partial" });
		expect(r.code).toBe(1);
		expect(r.outputs.changed).toBe("true");
		expect(JSON.parse(s.remoteFile("main", "messages/es.json"))).toEqual({
			hello: "Hola",
		});
		expect(r.stderr).toContain("❌ 1 failed — not written");
	});

	it("fails without committing on usage/config errors", () => {
		const s = setup();
		const before = git(s.remote, "rev-parse", "main");
		const r = s.run({ INPUT_MODE: "commit", FAKE_SCENARIO: "error" });
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("No API key");
		expect(git(s.remote, "rev-parse", "main")).toBe(before);
	});
});
