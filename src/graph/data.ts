import { App, TFile, TFolder } from 'obsidian';
import { CloudGroup } from './layout';
import { buildGraphData, GraphData, GraphEdge, GraphNote, ResolvedLink } from './model';

/** Reads the vault through the public API and reduces it to pure graph data. */
export function loadGraph(app: App, recentLimit: number, freshnessDays: number): GraphData {
	const files = app.vault.getMarkdownFiles();
	const links: ResolvedLink[] = [];
	for (const file of files) {
		for (const link of app.metadataCache.getFileCache(file)?.links ?? []) {
			const target = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
			if (target instanceof TFile && target.extension.toLowerCase() === 'md') {
				links.push({ sourcePath: file.path, targetPath: target.path });
			}
		}
	}
	return buildGraphData(
		files.map((file) => ({ path: file.path, name: file.basename, mtime: file.stat.mtime })),
		app.vault.getAllLoadedFiles().filter((file) => file instanceof TFolder).map((folder) => folder.path),
		links,
		recentLimit,
		Date.now(),
		freshnessDays,
	);
}

/** Undirected peer map, used for hover highlighting. */
export function buildAdjacency(edges: GraphEdge[]): Map<string, Set<string>> {
	const adjacency = new Map<string, Set<string>>();
	const connect = (from: string, to: string) => {
		const peers = adjacency.get(from) ?? new Set<string>();
		peers.add(to);
		adjacency.set(from, peers);
	};
	for (const edge of edges) {
		if (edge.sourcePath === edge.targetPath) continue;
		connect(edge.sourcePath, edge.targetPath);
		connect(edge.targetPath, edge.sourcePath);
	}
	return adjacency;
}

/** Average freshness across a set of notes; drives the activity palette. */
function averageFreshness(notes: GraphNote[]): number {
	if (!notes.length) return 0;
	return notes.reduce((sum, note) => sum + note.freshness, 0) / notes.length;
}

/**
 * Immediate subfolder clouds carry all descendant notes, so each focused level
 * reveals the complete contents of its child folders.
 */
export function buildGroups(graph: GraphData, parentPath: string): CloudGroup[] {
	const groups: CloudGroup[] = graph.folders
		.filter((folder) => folder.parentPath === parentPath)
		.map((folder) => {
			const notes = graph.notes.filter((note) => note.folderPath === folder.path);
			const descendants = graph.notes.filter((note) => note.folderPath.startsWith(`${folder.path}/`));
			return {
				path: folder.path,
				name: folder.name,
				folder: true,
				count: notes.length + descendants.length,
				activity: averageFreshness([...notes, ...descendants]),
				notes: [...notes, ...descendants].map((note) => ({ path: note.path })),
			};
		});
	const directNotes = graph.notes.filter((note) => note.folderPath === parentPath);
	if (directNotes.length) {
		groups.push({
			path: '',
			name: parentPath ? 'Notes here' : 'Vault notes',
			folder: false,
			activity: averageFreshness(directNotes),
			notes: directNotes.map((note) => ({ path: note.path })),
		});
	}
	return groups;
}
