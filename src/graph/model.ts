export interface MarkdownNoteMetadata {
	path: string;
	name: string;
	mtime: number;
}

export interface ResolvedLink {
	sourcePath: string;
	targetPath: string;
}

export interface GraphNote extends MarkdownNoteMetadata {
	folderPath: string;
	recent: boolean;
	degree: number;
	/** 1 for a note touched now, decaying with age — drives the warmth of its dot. */
	freshness: number;
}

export interface GraphFolder {
	path: string;
	name: string;
	parentPath: string;
}

export interface GraphEdge {
	sourcePath: string;
	targetPath: string;
}

export interface GraphData {
	notes: GraphNote[];
	folders: GraphFolder[];
	edges: GraphEdge[];
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

const DAY_MS = 86_400_000;
/** Age at which a note's freshness has decayed to ~37%. */
const FRESHNESS_DECAY_DAYS = 21;

function freshnessOf(mtime: number, now: number, decayDays: number): number {
	const ageDays = Math.max(0, now - mtime) / DAY_MS;
	return Math.exp(-ageDays / Math.max(1, decayDays));
}

export function buildGraphData(
	noteMetadata: MarkdownNoteMetadata[],
	folderPaths: string[],
	resolvedLinks: ResolvedLink[],
	recentLimit: number,
	now: number = Date.now(),
	freshnessDays: number = FRESHNESS_DECAY_DAYS,
): GraphData {
	const sortedMetadata = [...noteMetadata].sort((a, b) => compareStrings(a.path, b.path));
	const recentPaths = new Set(
		[...sortedMetadata]
			.sort((a, b) => b.mtime - a.mtime || compareStrings(a.path, b.path))
			.slice(0, Math.max(0, Math.floor(recentLimit)))
			.map((note) => note.path),
	);
	const notes = sortedMetadata.map((note) => {
		const slash = note.path.lastIndexOf('/');
		return {
			...note,
			folderPath: slash === -1 ? '' : note.path.slice(0, slash),
			recent: recentPaths.has(note.path),
			degree: 0,
			freshness: freshnessOf(note.mtime, now, freshnessDays),
		};
	});

	const allFolderPaths = new Set(folderPaths);
	for (const note of notes) {
		let parentPath = note.folderPath;
		while (parentPath) {
			allFolderPaths.add(parentPath);
			const slash = parentPath.lastIndexOf('/');
			parentPath = slash === -1 ? '' : parentPath.slice(0, slash);
		}
	}
	for (const path of [...allFolderPaths]) {
		let parentPath = path;
		while (parentPath) {
			const slash = parentPath.lastIndexOf('/');
			parentPath = slash === -1 ? '' : parentPath.slice(0, slash);
			if (parentPath) allFolderPaths.add(parentPath);
		}
	}

	const folders = [...allFolderPaths].sort(compareStrings).map((path) => {
		const slash = path.lastIndexOf('/');
		return {
			path,
			name: slash === -1 ? path : path.slice(slash + 1),
			parentPath: slash === -1 ? '' : path.slice(0, slash),
		};
	});

	const notePaths = new Set(notes.map((note) => note.path));
	const edgeKeys = new Set<string>();
	const edges = resolvedLinks
		.filter((link) => notePaths.has(link.sourcePath) && notePaths.has(link.targetPath))
		.filter((link) => {
			const key = JSON.stringify([link.sourcePath, link.targetPath]);
			if (edgeKeys.has(key)) return false;
			edgeKeys.add(key);
			return true;
		})
		.map(({ sourcePath, targetPath }) => ({ sourcePath, targetPath }))
		.sort((a, b) => compareStrings(a.sourcePath, b.sourcePath) || compareStrings(a.targetPath, b.targetPath));

	const degree = new Map<string, number>();
	for (const edge of edges) {
		degree.set(edge.sourcePath, (degree.get(edge.sourcePath) ?? 0) + 1);
		if (edge.targetPath !== edge.sourcePath) {
			degree.set(edge.targetPath, (degree.get(edge.targetPath) ?? 0) + 1);
		}
	}

	return {
		notes: notes.map((note) => ({ ...note, degree: degree.get(note.path) ?? 0 })),
		folders,
		edges,
	};
}
