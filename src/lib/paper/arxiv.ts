/**
 * arXiv URL conventions (see https://info.arxiv.org/help/api/basics.html
 * and https://info.arxiv.org/about/accessible_HTML.html).
 *
 * | Resource | Pattern |
 * |----------|---------|
 * | Abstract | https://arxiv.org/abs/{id} |
 * | PDF      | https://arxiv.org/pdf/{id}  (also …/pdf/{id}.pdf) |
 * | HTML     | https://arxiv.org/html/{id} (experimental; backfill ongoing) |
 * | Source   | https://arxiv.org/e-print/{id} or /src/{id} |
 *
 * API Atom links use the same shapes; prefer export.arxiv.org only for bulk.
 * PDF/HTML responses currently send `Access-Control-Allow-Origin: *`. The HTML
 * reader fetches the paper in the webview (`arxiv-html.ts`); do not send that
 * document through {@link arxivReaderUrl}, which reports every transport
 * failure as "arXiv unavailable".
 */

const ARXIV_ID_RE =
	/^(?:arXiv:)?((?:\d{4}\.\d{4,5})(?:v\d+)?|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)$/i;

/** Normalize user/API id → bare arXiv id (keeps version suffix if present). */
export function normalizeArxivId(raw: string): string | null {
	const s = raw
		.trim()
		.replace(
			/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf|html|src|e-print)\//i,
			"",
		);
	const cleaned = s.replace(/\.pdf$/i, "").replace(/\/$/, "");
	const m = cleaned.match(ARXIV_ID_RE);
	return m ? m[1] : null;
}

export type ArxivUrls = {
	id: string;
	abs: string;
	pdf: string;
	html: string;
	source: string;
};

/** Build canonical browse URLs from an arXiv id. */
export function arxivUrls(arxivId: string): ArxivUrls | null {
	const id = normalizeArxivId(arxivId);
	if (!id) return null;
	// Prefer unversioned id for stable links (arxiv resolves to latest).
	const bare = id.replace(/v\d+$/i, "");
	return {
		id: bare,
		abs: `https://arxiv.org/abs/${bare}`,
		pdf: `https://arxiv.org/pdf/${bare}`,
		html: `https://arxiv.org/html/${bare}`,
		source: `https://arxiv.org/src/${bare}`,
	};
}

/** True if URL points at arXiv-hosted content we trust for embedding. */
export function isArxivHostedUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return (
			u.hostname === "arxiv.org" ||
			u.hostname === "export.arxiv.org" ||
			u.hostname.endsWith(".arxiv.org")
		);
	} catch {
		return false;
	}
}

/** Convert an arXiv URL to the local reader proxy, retaining its path and query. */
export function arxivReaderUrl(url: string): string {
	const parsed = new URL(url);
	// Windows WebView2 intercepts http(s)://<scheme>.localhost; the filter is
	// registered as http:// unless useHttpsSchemeForCustomProtocol is set.
	const origin = navigator.userAgent.includes("Windows")
		? "http://agentero-arxiv.localhost"
		: "agentero-arxiv://localhost";
	return `${origin}${parsed.pathname}${parsed.search}`;
}

const ARXIV_HEADER_META_RE =
	/^(?:comments|subjects|journal-ref|report-no|license|doi|acm-class|msc-class|version):/i;
const HEADER_ABSTRACT_RE = /(?:^|\s)abstract:\s*/i;
const MAX_ARXIV_HEADER_SCAN = 600;

/**
 * Strip arXiv RSS / announcement boilerplate prefixes (e.g.
 * `arXiv:2607.07738v3 Announce Type: replace Abstract: ...`) while leaving
 * genuine abstract prose untouched.
 */
export function stripArxivAbstractPrefix(raw: string): string {
	let rest = raw.trim();
	for (;;) {
		if (!rest) return "";
		if (/^arxiv:/i.test(rest)) {
			const afterLabel = rest.slice("arxiv:".length).trimStart();
			const idEnd = afterLabel.search(/\s/);
			if (idEnd > 0) {
				let afterId = afterLabel.slice(idEnd).trimStart();
				if (afterId.startsWith("[")) {
					const close = afterId.indexOf("]");
					if (
						close > 0 &&
						close < 40 &&
						!afterId.slice(0, close).includes("\n")
					) {
						afterId = afterId.slice(close + 1).trimStart();
					}
				}
				if (/^announce\s+type:/i.test(afterId)) {
					const absMatch = HEADER_ABSTRACT_RE.exec(afterId);
					if (absMatch && absMatch.index <= MAX_ARXIV_HEADER_SCAN) {
						rest = afterId
							.slice(absMatch.index + absMatch[0].length)
							.trimStart();
						continue;
					}
					const afterType = afterId.replace(/^announce\s+type:\s*/i, "");
					const typeEnd = afterType.search(/\s/);
					rest = (typeEnd === -1 ? "" : afterType.slice(typeEnd)).trimStart();
					continue;
				}
				if (/^abstract:/i.test(afterId)) {
					rest = afterId.replace(/^abstract:\s*/i, "");
					continue;
				}
				if (ARXIV_HEADER_META_RE.test(afterId)) {
					const absMatch = HEADER_ABSTRACT_RE.exec(afterId);
					if (absMatch && absMatch.index <= MAX_ARXIV_HEADER_SCAN) {
						rest = afterId
							.slice(absMatch.index + absMatch[0].length)
							.trimStart();
						continue;
					}
				}
			}
		}
		if (/^announce\s+type:/i.test(rest)) {
			const afterAt = rest.replace(/^announce\s+type:\s*/i, "");
			const absMatch = HEADER_ABSTRACT_RE.exec(afterAt);
			if (absMatch && absMatch.index <= MAX_ARXIV_HEADER_SCAN) {
				rest = afterAt.slice(absMatch.index + absMatch[0].length).trimStart();
				continue;
			}
			const typeEnd = afterAt.search(/\s/);
			rest = (typeEnd === -1 ? "" : afterAt.slice(typeEnd)).trimStart();
			continue;
		}
		if (/^abstract:/i.test(rest)) {
			rest = rest.replace(/^abstract:\s*/i, "");
			continue;
		}
		break;
	}
	return rest.trim();
}
