import { ItemView, Menu, Notice, TAbstractFile, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { buildAdjacency, buildGroups, loadGraph } from './data';
import { selectLabels } from './labels';
import { layoutClouds } from './layout';
import { GraphData } from './model';
import { GraphNavigator } from './navigator';
import { getPinnedPosition, forgetPinnedPosition, setPinnedPosition } from './positions';
import {
	CloudView,
	LinkView,
	NodeView,
	SVG_NS,
	applyLabelAlpha,
	cloudGrowth,
	createDefs,
	drawClouds,
	drawEdges,
	drawNotes,
	glyphScale,
	labelBox,
	nodeRadius,
	placeEdge,
	placeNode,
} from './scene';
import { clampToCloud, Simulation, SimulationLink, SimulationNode } from './simulation';
import { onSettingsChanged, settingsStore } from '../settings';

export const GRAPH_VIEW_TYPE = 'graph-plus-landing-spike';

const WIDTH = 1200;
const MIN_VIEW_WIDTH = 960;
const MIN_VIEW_HEIGHT = 640;
// Below this zoom the text is unreadable anyway, so only the hubs keep names.
const LABEL_READABLE_SCALE = 0.55;
const LABEL_ZOOMED_OUT_CAP = 14;

interface Size {
	width: number;
	height: number;
}

interface InnerCloudView {
	group: SVGGElement;
	depth: number;
	paths: string[];
	outline: SVGEllipseElement;
	title: SVGTextElement;
}

export class GraphView extends ItemView {
	private graph: GraphData = { notes: [], folders: [], edges: [] };
	private focusPath = '';
	private cloudBlobs: Array<{ path: string; cx: number; cy: number; rx: number; ry: number }> = [];
	private refreshTimer: number | undefined;
	private svg: SVGSVGElement | undefined;
	private layer: SVGGElement | undefined;
	private navigator: GraphNavigator | undefined;
	private viewport: Size = { width: MIN_VIEW_WIDTH, height: MIN_VIEW_HEIGHT };
	private content: Size = { width: WIDTH, height: MIN_VIEW_HEIGHT };
	private placed = false;
	private adjacency = new Map<string, Set<string>>();
	private nodeViews: NodeView[] = [];
	private viewsByIndex = new Map<number, NodeView>();
	private cloudViews: CloudView[] = [];
	private notesByCloud = new Map<string, string[]>();
	private matched: Set<string> | null = null;
	private filterQuery = '';
	private linkViews: LinkView[] = [];
	private indexByPath = new Map<string, number>();
	private simulation: Simulation | undefined;
	// Session memory: keeps unpinned notes still across re-renders and focus changes.
	private positions = new Map<string, { x: number; y: number; pinned: boolean }>();
	private frame: number | undefined;
	private innerCloudViews: InnerCloudView[] = [];

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return GRAPH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Graph';
	}

	getIcon(): string {
		return 'network';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('graph-plus-view');
		this.registerEvent(this.app.vault.on('create', (file) => this.onVaultChange(file)));
		this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultChange(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultChange(file)));
		this.registerEvent(this.app.vault.on('rename', (file) => this.onVaultChange(file)));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => this.queueRefresh(file)));
		this.registerEvent(this.app.metadataCache.on('resolved', () => this.queueRefresh()));
		this.register(onSettingsChanged(() => this.refresh()));
		this.register(() => window.clearTimeout(this.refreshTimer));
		this.register(() => this.stopLoop());
		const observer = new ResizeObserver(() => this.handleResize());
		observer.observe(this.contentEl);
		this.register(() => observer.disconnect());
		this.refresh();
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.refreshTimer);
		this.stopLoop();
	}

	private onVaultChange(file: TAbstractFile): void {
		if (file instanceof TFolder || (file instanceof TFile && file.extension.toLowerCase() === 'md')) {
			this.queueRefresh();
		}
	}

	private queueRefresh(file?: TFile): void {
		if (file && file.extension.toLowerCase() !== 'md') return;
		window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => this.refresh(), 100);
	}

	private refresh(): void {
		this.graph = loadGraph(this.app, settingsStore.value.recentCount, settingsStore.value.freshnessDays);
		if (this.focusPath && !this.graph.folders.some((folder) => folder.path === this.focusPath)) this.focusPath = '';
		this.adjacency = buildAdjacency(this.graph.edges);
		this.render();
	}

	private render(): void {
		this.stopLoop();
		this.innerCloudViews = [];
		this.contentEl.empty();
		const settings = settingsStore.value;
		this.contentEl.style.setProperty('--dim-opacity', `${settings.hoverDim}`);
		const toolbar = this.contentEl.createDiv({ cls: 'graph-plus-toolbar' });
		if (this.focusPath) {
			const back = toolbar.createEl('button', { text: '← vault' });
			back.setAttr('aria-label', 'Return to vault graph');
			back.addEventListener('click', () => this.focusFolder(''));
			const parts = this.focusPath.split('/');
			for (const [index, part] of parts.entries()) {
				toolbar.createSpan({ cls: 'graph-plus-crumb-sep', text: '/' });
				const path = parts.slice(0, index + 1).join('/');
				const crumb = toolbar.createEl('button', { cls: 'graph-plus-crumb', text: part });
				crumb.disabled = path === this.focusPath;
				crumb.addEventListener('click', () => this.focusFolder(path));
			}
		}
		const fit = toolbar.createEl('button', { text: 'Fit' });
		fit.setAttr('aria-label', 'Fit the whole graph in view');
		fit.addEventListener('click', () => this.fitToView());
		const filter = toolbar.createEl('input', { cls: 'graph-plus-filter', type: 'search' });
		filter.setAttr('aria-label', 'Filter notes by name');
		filter.placeholder = 'Filter notes';
		filter.value = this.filterQuery;
		filter.addEventListener('input', () => this.applyFilter(filter.value));
		filter.addEventListener('keydown', (event) => {
			if (event.key !== 'Escape') return;
			filter.value = '';
			this.applyFilter('');
		});
		toolbar.createSpan({
			cls: 'graph-plus-hint',
			text: 'Drag dots to move · Scroll to explore · Select a folder name to focus',
		});

		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('class', 'graph-plus-canvas');
		svg.setAttribute('role', 'group');
		svg.setAttribute('aria-label', `Graph of ${this.focusPath || 'vault'}`);
		svg.appendChild(createDefs(settings.cloudSoftness));
		const layer = document.createElementNS(SVG_NS, 'g');
		layer.classList.add('is-arranging');
		svg.appendChild(layer);
		this.contentEl.appendChild(svg);
		this.svg = svg;
		this.layer = layer;
		this.syncViewport();
		this.navigator = this.createNavigator(svg);
		this.drawGraph(layer);
		this.navigator.apply();
	}

	private syncViewport(): void {
		if (!this.svg) return;
		const bounds = this.svg.getBoundingClientRect();
		const width = Math.max(MIN_VIEW_WIDTH, Math.round(bounds.width) || MIN_VIEW_WIDTH);
		const height = Math.max(MIN_VIEW_HEIGHT, Math.round(bounds.height) || MIN_VIEW_HEIGHT);
		this.viewport = { width, height };
		this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
	}

	private handleResize(): void {
		this.syncViewport();
		this.navigator?.apply();
	}

	private fitToView(): void {
		this.navigator?.fit(this.content, this.viewport);
		this.navigator?.apply();
		this.refreshZoom();
	}

	private focusFolder(path: string): void {
		if (path === this.focusPath) return;
		this.focusPath = path;
		this.placed = false;
		this.positions.clear();
		this.render();
		this.navigator?.frame(this.content, this.viewport);
		this.refreshZoom();
	}

	private drawGraph(layer: SVGGElement): void {
		const settings = settingsStore.value;
		const groups = buildGroups(this.graph, this.focusPath);

		if (!groups.length) {
			const empty = document.createElementNS(SVG_NS, 'text');
			empty.setAttribute('x', '32');
			empty.setAttribute('y', '90');
			empty.setAttribute('class', 'graph-plus-empty');
			empty.textContent = 'No Markdown notes here yet';
			layer.appendChild(empty);
			layer.classList.remove('is-arranging');
			this.content = { width: WIDTH, height: MIN_VIEW_HEIGHT };
			this.simulation = undefined;
			this.nodeViews = [];
			this.viewsByIndex = new Map();
			this.linkViews = [];
			this.cloudViews = [];
			this.notesByCloud = new Map();
			return;
		}

		const layout = layoutClouds(groups, WIDTH);
		this.cloudBlobs = layout.blobs;
		this.content = { width: layout.width, height: layout.height };
		if (!this.placed) {
			this.placed = true;
			this.navigator?.placeTopLeft(this.content, this.viewport);
		}

		const { sims: simClouds, views: cloudViews } = drawClouds(
			layer,
			layout.blobs,
			settings.palette,
			settings.cloudOpacity,
			(path) => this.focusFolder(path),
			Boolean(this.focusPath),
		);
		this.drawInnerClouds(layer, layout.nodes);
		this.cloudViews = cloudViews;
		this.notesByCloud = new Map(groups.map((group) => [group.path, group.notes.map((note) => note.path)]));

		const noteByPath = new Map(this.graph.notes.map((note) => [note.path, note]));
		let restored = false;
		const simNodes: SimulationNode[] = layout.nodes.map((node) => {
			const stored = this.focusPath ? undefined : getPinnedPosition(node.path);
			const session = this.positions.get(node.path);
			if (stored || session) restored = true;
			const base = stored ?? session ?? { x: node.x, y: node.y, pinned: false };
			const cloud = simClouds[node.cloud];
			const placed = cloud ? clampToCloud(cloud, base.x, base.y) : { x: base.x, y: base.y };
			return {
				x: placed.x,
				y: placed.y,
				vx: 0,
				vy: 0,
				cloud: node.cloud,
				radius: nodeRadius(noteByPath.get(node.path)?.degree ?? 0, settings.nodeSize),
				anchorX: node.x,
				anchorY: node.y,
				pinned: Boolean(stored) || Boolean(session?.pinned),
			};
		});

		this.indexByPath = new Map(layout.nodes.map((node, index) => [node.path, index]));
		// Reciprocal links are one relationship: draw each pair once, never as a self-loop.
		const linkKeys = new Set<string>();
		const links: SimulationLink[] = [];
		for (const edge of this.graph.edges) {
			if (edge.sourcePath === edge.targetPath) continue;
			const source = this.indexByPath.get(edge.sourcePath);
			const target = this.indexByPath.get(edge.targetPath);
			if (source === undefined || target === undefined) continue;
			const key = source < target ? `${source}|${target}` : `${target}|${source}`;
			if (linkKeys.has(key)) continue;
			linkKeys.add(key);
			links.push({ source, target });
		}

		this.linkViews = drawEdges(layer, links, settings.linkOpacity);
		this.nodeViews = drawNotes(
			layer,
			layout.nodes,
			noteByPath,
			simClouds,
			{
				onHover: (path) => this.highlight(path),
				onHoverEnd: () => this.clearHighlight(),
				onOpen: (path) => void this.openNote(path),
				onContextMenu: (path, event) => this.showNoteMenu(path, event),
			},
			settings.nodeSize,
		);
		this.viewsByIndex = new Map(this.nodeViews.map((view) => [view.index, view]));

		this.simulation = new Simulation(simNodes, simClouds, links);
		this.syncPositions();
		this.refreshZoom();
		this.applyFilter(this.filterQuery);
		this.startLoop(restored ? 0.55 : 1);
	}

	private drawInnerClouds(layer: SVGGElement, nodes: Array<{ path: string }>): void {
		this.innerCloudViews = [];
		const baseDepth = this.focusPath ? this.focusPath.split('/').length : 0;
		for (const folder of this.graph.folders) {
			const depth = folder.path.split('/').length;
			if (depth <= baseDepth + 1) continue;
			const paths = nodes
				.filter((node) => node.path.startsWith(`${folder.path}/`))
				.map((node) => node.path);
			if (!paths.length) continue;
			const group = document.createElementNS(SVG_NS, 'g');
			group.setAttribute('class', 'graph-plus-inner-cloud');
			const outline = document.createElementNS(SVG_NS, 'ellipse');
			outline.setAttribute('class', 'graph-plus-inner-cloud-boundary');
			outline.setAttribute('aria-hidden', 'true');
			group.appendChild(outline);
			const title = document.createElementNS(SVG_NS, 'text');
			title.setAttribute('class', 'graph-plus-inner-cloud-title');
			title.textContent = `${folder.name} · ${paths.length}`;
			title.setAttribute('role', 'button');
			title.setAttribute('tabindex', '0');
			title.setAttribute('aria-label', `Focus folder ${folder.path}`);
			title.addEventListener('click', () => this.focusFolder(folder.path));
			title.addEventListener('keydown', (event) => {
				if (event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				this.focusFolder(folder.path);
			});
			group.appendChild(title);
			layer.appendChild(group);
			this.innerCloudViews.push({ group, depth, paths, outline, title });
		}
	}

	private updateInnerClouds(): void {
		const positions = new Map(this.nodeViews.map((view) => [view.path, view]));
		const scale = this.navigator?.currentScale ?? 1;
		const baseDepth = this.focusPath ? this.focusPath.split('/').length : 0;
		for (const cloud of this.innerCloudViews) {
			let left = Number.POSITIVE_INFINITY;
			let right = Number.NEGATIVE_INFINITY;
			let top = Number.POSITIVE_INFINITY;
			let bottom = Number.NEGATIVE_INFINITY;
			for (const path of cloud.paths) {
				const view = positions.get(path);
				if (!view) continue;
				left = Math.min(left, view.lastX - view.radius);
				right = Math.max(right, view.lastX + view.radius);
				top = Math.min(top, view.lastY - view.radius);
				bottom = Math.max(bottom, view.lastY + view.radius);
			}
			if (!Number.isFinite(left)) continue;
			const cx = (left + right) / 2;
			const cy = (top + bottom) / 2;
			const rx = Math.max(52, (right - left) * 0.72 + 38);
			const ry = Math.max(38, (bottom - top) * 0.72 + 30);
			cloud.outline.setAttribute('cx', `${cx}`);
			cloud.outline.setAttribute('cy', `${cy}`);
			cloud.outline.setAttribute('rx', `${rx}`);
			cloud.outline.setAttribute('ry', `${ry}`);
			const titleY = cy - ry - 10;
			cloud.title.setAttribute('x', `${cx}`);
			cloud.title.setAttribute('y', `${titleY}`);
			cloud.title.setAttribute('transform', `translate(${cx} ${titleY}) scale(${glyphScale(scale)}) translate(${-cx} ${-titleY})`);
			const reveal = Math.max(0, Math.min(1, (scale - (1.05 + (cloud.depth - baseDepth - 2) * 0.8)) / 0.5));
			cloud.group.setAttribute('opacity', `${reveal}`);
			cloud.title.style.pointerEvents = reveal > 0.65 ? 'auto' : 'none';
			cloud.title.setAttribute('tabindex', reveal > 0.65 ? '0' : '-1');
			cloud.title.setAttribute('aria-hidden', reveal > 0.65 ? 'false' : 'true');
		}
	}

	private syncPositions(): void {
		const simulation = this.simulation;
		if (!simulation) return;
		for (const view of this.nodeViews) {
			const node = simulation.nodes[view.index];
			if (!node) continue;
			if (Math.abs(node.x - view.lastX) < 0.01 && Math.abs(node.y - view.lastY) < 0.01) continue;
			view.lastX = node.x;
			view.lastY = node.y;
			placeNode(view, node.x, node.y, this.navigator?.currentScale);
			this.positions.set(view.path, { x: node.x, y: node.y, pinned: node.pinned });
		}
		for (const link of this.linkViews) {
			const source = simulation.nodes[link.source];
			const target = simulation.nodes[link.target];
			if (!source || !target) continue;
			placeEdge(link, source, target);
		}
		this.updateInnerClouds();
	}

	private refreshZoom(): void {
		const scale = this.navigator?.currentScale ?? 1;
		for (const view of this.nodeViews) {
			if (Number.isFinite(view.lastX)) placeNode(view, view.lastX, view.lastY, scale);
		}
		const growth = cloudGrowth(scale);
		for (const [index, cloud] of this.cloudViews.entries()) {
			const blob = this.cloudBlobs[index];
			if (!blob || !cloud.folder) continue;
			const transform = `translate(${blob.cx} ${blob.cy}) scale(${growth}) translate(${-blob.cx} ${-blob.cy})`;
			cloud.element.setAttribute('transform', transform);
			cloud.outline?.setAttribute('transform', transform);
			cloud.outline?.setAttribute('opacity', `${Math.min(0.75, Math.max(0, (scale - 1) * 0.5))}`);
			const titleY = blob.cy - blob.ry - 22;
			cloud.title.setAttribute('transform', `translate(0 ${-(growth - 1) * blob.ry}) translate(${blob.cx} ${titleY}) scale(${glyphScale(scale)}) translate(${-blob.cx} ${-titleY})`);
		}
		this.updateInnerClouds();
		this.updateLabels();
	}

	private startLoop(alpha = 0.6): void {
		this.simulation?.wake(alpha);
		if (this.frame === undefined) this.frame = window.requestAnimationFrame(this.tick);
	}

	private stopLoop(): void {
		if (this.frame === undefined) return;
		window.cancelAnimationFrame(this.frame);
		this.frame = undefined;
	}

	private readonly tick = (): void => {
		this.frame = undefined;
		const simulation = this.simulation;
		if (!simulation) return;
		// Reveal on the very first frame: the CSS transition gives a soft entrance,
		// rather than holding the whole graph dim until the layout settles.
		this.layer?.classList.remove('is-arranging');
		if (!simulation.isActive()) {
			this.updateLabels();
			return;
		}
		simulation.step();
		this.syncPositions();
		this.frame = window.requestAnimationFrame(this.tick);
	};

	/** Keeps names in free space: hubs win, and colliding labels fade out. */
	private updateLabels(): void {
		const simulation = this.simulation;
		if (!simulation) return;
		const matched = this.matched;
		const relevant = matched ? this.nodeViews.filter((view) => matched.has(view.path)) : this.nodeViews;
		const candidates = relevant.map((view) => {
			const node = simulation.nodes[view.index];
			return labelBox(view, node?.x ?? view.lastX, node?.y ?? view.lastY, this.navigator?.currentScale);
		});
		const cap =
			(this.navigator?.currentScale ?? 1) < LABEL_READABLE_SCALE ? LABEL_ZOOMED_OUT_CAP : Number.POSITIVE_INFINITY;
		const { visible } = selectLabels(candidates, cap);
		for (const view of this.nodeViews) {
			const shown = visible.has(view.path) && (!matched || matched.has(view.path));
			applyLabelAlpha(view, shown ? view.baseAlpha : 0);
		}
	}

	/** Dims everything that does not match, so the filter reads as a spotlight. */
	private applyFilter(query: string): void {
		this.filterQuery = query;
		const needle = query.trim().toLowerCase();
		this.matched = needle
			? new Set(
					this.graph.notes
						.filter(
							(note) => note.name.toLowerCase().includes(needle) || note.path.toLowerCase().includes(needle),
						)
						.map((note) => note.path),
				)
			: null;
		for (const view of this.nodeViews) {
			view.group.classList.toggle('is-filtered-out', Boolean(this.matched) && !this.matched?.has(view.path));
		}
		for (const cloud of this.cloudViews) {
			const paths = this.notesByCloud.get(cloud.path) ?? [];
			const anyMatch = !this.matched || paths.some((path) => this.matched?.has(path));
			cloud.element.classList.toggle('is-filtered-out', !anyMatch);
			cloud.title.classList.toggle('is-filtered-out', !anyMatch);
			cloud.outline?.classList.toggle('is-filtered-out', !anyMatch);
		}
		for (const cloud of this.innerCloudViews) {
			cloud.group.classList.toggle('is-filtered-out', Boolean(this.matched) && !cloud.paths.some((path) => this.matched?.has(path)));
		}
		this.updateLabels();
	}

	// Mirrors the built-in graph: hovering a note lifts its links and neighbours.
	private highlight(path: string): void {
		const peers = this.adjacency.get(path) ?? new Set<string>();
		for (const view of this.nodeViews) {
			const isSelf = view.path === path;
			const isPeer = peers.has(view.path);
			view.group.classList.toggle('is-hovered', isSelf);
			view.group.classList.toggle('is-neighbor', isPeer);
			view.group.classList.toggle('is-dimmed', !isSelf && !isPeer);
		}
		const index = this.indexByPath.get(path);
		for (const link of this.linkViews) {
			const active = index !== undefined && (link.source === index || link.target === index);
			link.element.classList.toggle('is-active', active);
			link.element.classList.toggle('is-dimmed', !active);
		}
	}

	private clearHighlight(): void {
		for (const view of this.nodeViews) {
			view.group.classList.remove('is-hovered', 'is-neighbor', 'is-dimmed', 'is-dragging');
		}
		for (const link of this.linkViews) {
			link.element.classList.remove('is-active', 'is-dimmed');
		}
	}

	private async openNote(path: string, target: 'tab' | 'split' | 'window' = 'tab'): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const { workspace } = this.app;
		// getLeaf('split', direction) is its own overload; other pane types take one argument.
		if (target === 'split') {
			await workspace.getLeaf('split', 'vertical').openFile(file);
			return;
		}
		const leaf = target === 'window' ? workspace.getLeaf('window') : workspace.getLeaf('tab');
		await leaf.openFile(file);
	}

	private showNoteMenu(path: string, event: MouseEvent): void {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const menu = new Menu();
		menu.addItem((item) => item.setTitle('Open in new tab').setIcon('file-plus').onClick(() => void this.openNote(path)));
		menu.addItem((item) =>
			item
				.setTitle('Open to the right')
				.setIcon('separator-vertical')
				.onClick(() => void this.openNote(path, 'split')),
		);
		menu.addItem((item) =>
			item.setTitle('Open in new window').setIcon('picture-in-picture').onClick(() => void this.openNote(path, 'window')),
		);
		menu.addItem((item) => item.setTitle('Copy link').setIcon('link').onClick(() => void this.copyLink(file)));
		if (this.isPinned(path)) {
			menu.addItem((item) =>
				item.setTitle('Release position').setIcon('pin-off').onClick(() => this.releasePosition(path)),
			);
		}
		menu.showAtMouseEvent(event);
	}

	private isPinned(path: string): boolean {
		const index = this.indexByPath.get(path);
		return index === undefined ? false : (this.simulation?.nodes[index]?.pinned ?? false);
	}

	private async copyLink(file: TFile): Promise<void> {
		const clipboard = window.navigator.clipboard;
		if (!clipboard) return;
		await clipboard.writeText(this.app.fileManager.generateMarkdownLink(file, ''));
		new Notice('Link copied');
	}

	/** Lets a dragged note rejoin the simulation, and forgets its stored position. */
	private releasePosition(path: string): void {
		if (!this.focusPath) forgetPinnedPosition(path);
		this.positions.delete(path);
		const index = this.indexByPath.get(path);
		const node = index === undefined ? undefined : this.simulation?.nodes[index];
		if (!node) return;
		node.pinned = false;
		this.startLoop(0.9);
	}

	private createNavigator(svg: SVGSVGElement): GraphNavigator {
		return new GraphNavigator(svg, {
			layer: () => this.layer,
			refreshLabels: () => this.refreshZoom(),
			resolveNotePath: (target) => target.closest('.graph-plus-note')?.getAttribute('data-path') ?? undefined,
			resolveNote: (target) => {
				const path = target.closest('.graph-plus-note')?.getAttribute('data-path') ?? undefined;
				const index = path === undefined ? undefined : this.indexByPath.get(path);
				return path !== undefined && index !== undefined ? { index, path } : undefined;
			},
			nodePosition: (index) => this.simulation?.nodes[index],
			moveNode: (index, x, y) => this.moveNode(index, x, y),
			wakeSimulation: (alpha) => this.startLoop(alpha),
			markDragging: (index, dragging) =>
				this.viewsByIndex.get(index)?.group.classList.toggle('is-dragging', dragging),
			openNote: (path) => void this.openNote(path),
		});
	}

	/** Dragging pins a note in place, and the drop is what gets persisted. */
	private moveNode(index: number, x: number, y: number): void {
		const simulation = this.simulation;
		const view = this.viewsByIndex.get(index);
		if (!simulation || !view) return;
		simulation.dragTo(index, x, y);
		const node = simulation.nodes[index];
		if (node && !this.focusPath) setPinnedPosition(view.path, node.x, node.y);
	}
}
