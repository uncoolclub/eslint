"use strict";

//-----------------------------------------------------------------------------
// Validates internal links and fragment anchors in the built docs site.
//
// Walks every HTML file in `_site`, indexes element ids, then checks that
// each internal link resolves to an existing file (following the pretty-URL
// convention where `/path/to/page` is served from `path/to/page.html` or
// `path/to/page/index.html`) and that fragment links point to an existing
// id in the target document. External links are not checked.
//-----------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const { Parser } = require("htmlparser2");

const SITE_ROOT = path.resolve(__dirname, "../_site");
const PATH_PREFIX = "/docs/head/";
const CANONICAL_ORIGIN = "https://eslint.org";

/*
 * Links from or to locations matching these patterns are not checked.
 * `migrating-to` pages intentionally link to removed rule docs, and the
 * remaining path patterns live outside this site build (main website,
 * versioned docs). `component-library` pages use placeholder hrefs and are
 * excluded as they are internal component previews.
 */
const skipPatterns = [
	"fragment-redirect",
	"migrating-to",
	"/blog",
	"/play",
	"/team",
	"/donate",
	"/version-support/",
	"/docs/latest",
	"/docs/next",
	"/docs/v8.x",
	"/docs/v9.x",
	"component-library",
];

/*
 * Placeholder attribute values that are never real links: `src="null"` is
 * emitted for further-reading cards whose avatar lookup failed at build time
 * (an `onerror` handler swaps in the fallback icon at runtime).
 */
const placeholderHrefs = new Set(["null", "..."]);

/* Elements whose `src` references a local asset worth an existence check. */
const assetSrcTags = new Set(["img", "script", "source", "iframe"]);

/**
 * Recursively collects all HTML file paths under a directory.
 * @param {string} dir Directory to search.
 * @param {string[]} [out] Accumulator for file paths.
 * @returns {string[]} Absolute paths of all HTML files.
 */
