import { estimateLabelWidth, LabelCandidate } from './labels';
import { CloudBlob, CloudNode, labelAlpha } from './layout';
import { GraphNote } from './model';
import type { Point } from './navigator';
import { cloudFill } from './palettes';
import { SimulationCloud, SimulationLink } from './simulation';

export const SVG_NS = 'http://www.w3.org/2000/svg';

const CLOUD_BLUR = 'graph-plus-cloud-blur';
const LABEL_OFFSET = 7;
const LABEL_HEIGHT = 15;
const NODE_MIN_RADIUS = 5;
const NODE_MAX_RADIUS = 18;
/** Below this freshness a note reads as untouched: its dot turns cool and dashed. */
const STALE_FRESHNESS = 0.1;

export interface NodeView {
	path: string;
	index: number;
	group: SVGGElement;
	glyph: SVGGElement;
	circle: SVGCircleElement;
	label: SVGTextElement;
	radius: number;
	cloudCx: number;
	side: number;
	baseAlpha: number;
	priority: number;
	labelWidth: number;
	lastX: number;
	lastY: number;
}

export interface LinkView {
	element: SVGLineElement;
	source: number;
	target: number;
}

export interface NoteCallbacks {
	onHover: (path: string) => void;
	onHoverEnd: () => void;
	onOpen: (path: string) => void;
	onContextMenu: (path: string, event: MouseEvent) => void;
}

export function nodeRadius(degree: number, size = 1): number {
	const base = Math.min(NODE_MAX_RADIUS, NODE_MIN_RADIUS + Math.sqrt(degree) * 2.4);
	return base * size;
}

/** Defs block for the graph: the cloud blur (the backdrop is pure CSS). */
export function createDefs(softness = 16): SVGDefsElement {
	const defs = document.createElementNS(SVG_NS, 'defs');
	const filter = document.createElementNS(SVG_NS, 'filter');
	filter.setAttribute('id', CLOUD_BLUR);
	filter.setAttribute('x', '-30%');
	filter.setAttribute('y', '-30%');
	filter.setAttribute('width', '160%');
	filter.setAttribute('height', '160%');
	const blur = document.createElementNS(SVG_NS, 'feGaussianBlur');
	blur.setAttribute('stdDeviation', `${softness}`);
	filter.appendChild(blur);
	defs.appendChild(filter);
	return defs;
}

export function addText(parent: SVGGElement, x: number, y: number, text: string, className: string): SVGTextElement {
	const label = document.createElementNS(SVG_NS, 'text');
	label.setAttribute('x', `${x}`);
	label.setAttribute('y', `${y}`);
	label.setAttribute('class', className);
	label.textContent = text;
	parent.appendChild(label);
	return label;
}

export interface CloudView {
	path: string;
	folder: boolean;
	element: SVGGElement;
	outline?: SVGEllipseElement;
	title: SVGElement;
}

export interface CloudScene {
	sims: SimulationCloud[];
	views: CloudView[];
}

