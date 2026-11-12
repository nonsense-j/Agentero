/**
 * Shared Plaza paper import helper for `Paper Collection`, `Paper Discover`,
 * and `Paper Recommend`.
 *
 * - Collapses cross-portal `Venue` + `arXiv` twins selected in the same batch into
 *   one Vault Library import while marking all sibling cards as imported.
 * - Resolves any matching `arXiv` twin from `collection.sqlite` when importing a
 *   `Venue` entry without `arxivId`, so a single import fetches the arXiv PDF + LaTeX
 *   `source/` AND enriches the Vault catalog entry with Venue metadata via Rust's
 *   `enrich_paper_record_from_collection`.
 */

import { lookupSubmit } from "@/lib/paper/import-actions";
import type { CollectionPaperItem } from "@/lib/plaza/collection-enrichment";
import { importPlazaPaper } from "@/lib/plaza/import";
import {
	cleanDoiKey,
	isPublisherDoi,
	sameCollectionPaperWork,
} from "@/lib/plaza/paper-identity";
import {
	comparePreferredVenueItem,
	mergeArxivIntoVenueItem,
	searchCollectionFastRemote,
} from "@/lib/plaza/paper-search";

type ImportWorkGroup = {
	rep: CollectionPaperItem;
	members: CollectionPaperItem[];
	effectiveArxivId: string | null;
	effectiveDoi: string | null;
};

function mergeWorkGroupMember(
	group: ImportWorkGroup,
	item: CollectionPaperItem,
): void {
	group.members.push(item);
	if (!group.effectiveArxivId && item.arxivId?.trim()) {
		group.effectiveArxivId = item.arxivId.trim();
	}
	const itemDoi = cleanDoiKey(item.doi);
	if (!group.effectiveDoi && itemDoi && isPublisherDoi(itemDoi)) {
		group.effectiveDoi = item.doi?.trim() ?? itemDoi;
	}

	if (group.rep.sourceType === "arxiv" && item.sourceType === "venue") {
		group.rep = mergeArxivIntoVenueItem(item, group.rep);
	} else if (group.rep.sourceType === "venue" && item.sourceType === "arxiv") {
		group.rep = mergeArxivIntoVenueItem(group.rep, item);
	} else if (
		group.rep.sourceType === "venue" &&
		item.sourceType === "venue" &&
		comparePreferredVenueItem(group.rep, item) > 0
	) {
		group.rep = item;
	}
}

async function hydrateSiblingFromCollection(
	group: ImportWorkGroup,
): Promise<void> {
	// Best-effort lookup of cross-portal siblings in `collection.sqlite` so:
	// 1. Importing a Venue entry without `arxivId` picks up its arXiv twin's `arxivId`
	//    (downloading PDF + TeX into the merged Vault entry) and marks the arXiv card imported.
	// 2. Importing an arXiv entry also records its Venue twin's ID/DOI in `members` so
	//    both cards flip to `imported` immediately.
	const targetSource = group.rep.sourceType === "venue" ? "arxiv" : "venue";
	const titleQuery = group.rep.title
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.split(/\s+/)
		.filter(
			(tok) =>
				tok.length >= 2 &&
				tok.toUpperCase() !== "OR" &&
				tok.toUpperCase() !== "AND",
		)
		.slice(0, 8)
		.join(" ");
	if (!titleQuery) return;
	try {
		const res = await searchCollectionFastRemote(
			titleQuery,
			{
				sourceType: targetSource,
				fields: ["title"],
			},
			{ limit: 10 },
		);
		for (const hit of res.items) {
			if (!sameCollectionPaperWork(group.rep, hit.paper)) continue;
			if (!group.members.some((m) => m.id === hit.paper.id)) {
				group.members.push(hit.paper);
			}
			if (!group.effectiveArxivId && hit.paper.arxivId?.trim()) {
				group.effectiveArxivId = hit.paper.arxivId.trim();
			}
			const hitDoi = cleanDoiKey(hit.paper.doi);
			if (!group.effectiveDoi && hitDoi && isPublisherDoi(hitDoi)) {
				group.effectiveDoi = hit.paper.doi?.trim() ?? hitDoi;
			}
		}
	} catch {
		// Best-effort only; backend `enrich_paper_record_from_collection` also resolves siblings.
	}
}

export async function importCollectionPapers(
	papers: readonly CollectionPaperItem[],
	options?: {
		onMarked?: (done: CollectionPaperItem[]) => void;
	},
): Promise<void> {
	if (papers.length === 0) return;

	const groups: ImportWorkGroup[] = [];
	for (const paper of papers) {
		const existing = groups.find((g) => sameCollectionPaperWork(g.rep, paper));
		if (existing) {
			mergeWorkGroupMember(existing, paper);
		} else {
			const cleanDoi = cleanDoiKey(paper.doi);
			groups.push({
				rep: paper,
				members: [paper],
				effectiveArxivId: paper.arxivId?.trim() || null,
				effectiveDoi:
					cleanDoi && isPublisherDoi(cleanDoi)
						? (paper.doi?.trim() ?? cleanDoi)
						: null,
			});
		}
	}

	await Promise.all(groups.map((g) => hydrateSiblingFromCollection(g)));

	const coolGroups: ImportWorkGroup[] = [];
	const lookupGroups: Array<{ group: ImportWorkGroup; identifier: string }> =
		[];

	for (const group of groups) {
		if (!group.effectiveArxivId && group.rep.coolPapersId) {
			coolGroups.push(group);
			continue;
		}
		const identifier = group.effectiveArxivId
			? `arXiv:${group.effectiveArxivId}`
			: group.effectiveDoi
				? `https://doi.org/${group.effectiveDoi}`
				: group.rep.doi?.trim()
					? `https://doi.org/${group.rep.doi.trim()}`
					: group.rep.url.trim() || group.rep.title.trim();
		if (identifier) {
			lookupGroups.push({ group, identifier });
		}
	}

	for (const group of coolGroups) {
		const ok = await importPlazaPaper({
			id: group.rep.coolPapersId ?? group.rep.id,
			branch: "venue",
			url: group.rep.url,
			title: group.rep.title,
		});
		if (ok) {
			options?.onMarked?.(group.members);
		}
	}

	if (lookupGroups.length > 0) {
		await Promise.all(
			lookupGroups.map(({ group, identifier }) =>
				lookupSubmit([identifier], {
					onComplete: (res) => {
						if (res.imported.length > 0) {
							options?.onMarked?.(group.members);
						}
					},
				}),
			),
		);
	}
}
