import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(version) {
	const match = VERSION_PATTERN.exec(version);
	if (!match) return null;
	const components = match.slice(1).map(Number);
	return components.every(Number.isSafeInteger) ? components : null;
}

function compareVersions(left, right) {
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return left[index] - right[index];
	}
	return 0;
}

function releaseTagVersion(tag) {
	if (!tag.startsWith("v")) return null;
	const version = tag.slice(1);
	return parseVersion(version) ? version : null;
}

export function evaluateRelease({ currentVersion, allTags, reachableTags, getVersionAtTag }) {
	const parsedCurrent = parseVersion(currentVersion);
	if (!parsedCurrent) return { released: false, reason: "invalid-current-version" };

	const tag = `v${currentVersion}`;
	if (allTags.includes(tag)) return { released: false, reason: "tag-already-exists", tag };

	const previousTag = reachableTags
		.map((candidate) => ({ tag: candidate, version: releaseTagVersion(candidate) }))
		.filter((candidate) => candidate.version)
		.sort((left, right) => compareVersions(parseVersion(right.version), parseVersion(left.version)))[0];

	if (!previousTag) return { released: false, reason: "no-previous-release-tag" };

	const baselineVersion = getVersionAtTag(previousTag.tag);
	if (baselineVersion !== previousTag.version) {
		return { released: false, reason: "tag-package-version-mismatch", previousTag: previousTag.tag };
	}
	if (compareVersions(parsedCurrent, parseVersion(baselineVersion)) <= 0) {
		return { released: false, reason: "version-not-newer-than-previous-release", previousTag: previousTag.tag };
	}

	return { released: true, tag, previousTag: previousTag.tag, previousVersion: baselineVersion };
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main() {
	const currentVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
	const allTags = git("tag", "--list").split(/\r?\n/).filter(Boolean);
	const reachableTags = git("tag", "--merged", "HEAD", "--list", "v*").split(/\r?\n/).filter(Boolean);
	const decision = evaluateRelease({
		currentVersion,
		allTags,
		reachableTags,
		getVersionAtTag(tag) {
			return JSON.parse(git("show", `${tag}:package.json`)).version;
		},
	});

	if (decision.released) {
		console.log(`Verified version bump from ${decision.previousTag} (${decision.previousVersion}) to ${decision.tag}.`);
	} else {
		console.log(`Skipping release: ${decision.reason}${decision.previousTag ? ` (${decision.previousTag})` : ""}.`);
	}

	const output = `released=${decision.released}\n${decision.released ? `tag=${decision.tag}\n` : ""}`;
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
	else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