/** Cloud shapes plus their titles. Returns the clouds the simulation confines notes to. */
export function drawClouds(
	layer: SVGGElement,
	blobs: CloudBlob[],
	palette: string,
	opacity: number,
	onOpenFolder: (path: string) => void,
	looseNotes = false,
): CloudScene {
	const cloudLayer = document.createElementNS(SVG_NS, 'g');
	cloudLayer.setAttribute('class', 'graph-plus-clouds');
	cloudLayer.setAttribute('filter', `url(#${CLOUD_BLUR})`);
	cloudLayer.setAttribute('opacity', `${opacity}`);
	cloudLayer.setAttribute('aria-hidden', 'true');
	const boundaryLayer = document.createElementNS(SVG_NS, 'g');
	boundaryLayer.setAttribute('class', 'graph-plus-outer-boundaries');
	const titleLayer = document.createElementNS(SVG_NS, 'g');
	titleLayer.setAttribute('class', 'graph-plus-cloud-labels');
	const sims: SimulationCloud[] = [];
	const views: CloudView[] = [];
	for (const blob of blobs) {
		const cloud = document.createElementNS(SVG_NS, 'g');
		cloud.setAttribute('class', `graph-plus-cloud${blob.folder ? ' is-folder' : ''}`);
		cloud.setAttribute(
			'fill',
			cloudFill(palette, {
				path: blob.path,
				count: blob.count,
				depth: blob.path ? blob.path.split('/').length : 0,
				activity: blob.activity,
			}),
		);
		cloud.setAttribute('opacity', `${(0.6 + blob.tint * 0.4).toFixed(2)}`);
		if (blob.folder) cloud.setAttribute('data-path', blob.path);
		for (const lobe of blob.lobes) {
			const ellipse = document.createElementNS(SVG_NS, 'ellipse');
			ellipse.setAttribute('cx', `${blob.cx + lobe.dx}`);
			ellipse.setAttribute('cy', `${blob.cy + lobe.dy}`);
			ellipse.setAttribute('rx', `${lobe.rx}`);
			ellipse.setAttribute('ry', `${lobe.ry}`);
			cloud.appendChild(ellipse);
		}
		if (blob.folder || !looseNotes) cloudLayer.appendChild(cloud);
		let outline: SVGEllipseElement | undefined;
		if (blob.folder) {
			outline = document.createElementNS(SVG_NS, 'ellipse');
			outline.setAttribute('class', 'graph-plus-parent-boundary');
			outline.setAttribute('cx', `${blob.cx}`);
			outline.setAttribute('cy', `${blob.cy}`);
			outline.setAttribute('rx', `${blob.rx}`);
			outline.setAttribute('ry', `${blob.ry}`);
			boundaryLayer.appendChild(outline);
		}
		sims.push({ cx: blob.cx, cy: blob.cy, rx: blob.rx, ry: blob.ry });
		const title = blob.folder
			? drawFolderTitle(blob, onOpenFolder)
			: addText(titleLayer, blob.cx, blob.cy - blob.ry - 14, blob.name, 'graph-plus-group-title');
		if (blob.folder || !looseNotes) titleLayer.appendChild(title);
		views.push({ path: blob.path, folder: blob.folder, element: cloud, outline, title });
	}
	layer.appendChild(cloudLayer);
	layer.appendChild(boundaryLayer);
	layer.appendChild(titleLayer);
	return { sims, views };
}

function drawFolderTitle(blob: CloudBlob, onOpenFolder: (path: string) => void): SVGGElement {
	const group = document.createElementNS(SVG_NS, 'g');
	group.setAttribute('class', 'graph-plus-folder-action');
	group.setAttribute('role', 'button');
	group.setAttribute('tabindex', '0');
	group.setAttribute('aria-label', `Focus folder ${blob.path}`);
	group.addEventListener('click', () => onOpenFolder(blob.path));
	group.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		onOpenFolder(blob.path);
	});
	const title = `${blob.name} · ${blob.count}`;
	const y = blob.cy - blob.ry - 22;
	const width = Math.max(40, title.length * 8.8);
	const underline = document.createElementNS(SVG_NS, 'rect');
	underline.setAttribute('class', 'graph-plus-folder-underline');
	underline.setAttribute('x', `${blob.cx - width / 2}`);
	underline.setAttribute('y', `${y + 6}`);
	underline.setAttribute('width', `${width}`);
	underline.setAttribute('height', '2');
	underline.setAttribute('rx', '1');
	group.appendChild(underline);
	const label = document.createElementNS(SVG_NS, 'text');
	label.setAttribute('x', `${blob.cx}`);
	label.setAttribute('y', `${y}`);
	label.setAttribute('class', 'graph-plus-folder-title');
	label.textContent = title;
	group.appendChild(label);
	return group;
}

/** Straight edges: one line per relationship, drawn above clouds and below notes. */
export function drawEdges(layer: SVGGElement, links: SimulationLink[], opacity: number): LinkView[] {
	const edgeLayer = document.createElementNS(SVG_NS, 'g');
	edgeLayer.setAttribute('class', 'graph-plus-edges');
	edgeLayer.setAttribute('opacity', `${opacity}`);
	const views = links.map((link) => {
		const line = document.createElementNS(SVG_NS, 'line');
		line.setAttribute('class', 'graph-plus-edge');
		edgeLayer.appendChild(line);
		return { element: line, source: link.source, target: link.target };
	});
	layer.appendChild(edgeLayer);
	return views;
}

export function drawNotes(
	layer: SVGGElement,
	nodes: CloudNode[],
	notes: Map<string, GraphNote>,
	clouds: SimulationCloud[],
	callbacks: NoteCallbacks,
	nodeSize = 1,
): NodeView[] {
	const maxDegree = nodes.reduce((max, node) => Math.max(max, notes.get(node.path)?.degree ?? 0), 0);
	const views: NodeView[] = [];
	for (const [index, node] of nodes.entries()) {
		const note = notes.get(node.path);
		const cloud = clouds[node.cloud];
		if (!note || !cloud) continue;
		views.push(
			drawNote(
				layer,
				note,
				node.path,
				index,
				nodeRadius(note.degree, nodeSize),
				cloud.cx,
				labelAlpha(note.degree, maxDegree),
				callbacks,
			),
		);
	}
	return views;
}

