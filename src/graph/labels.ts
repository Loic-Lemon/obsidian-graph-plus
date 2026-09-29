export interface LabelCandidate {
	path: string;
	left: number;
	top: number;
	right: number;
	bottom: number;
	priority: number;
}

export interface LabelSelection {
	visible: Set<string>;
	culled: number;
}

const CHAR_WIDTH = 6.6;
const MIN_LABEL_WIDTH = 22;
const OVERLAP_PADDING = 2;

/** World-space text width estimate; avoids a DOM measurement per label. */
export function estimateLabelWidth(name: string): number {
	return Math.max(MIN_LABEL_WIDTH, name.length * CHAR_WIDTH);
}

function overlaps(a: LabelCandidate, b: LabelCandidate): boolean {
	return (
		a.left < b.right + OVERLAP_PADDING &&
		a.right + OVERLAP_PADDING > b.left &&
		a.top < b.bottom + OVERLAP_PADDING &&
		a.bottom + OVERLAP_PADDING > b.top
	);
}

function compareCandidates(a: LabelCandidate, b: LabelCandidate): number {
	if (b.priority !== a.priority) return b.priority - a.priority;
	if (a.path === b.path) return 0;
	return a.path < b.path ? -1 : 1;
}

/**
 * Greedy map-style labelling: walk labels from most to least important and keep
 * only those that fit in free space, so dense clouds show their hubs instead of
 * a pile of overlapping names. Culled labels still return on hover.
 * ponytail: O(n^2) over one focus view's labels; needs a grid only for huge views.
 */
export function selectLabels(candidates: LabelCandidate[], cap = Number.POSITIVE_INFINITY): LabelSelection {
	const ordered = [...candidates].sort(compareCandidates);
	const accepted: LabelCandidate[] = [];
	const visible = new Set<string>();
	let budget = cap;
	for (const candidate of ordered) {
		if (budget <= 0) break;
		if (accepted.some((placed) => overlaps(candidate, placed))) continue;
		accepted.push(candidate);
		visible.add(candidate.path);
		budget -= 1;
	}
	return { visible, culled: candidates.length - visible.size };
}
