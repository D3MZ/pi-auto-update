import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateRelease } from "../scripts/release-version-check.mjs";

const baselineVersions = new Map([
	["v0.1.6", "0.1.6"],
	["v0.1.7", "0.1.7"],
	["v0.2.0", "0.2.0"],
]);

function release(currentVersion, reachableTags = ["v0.1.6"], allTags = []) {
	return evaluateRelease({
		currentVersion,
		allTags,
		reachableTags,
		getVersionAtTag: (tag) => baselineVersions.get(tag),
	});
}

test("manual release accepts a new version above its reachable, matching release tag", () => {
	assert.deepEqual(release("0.1.7"), {
		released: true,
		tag: "v0.1.7",
		previousTag: "v0.1.6",
		previousVersion: "0.1.6",
	});
});

test("manual release skips an existing tag, absent baseline, or a non-increment", () => {
	assert.equal(release("0.1.7", ["v0.1.6"], ["v0.1.7"]).reason, "tag-already-exists");
	assert.equal(release("0.1.7", []).reason, "no-previous-release-tag");
	assert.equal(release("0.1.6").reason, "version-not-newer-than-previous-release");
	assert.equal(release("0.1.5").reason, "version-not-newer-than-previous-release");
	assert.equal(release("0.1.7", ["v0.1.6", "v0.2.0"]).reason, "version-not-newer-than-previous-release");
	assert.equal(release("0.01.7").reason, "invalid-current-version");
	assert.equal(release("999999999999999999999.1.7").reason, "invalid-current-version");
});

test("manual release fails closed when a release tag disagrees with its package version", () => {
	assert.equal(
		evaluateRelease({
			currentVersion: "0.1.7",
			allTags: [],
			reachableTags: ["v0.1.6"],
			getVersionAtTag: () => "0.1.5",
		}).reason,
		"tag-package-version-mismatch",
	);
});

test("release workflow stays manual/main-only and docs explain dispatch; smoke wording says restart", () => {
	const workflow = readFileSync(new URL("../.github/workflows/auto-release.yml", import.meta.url), "utf8");
	const releaseDocs = readFileSync(new URL("../docs/release.md", import.meta.url), "utf8");
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

	assert.match(workflow, /^on:\r?\n  workflow_dispatch:/m);
	assert.doesNotMatch(workflow, /^\s+push:/m);
	assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
	assert.match(workflow, /node scripts\/release-version-check\.mjs/);
	assert.match(releaseDocs, /manually run \*\*Auto Release\*\* on the `main` branch/);
	assert.doesNotMatch(releaseDocs, /Merge the PR to `main`\.\s*`auto-release\.yml` detects/);
	assert.match(readme, /second-process restart\/cleanup/);
	assert.doesNotMatch(readme, /second-process reload\/cleanup/);
});