function drawNote(
	parent: SVGGElement,
	note: GraphNote,
	path: string,
	index: number,
	radius: number,
	cloudCx: number,
	baseAlpha: number,
	callbacks: NoteCallbacks,
): NodeView {
	const group = document.createElementNS(SVG_NS, 'g');
	group.setAttribute('class', `graph-plus-note${note.recent ? ' is-recent' : ''}${note.freshness < STALE_FRESHNESS ? ' is-stale' : ''}`);
	group.setAttribute('role', 'button');
	group.setAttribute('tabindex', '0');
	group.setAttribute('aria-label', `Open ${note.path}${note.recent ? ', recently modified' : ''}`);
	group.setAttribute('data-path', path);
	const glyph = document.createElementNS(SVG_NS, 'g');
	group.appendChild(glyph);
	const circle = document.createElementNS(SVG_NS, 'circle');
	circle.setAttribute('class', 'graph-plus-note-dot');
	circle.setAttribute('r', `${radius.toFixed(2)}`);
	glyph.appendChild(circle);
	// Warmth is a second disc over the dot: fresh notes glow, old ones stay neutral.
	const warmth = document.createElementNS(SVG_NS, 'circle');
	warmth.setAttribute('class', 'graph-plus-note-warmth');
	warmth.setAttribute('r', `${radius.toFixed(2)}`);
	warmth.setAttribute('fill-opacity', (note.freshness * 0.75).toFixed(2));
	glyph.appendChild(warmth);
	const label = document.createElementNS(SVG_NS, 'text');
	label.setAttribute('class', 'graph-plus-note-label');
	label.style.setProperty('--label-alpha', baseAlpha.toFixed(2));
	label.textContent = note.name;
	glyph.appendChild(label);
	group.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			callbacks.onOpen(path);
		}
	});
	// Hover belongs to the node itself; the name is a click target, not a hover trigger.
	circle.addEventListener('mouseenter', () => callbacks.onHover(path));
	circle.addEventListener('mouseleave', () => callbacks.onHoverEnd());
	group.addEventListener('contextmenu', (event) => {
		event.preventDefault();
		callbacks.onContextMenu(path, event);
	});
	parent.appendChild(group);
	return {
		path,
		index,
		group,
		glyph,
		circle,
		label,
		radius,
		cloudCx,
		side: 1,
		baseAlpha,
		priority: note.degree + (note.recent ? 0.5 : 0),
		labelWidth: estimateLabelWidth(note.name),
		lastX: Number.NaN,
		lastY: Number.NaN,
	};
}

/** Labels take the emptier side: away from the cluster centre, so text spreads outward. */
export function glyphScale(zoom: number): number {
	return 1 / Math.max(1, zoom);
}

export function cloudGrowth(zoom: number): number {
	return 1 + Math.min(0.35, Math.max(0, Math.log2(Math.max(1, zoom))) * 0.18);
}

export function placeNode(view: NodeView, x: number, y: number, zoom = 1): void {
	const side = x < view.cloudCx ? -1 : 1;
	if (side !== view.side) {
		view.side = side;
		view.label.setAttribute('text-anchor', side < 0 ? 'end' : 'start');
	}
	view.glyph.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${glyphScale(zoom)})`);
	view.label.setAttribute('x', `${side * (view.radius + LABEL_OFFSET)}`);
	view.label.setAttribute('y', '5');
}

export function placeEdge(view: LinkView, source: Point, target: Point): void {
	view.element.setAttribute('x1', source.x.toFixed(1));
	view.element.setAttribute('y1', source.y.toFixed(1));
	view.element.setAttribute('x2', target.x.toFixed(1));
	view.element.setAttribute('y2', target.y.toFixed(1));
}

export function applyLabelAlpha(view: NodeView, alpha: number): void {
	view.label.style.setProperty('--label-alpha', alpha.toFixed(2));
}

export function labelBox(view: NodeView, x: number, y: number, zoom = 1): LabelCandidate {
	const scale = glyphScale(zoom);
	const left = x + (view.side < 0 ? -view.radius - LABEL_OFFSET - view.labelWidth : view.radius + LABEL_OFFSET) * scale;
	return {
		path: view.path,
		left,
		top: y - (LABEL_HEIGHT / 2) * scale,
		right: left + view.labelWidth * scale,
		bottom: y + (LABEL_HEIGHT / 2) * scale,
		priority: view.priority,
	};
}
