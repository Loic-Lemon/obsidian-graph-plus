export interface CloudGroup {
	path: string;
	name: string;
	folder: boolean;
	notes: Array<{ path: string }>;
	/** Display count may include descendant notes in a folder with no direct notes. */
	count?: number;
	/** 0 = untouched for ages, 1 = edited today; drives the activity palette. */
	activity?: number;
}

export interface CloudNode {
	path: string;
	x: number;
	y: number;
	cloud: number;
}

interface CloudLobe {
	dx: number;
	dy: number;
	rx: number;
	ry: number;
}

export interface CloudBlob {
	path: string;
	name: string;
	folder: boolean;
	cx: number;
	cy: number;
	rx: number;
	ry: number;
	count: number;
	activity: number;
	lobes: CloudLobe[];
	tint: number;
}

export interface CloudLayout {
	nodes: CloudNode[];
	blobs: CloudBlob[];
	width: number;
	height: number;
}

const MARGIN = 48;
const MIN_HEIGHT = 800;
const PADDING_X = 30;
const PADDING_Y = 26;
const SPACING_X = 88;
const SPACING_Y = 50;
const SPREAD = 0.6;
const MIN_HALF_WIDTH = 84;
const MIN_HALF_HEIGHT = 58;
const TITLE_PADDING = 14;
const TITLE_HALF_CHAR = 4.1;
const SEED_RADIUS = 0.72;
const SEED_GAP = 36;
const CLOUD_GAP = 26;
const CLOUD_GAP_SCALE = 6;
const SEPARATION_PASSES = 80;
const BLOB_SPREAD = 0.44;
const BLOB_LOBE = 0.5;
const LOBE_COUNT = 4;

interface PreparedGroup {
	group: CloudGroup;
	nodes: Array<{ path: string; x: number; y: number }>;
	halfWidth: number;
	halfHeight: number;
}

interface PlacedCloud {
	prepared: PreparedGroup;
	cx: number;
	cy: number;
	padding: number;
}

/** Label brightness ramps with link count: hub notes read brightest, the rest stay legible. */
export function labelAlpha(degree: number, maxDegree: number): number {
	if (maxDegree <= 0) return 1;
	const ratio = Math.sqrt(Math.max(0, Math.min(degree, maxDegree)) / maxDegree);
	return 0.8 + 0.2 * ratio;
}

export function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function gaussian(random: () => number): number {
	const first = Math.max(random(), Number.EPSILON);
	return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * random());
}

// Lobes stay inside the blob box: spread + lobe radius never exceeds 1.
function makeLobes(rx: number, ry: number, random: () => number): CloudLobe[] {
	const lobes: CloudLobe[] = [{ dx: 0, dy: 0, rx, ry }];
	for (let index = 0; index < LOBE_COUNT; index++) {
		const angle = (index / LOBE_COUNT) * Math.PI * 2 + random() * 0.7;
		const spread = BLOB_SPREAD - random() * 0.14;
		const scaleX = BLOB_LOBE - random() * 0.1;
		const scaleY = BLOB_LOBE - random() * 0.08;
		lobes.push({
			dx: Math.cos(angle) * rx * spread,
			dy: Math.sin(angle) * ry * spread,
			rx: rx * scaleX,
			ry: ry * scaleY,
		});
	}
	return lobes;
}

/** Clouds are sized by their contents so the simulation has room to separate notes. */
function cloudExtent(count: number, title: string): { rx: number; ry: number } {
	const root = Math.sqrt(Math.max(count, 1));
	return {
		rx: Math.max(MIN_HALF_WIDTH, TITLE_PADDING + title.length * TITLE_HALF_CHAR, PADDING_X + SPACING_X * root * SPREAD),
		ry: Math.max(MIN_HALF_HEIGHT, PADDING_Y + SPACING_Y * root * SPREAD),
	};
}

/** Air around a cloud grows with what it holds, so big clouds are not boxed in. */
function cloudPadding(count: number): number {
	return CLOUD_GAP + CLOUD_GAP_SCALE * Math.sqrt(Math.max(count, 1));
}

/** Distance from an ellipse centre to its boundary along a unit direction. */
function boundaryDistance(rx: number, ry: number, ux: number, uy: number): number {
	const denominator = Math.hypot(ux / rx, uy / ry);
	return denominator === 0 ? 0 : 1 / denominator;
}

/**
 * Separate clouds until their padded ellipses no longer touch. Seeded by a shelf
 * pack, then relaxed, so the result reads organically instead of as a rigid grid
 * while still guaranteeing overlap-free placement.
 */