function collectHtmlFiles(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			collectHtmlFiles(full, out);
		} else if (entry.name.endsWith(".html")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Parses one HTML file, collecting element ids and link references.
 * @param {string} file Absolute path of the HTML file.
 * @returns {{ids: Set<string>, links: Array<{href: string, line: number, assetOnly: boolean}>}} Parse result.
 */
function parsePage(file) {
	const html = fs.readFileSync(file, "utf8");
	const ids = new Set();
	const links = [];
	let line = 1;
	let lastIndex = 0;

	const parser = new Parser(
		{
			onopentag(name, attribs) {
				// track line numbers incrementally for error reporting
				for (let i = lastIndex; i < parser.startIndex; i++) {
					if (html[i] === "\n") {
						line++;
					}
				}
				lastIndex = parser.startIndex;

				if (attribs.id) {
					ids.add(attribs.id);
				}

				if (name === "a") {
					if (attribs.name) {
						ids.add(attribs.name);
					}
					if (Object.hasOwn(attribs, "href")) {
						links.push({
							href: attribs.href,
							line,
							assetOnly: false,
						});
					}
					return;
				}

				// existence-only checks for referenced local assets
				let assetAttr = null;

				if (name === "link") {
					assetAttr = "href";
				} else if (assetSrcTags.has(name)) {
					assetAttr = "src";
				}

				if (assetAttr !== null && Object.hasOwn(attribs, assetAttr)) {
					links.push({
						href: attribs[assetAttr],
						line,
						assetOnly: true,
					});
				}
			},
		},
		{ decodeEntities: true },
	);

	parser.write(html);
	parser.end();
	return { ids, links };
}

/** @type {Map<string, {ids: Set<string>, links: Array<{href: string, line: number, assetOnly: boolean}>}>} */
const pages = new Map();

for (const file of collectHtmlFiles(SITE_ROOT)) {
	pages.set(
		path.relative(SITE_ROOT, file).split(path.sep).join("/"),
		parsePage(file),
	);
}

/**
 * Resolves an internal site path to an existing file, following the
 * pretty-URL convention.
 * @param {string} sitePath Site-root-relative URL path (no fragment).
 * @returns {string|null} The resolved file key, or `null` if none exists.
 */
function resolveFile(sitePath) {
	let p = sitePath.replace(/\?.*$/u, "");

	try {
		p = decodeURIComponent(p);
	} catch {
		// fall through with the raw value
	}

	if (p === "" || p === "/") {
		p = "index.html";
	}
	p = p.replace(/^\//u, "");

	const candidates = p.endsWith("/")
		? [`${p}index.html`]
		: [p, `${p}.html`, `${p}/index.html`];

	for (const candidate of candidates) {
		if (pages.has(candidate)) {
			return candidate;
		}

		/*
		 * Must be a file, not a directory: a bare directory match would
		 * shadow the `index.html` candidate that follows it, and fragments
		 * would then never be checked against the page actually served.
		 */
		const stat = fs.statSync(path.join(SITE_ROOT, candidate), {
			throwIfNoEntry: false,
		});

		if (stat?.isFile()) {
			return candidate;
		}
	}
	return null;
}

let checked = 0;
let skipped = 0;
const failures = [];

for (const [pageKey, { links }] of pages) {
	const pageDir = path.posix.dirname(pageKey);

	for (const { href, line, assetOnly } of links) {
		if (
			placeholderHrefs.has(href) ||
			skipPatterns.some(
				pattern => href.includes(pattern) || pageKey.includes(pattern),
			)
		) {
			skipped++;
			continue;
		}

		// WHATWG URL parsing: trim whitespace, strip tabs/newlines
		let target = href.trim().replace(/[\t\n\r]/gu, "");

		// canonical absolute URLs are internal
		if (target.startsWith(CANONICAL_ORIGIN + PATH_PREFIX)) {
			target = target.slice(CANONICAL_ORIGIN.length);
		} else if (
			/^[a-z][a-z0-9+.-]*:/iu.test(target) ||
			target.startsWith("//")
		) {
			skipped++; // external protocol (https:, mailto:, ...)
			continue;
		}

		const hashIndex = target.indexOf("#");
		const fragment = hashIndex === -1 ? null : target.slice(hashIndex + 1);
		let filePart = hashIndex === -1 ? target : target.slice(0, hashIndex);

		// root-relative URLs outside the docs prefix belong to the main website
		if (filePart.startsWith("/") && !filePart.startsWith(PATH_PREFIX)) {
			skipped++;
			continue;
		}

		if (filePart.startsWith(PATH_PREFIX)) {
			filePart = filePart.slice(PATH_PREFIX.length);
		} else if (filePart !== "") {
			filePart = path.posix.normalize(
				path.posix.join(pageDir === "." ? "" : pageDir, filePart),
			);
		}

		checked++;

		const targetKey = filePart === "" ? pageKey : resolveFile(filePart);

		if (targetKey === null) {
			failures.push(`${pageKey}:${line} missing target: ${href}`);
			continue;
		}

		if (fragment === "" && targetKey !== pageKey) {
			failures.push(
				`${pageKey}:${line} empty fragment link to another document: ${href}`,
			);
			continue;
		}

		if (fragment && !assetOnly) {
			const targetPage = pages.get(targetKey);

			if (
				targetPage &&
				!targetPage.ids.has(decodeURIComponent(fragment))
			) {
				failures.push(
					`${pageKey}:${line} missing fragment #${fragment} in ${targetKey} (${href})`,
				);
			}
		}
	}
}

console.log(
	`Checked ${checked} internal links across ${pages.size} pages (${skipped} skipped).`,
);

if (failures.length > 0) {
	console.error(`\n${failures.length} broken link(s) found:`);
	for (const failure of failures) {
		console.error(`  ${failure}`);
	}
	process.exit(1);
}