function separateClouds(clouds: PlacedCloud[], passes: number): void {
	for (let pass = 0; pass < passes; pass++) {
		for (let index = 0; index < clouds.length; index++) {
			const a = clouds[index];
			if (!a) continue;
			for (let peer = index + 1; peer < clouds.length; peer++) {
				const b = clouds[peer];
				if (!b) continue;
				let dx = b.cx - a.cx;
				let dy = b.cy - a.cy;
				let distance = Math.hypot(dx, dy);
				if (distance < 1e-3) {
					dx = index % 2 === 0 ? 1 : -1;
					dy = 0.6;
					distance = Math.hypot(dx, dy);
				}
				const ux = dx / distance;
				const uy = dy / distance;
				const required =
					boundaryDistance(a.prepared.halfWidth, a.prepared.halfHeight, ux, uy) +
					boundaryDistance(b.prepared.halfWidth, b.prepared.halfHeight, ux, uy) +
					a.padding +
					b.padding;
				if (distance >= required) continue;
				const push = (required - distance) / 2;
				a.cx -= ux * push;
				a.cy -= uy * push;
				b.cx += ux * push;
				b.cy += uy * push;
			}
		}
	}
}

function prepareGroup(group: CloudGroup): PreparedGroup {
	const count = group.count ?? group.notes.length;
	const { rx, ry } = cloudExtent(count, `${group.name} · ${count}`);
	const prefix = group.path ? `${group.path}/` : '';
	const children = [...new Set(group.notes.map((note) => note.path.slice(prefix.length).split('/').length > 1
		? note.path.slice(prefix.length).split('/')[0] : ''))].filter(Boolean).sort();
	const nodes: Array<{ path: string; x: number; y: number }> = group.notes.map((note) => {
		const random = makeRandom(hashString(note.path));
		const child = note.path.slice(prefix.length).split('/')[0];
		const index = note.path.slice(prefix.length).includes('/') ? children.indexOf(child ?? '') : -1;
		const angle = (index / Math.max(1, children.length)) * 2 * Math.PI;
		let x = index < 0 ? gaussian(random) * rx * 0.15 : Math.cos(angle) * rx * 0.42 + gaussian(random) * rx * 0.12;
		let y = index < 0 ? gaussian(random) * ry * 0.15 : Math.sin(angle) * ry * 0.42 + gaussian(random) * ry * 0.12;
		const ratio = Math.hypot(x / (rx * SEED_RADIUS), y / (ry * SEED_RADIUS));
		if (ratio > 1) {
			const scale = 1 / ratio;
			x *= scale;
			y *= scale;
		}
		return { path: note.path, x, y };
	});
	return { group, nodes, halfWidth: rx, halfHeight: ry };
}

export function layoutClouds(groups: CloudGroup[], width: number): CloudLayout {
	const prepared = groups.map(prepareGroup);
	const placed: PlacedCloud[] = [];
	let cursorX = MARGIN;
	let cursorY = MARGIN;
	let rowHeight = 0;

	for (const group of prepared) {
		const itemWidth = group.halfWidth * 2;
		const itemHeight = group.halfHeight * 2;
		if (cursorX > MARGIN && cursorX + itemWidth > width - MARGIN) {
			cursorX = MARGIN;
			cursorY += rowHeight + SEED_GAP;
			rowHeight = 0;
		}
		placed.push({
			prepared: group,
			cx: cursorX + group.halfWidth,
			cy: cursorY + group.halfHeight,
			padding: cloudPadding(group.group.count ?? group.group.notes.length),
		});
		cursorX += itemWidth + SEED_GAP;
		rowHeight = Math.max(rowHeight, itemHeight);
	}

	separateClouds(placed, SEPARATION_PASSES);

	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	for (const cloud of placed) {
		left = Math.min(left, cloud.cx - cloud.prepared.halfWidth - cloud.padding);
		top = Math.min(top, cloud.cy - cloud.prepared.halfHeight - cloud.padding);
	}
	if (!Number.isFinite(left)) {
		left = MARGIN;
		top = MARGIN;
	}

	const nodes: CloudNode[] = [];
	const blobs: CloudBlob[] = [];
	let height = MIN_HEIGHT;
	for (const [cloudIndex, cloud] of placed.entries()) {
		const cx = cloud.cx - left + MARGIN;
		const cy = cloud.cy - top + MARGIN;
		for (const node of cloud.prepared.nodes) {
			nodes.push({ path: node.path, x: cx + node.x, y: cy + node.y, cloud: cloudIndex });
		}
		const lobeSeed = makeRandom(hashString(`${cloud.prepared.group.path}:lobes`));
		blobs.push({
			path: cloud.prepared.group.path,
			name: cloud.prepared.group.name,
			folder: cloud.prepared.group.folder,
			cx,
			cy,
			rx: cloud.prepared.halfWidth,
			ry: cloud.prepared.halfHeight,
			count: cloud.prepared.group.count ?? cloud.prepared.group.notes.length,
			activity: cloud.prepared.group.activity ?? 0,
			lobes: makeLobes(cloud.prepared.halfWidth, cloud.prepared.halfHeight, lobeSeed),
			tint: lobeSeed(),
		});
		height = Math.max(height, cy + cloud.prepared.halfHeight + cloud.padding + MARGIN);
	}

	return { nodes, blobs, width, height };
}
