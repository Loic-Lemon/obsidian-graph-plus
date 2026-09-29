import assert from 'node:assert/strict';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { buildGraphData } = await jiti.import('../src/graph/model.ts');
const { buildGroups } = await jiti.import('../src/graph/data.ts');
const { labelAlpha, layoutClouds } = await jiti.import('../src/graph/layout.ts');
const { estimateLabelWidth, selectLabels } = await jiti.import('../src/graph/labels.ts');
const { PALETTES, cloudFill, resolvePalette } = await jiti.import('../src/graph/palettes.ts');
const { nodeRadius, cloudGrowth, glyphScale } = await jiti.import('../src/graph/scene.ts');
const { fitScale, frameScale, clampScale } = await jiti.import('../src/graph/navigator.ts');
const {
	forgetPinnedPosition,
	getPinnedPosition,
	loadPinnedPositions,
	onPinnedChange,
	serializePinnedPositions,
	setPinnedPosition,
} = await jiti.import('../src/graph/positions.ts');
const { Simulation, clampToCloud, containmentRatio } = await jiti.import('../src/graph/simulation.ts');

assert.deepEqual(buildGraphData([], [], [], 10), { notes: [], folders: [], edges: [] });

const graph = buildGraphData(
	[
		{ path: 'root.md', name: 'root', mtime: 5 },
		{ path: 'parent/child/newer.md', name: 'newer', mtime: 10 },
		{ path: 'parent/child/older.md', name: 'older', mtime: 2 },
		{ path: 'parent/same-time.md', name: 'same-time', mtime: 10 },
	],
	['empty', 'parent/child'],
	[
		{ sourcePath: 'root.md', targetPath: 'parent/child/newer.md' },
		{ sourcePath: 'root.md', targetPath: 'missing.md' },
		{ sourcePath: 'missing.md', targetPath: 'root.md' },
	],
	2,
);

assert.deepEqual(graph.notes.map(({ path, folderPath, recent }) => ({ path, folderPath, recent })), [
	{ path: 'parent/child/newer.md', folderPath: 'parent/child', recent: true },
	{ path: 'parent/child/older.md', folderPath: 'parent/child', recent: false },
	{ path: 'parent/same-time.md', folderPath: 'parent', recent: true },
	{ path: 'root.md', folderPath: '', recent: false },
]);
assert.deepEqual(graph.folders, [
	{ path: 'empty', name: 'empty', parentPath: '' },
	{ path: 'parent', name: 'parent', parentPath: '' },
	{ path: 'parent/child', name: 'child', parentPath: 'parent' },
]);
assert.deepEqual(graph.edges, [
	{ sourcePath: 'root.md', targetPath: 'parent/child/newer.md' },
]);
assert.deepEqual(graph.notes.map(({ path, degree }) => ({ path, degree })), [
	{ path: 'parent/child/newer.md', degree: 1 },
	{ path: 'parent/child/older.md', degree: 0 },
	{ path: 'parent/same-time.md', degree: 0 },
	{ path: 'root.md', degree: 1 },
]);

console.log('Graph model checks passed');

// Freshness decays with age: warm recent notes, cool stale ones.
const day = 86_400_000;
const now = Date.UTC(2026, 0, 31);
const aged = buildGraphData(
	[
		{ path: 'ancient.md', name: 'ancient', mtime: now - 365 * day },
		{ path: 'new.md', name: 'new', mtime: now },
		{ path: 'future.md', name: 'future', mtime: now + 5 * day },
		{ path: 'three-weeks.md', name: 'three-weeks', mtime: now - 21 * day },
	],
	[],
	[],
	10,
	now,
);
const freshness = (path) => {
	const note = aged.notes.find((candidate) => candidate.path === path);
	assert.ok(note, `note ${path} exists`);
	return note.freshness;
};
assert.ok(Math.abs(freshness('new.md') - 1) < 1e-9, 'a note touched now is fully fresh');
assert.equal(freshness('future.md'), 1, 'a timestamp ahead of now never exceeds full freshness');
assert.ok(Math.abs(freshness('three-weeks.md') - Math.exp(-1)) < 1e-9, 'freshness decays with age');
assert.ok(freshness('ancient.md') < 0.01, 'year-old notes read as cold');
assert.ok(freshness('ancient.md') > 0, 'freshness stays positive');
assert.ok(freshness('new.md') > freshness('three-weeks.md'), 'newer notes are warmer');

const groups = [
	{ path: 'alpha', name: 'alpha', folder: true, notes: Array.from({ length: 6 }, (_, index) => ({ path: `alpha/n${index}.md` })) },
	{ path: 'beta', name: 'beta', folder: true, notes: [{ path: 'beta/one.md' }] },
	{ path: '', name: 'Vault notes', folder: false, notes: [{ path: 'root.md' }] },
	{ path: 'empty', name: 'empty', folder: true, notes: [] },
];

const layout = layoutClouds(groups, 1200);
assert.deepEqual(layoutClouds(groups, 1200), layout, 'layout must be deterministic');
assert.equal(layout.blobs.length, groups.length);
assert.equal(layout.nodes.length, 8);
assert.equal(layout.width, 1200);
assert.ok(layout.height >= 800, 'layout keeps a minimum height');

for (const blob of layout.blobs) {
	assert.ok(blob.rx > 0 && blob.ry > 0 && Number.isFinite(blob.cx) && Number.isFinite(blob.cy));
	assert.equal(blob.lobes.length, 5, 'cloud is a base shape plus four lobes');
	assert.deepEqual(blob.lobes[0], { dx: 0, dy: 0, rx: blob.rx, ry: blob.ry });
	assert.ok(blob.tint >= 0 && blob.tint < 1, 'tint stays in range');
	assert.equal(blob.count, groups.find((item) => item.path === blob.path).notes.length, 'cloud carries its note count');
	for (const lobe of blob.lobes) {
		assert.ok(Math.abs(lobe.dx) + lobe.rx <= blob.rx + 1e-6, 'lobe stays inside the cloud box horizontally');
		assert.ok(Math.abs(lobe.dy) + lobe.ry <= blob.ry + 1e-6, 'lobe stays inside the cloud box vertically');
	}
	const group = groups.find((item) => item.path === blob.path);
	for (const { path } of group.notes) {
		const node = layout.nodes.find((item) => item.path === path);
		assert.ok(node, `missing node ${path}`);
		assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), `finite position ${path}`);
		assert.ok(Math.abs(node.x - blob.cx) <= blob.rx, `${path} escapes blob horizontally`);
		assert.ok(Math.abs(node.y - blob.cy) <= blob.ry, `${path} escapes blob vertically`);
	}
}

for (let first = 0; first < layout.blobs.length; first++) {
	for (let second = first + 1; second < layout.blobs.length; second++) {
		const a = layout.blobs[first];
		const b = layout.blobs[second];
		const overlaps = Math.abs(a.cx - b.cx) < a.rx + b.rx && Math.abs(a.cy - b.cy) < a.ry + b.ry;
		assert.ok(!overlaps, `blobs overlap: ${a.path || 'notes'} and ${b.path || 'notes'}`);
		const gapX = Math.abs(a.cx - b.cx) - (a.rx + b.rx);
		const gapY = Math.abs(a.cy - b.cy) - (a.ry + b.ry);
		assert.ok(gapX >= 40 || gapY >= 40, `clouds too close: ${a.path || 'notes'} and ${b.path || 'notes'}`);
	}
}

const crowded = layoutClouds([{ path: 'big', name: 'big', folder: true, notes: Array.from({ length: 40 }, (_, index) => ({ path: `big/n${index}.md` })) }], 1200);
assert.equal(crowded.nodes.length, 40, 'every note is seeded');
assert.ok(crowded.blobs[0].rx > 300, 'cloud grows with its contents');

assert.equal(labelAlpha(0, 0), 1, 'a cloud with no links keeps full-brightness labels');
assert.ok(Math.abs(labelAlpha(0, 5) - 0.8) < 1e-9, 'unlinked notes stay legible rather than dim');
assert.ok(Math.abs(labelAlpha(5, 5) - 1) < 1e-9, 'the most linked note is brightest');
assert.ok(labelAlpha(2, 5) > labelAlpha(1, 5), 'label brightness rises with link count');
assert.equal(labelAlpha(9, 5), labelAlpha(5, 5), 'label brightness is clamped above the maximum');

console.log('Graph layout checks passed');

const cloud = { cx: 0, cy: 0, rx: 200, ry: 130 };
const makeNodes = (count) =>
	Array.from({ length: count }, (_, index) => ({
		x: (index % 4) * 6,
		y: Math.floor(index / 4) * 5,
		vx: 0,
		vy: 0,
		cloud: 0,
		radius: 8,
		pinned: false,
	}));
const settle = (simulation) => {
	let steps = 0;
	while (simulation.isActive() && steps < 4000) {
		simulation.step();
		steps++;
	}
	return steps;
};

const plainNode = { x: 60, y: 0, vx: 0, vy: 0, cloud: 0, radius: 8, pinned: false };
const free = new Simulation([{ ...plainNode }], [{ cx: 100, cy: 0, rx: 200, ry: 130 }], []);
const anchored = new Simulation([{ ...plainNode, anchorX: 0, anchorY: 0 }], [{ cx: 100, cy: 0, rx: 200, ry: 130 }], []);
free.step();
anchored.step();
assert.ok(anchored.nodes[0].x < free.nodes[0].x, 'nested notes stay drawn toward their subfolder');

const links = [
	{ source: 0, target: 1 },
	{ source: 1, target: 2 },
];
const firstSimulation = new Simulation(makeNodes(6), [cloud], links);
const firstSteps = settle(firstSimulation);
const secondSimulation = new Simulation(makeNodes(6), [cloud], links);
settle(secondSimulation);
assert.ok(!firstSimulation.isActive(), `simulation settles (${firstSteps} steps)`);
assert.deepEqual(
	firstSimulation.nodes.map((node) => [node.x, node.y]),
	secondSimulation.nodes.map((node) => [node.x, node.y]),
	'simulation is deterministic',
);
for (const node of firstSimulation.nodes) {
	assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'finite node position');
	assert.ok(containmentRatio(cloud, node.x, node.y) <= 1 + 1e-9, 'node stays inside its cloud');
}
let minGap = Infinity;
for (let index = 0; index < firstSimulation.nodes.length; index++) {
	for (let peer = index + 1; peer < firstSimulation.nodes.length; peer++) {
		minGap = Math.min(
			minGap,
			Math.hypot(
				firstSimulation.nodes[peer].x - firstSimulation.nodes[index].x,
				firstSimulation.nodes[peer].y - firstSimulation.nodes[index].y,
			),
		);
	}
}
assert.ok(minGap > 10, `stacked notes separate (min gap ${minGap.toFixed(1)})`);

const stretched = new Simulation(
	[
		{ x: -180, y: 0, vx: 0, vy: 0, cloud: 0, radius: 8, pinned: false },
		{ x: 180, y: 0, vx: 0, vy: 0, cloud: 0, radius: 8, pinned: false },
	],
	[cloud],
	[{ source: 0, target: 1 }],
);
settle(stretched);
const settledDistance = Math.abs(stretched.nodes[1].x - stretched.nodes[0].x);
assert.ok(settledDistance < 360, `links pull connected notes together (${settledDistance.toFixed(1)})`);

const dragged = new Simulation(makeNodes(3), [cloud], []);
dragged.dragTo(0, 5000, 5000);
const pinnedNode = dragged.nodes[0];
assert.ok(containmentRatio(cloud, pinnedNode.x, pinnedNode.y) <= 1 + 1e-9, 'dragged node is clamped inside its cloud');
const heldX = pinnedNode.x;
const heldY = pinnedNode.y;
for (let step = 0; step < 300; step++) dragged.step();
assert.ok(
	Math.abs(pinnedNode.x - heldX) < 1e-6 && Math.abs(pinnedNode.y - heldY) < 1e-6,
	'dragged node stays where it was dropped',
);
assert.deepEqual(clampToCloud(cloud, 1000, 0), { x: 200, y: 0 }, 'clamping keeps notes on the cloud wall');

// Gravity: the cloud centre is each note's default attractor.
const lone = new Simulation([{ x: 190, y: 0, vx: 0, vy: 0, cloud: 0, radius: 8, pinned: false }], [cloud], []);
settle(lone);
assert.ok(
	containmentRatio(cloud, lone.nodes[0].x, lone.nodes[0].y) < 0.2,
	`a lone note falls to its cloud centre (ratio ${containmentRatio(cloud, lone.nodes[0].x, lone.nodes[0].y).toFixed(3)})`,
);

const gathered = new Simulation(makeNodes(6), [cloud], links);
settle(gathered);
const meanRatio =
	gathered.nodes.reduce((sum, node) => sum + containmentRatio(cloud, node.x, node.y), 0) / gathered.nodes.length;
assert.ok(meanRatio < 0.8, `notes gather around the cloud centre (mean ratio ${meanRatio.toFixed(2)})`);

console.log('Graph simulation checks passed');

assert.ok(estimateLabelWidth('a much longer note name') > estimateLabelWidth('short'), 'longer names estimate wider');
assert.equal(estimateLabelWidth(''), 22, 'width estimate has a floor');

const spaced = [
	{ path: 'a.md', left: 0, top: 0, right: 40, bottom: 18, priority: 1 },
	{ path: 'b.md', left: 200, top: 0, right: 240, bottom: 18, priority: 1 },
	{ path: 'c.md', left: 400, top: 0, right: 440, bottom: 18, priority: 1 },
];
assert.equal(selectLabels(spaced).visible.size, 3, 'labels in free space all show');
assert.equal(selectLabels(spaced).culled, 0, 'nothing is culled when there is room');

const contestedPair = [
	{ path: 'low.md', left: 0, top: 0, right: 100, bottom: 18, priority: 0 },
	{ path: 'hub.md', left: 20, top: 0, right: 120, bottom: 18, priority: 9 },
];
const contested = selectLabels(contestedPair);
assert.ok(contested.visible.has('hub.md'), 'the busiest note keeps its name');
assert.ok(!contested.visible.has('low.md'), 'the colliding quiet note is culled');
assert.equal(contested.culled, 1, 'a culled label is reported');
assert.deepEqual([...selectLabels(contestedPair).visible], [...contested.visible], 'label selection is deterministic');

const many = Array.from({ length: 6 }, (_, index) => ({
	path: `n${index}.md`,
	left: index * 300,
	top: 0,
	right: index * 300 + 40,
	bottom: 18,
	priority: index,
}));
const capped = selectLabels(many, 2);
assert.equal(capped.visible.size, 2, 'the zoomed-out cap limits how many names show');
assert.ok(capped.visible.has('n5.md') && capped.visible.has('n4.md'), 'the cap keeps the highest-priority names');
assert.equal(selectLabels([]).visible.size, 0, 'no labels for no notes');

// The crowding case this exists for: a dense cloud of long titles.
const dense = layoutClouds(
	[
		{
			path: 'dense',
			name: 'dense',
			folder: true,
			notes: Array.from({ length: 40 }, (_, index) => ({ path: `dense/note-${index}-with-a-longer-title.md` })),
		},
	],
	1200,
);
const denseBoxes = new Map(
	dense.nodes.map((node, index) => {
		const width = estimateLabelWidth(`note-${index}-with-a-longer-title`);
		const left = node.x + 8;
		return [
			node.path,
			{ path: node.path, left, top: node.y - 9, right: left + width, bottom: node.y + 9, priority: index },
		];
	}),
);
const crowdedSelection = selectLabels([...denseBoxes.values()]);
assert.ok(crowdedSelection.visible.size > 0, 'a dense cloud still shows names');
assert.ok(
	crowdedSelection.visible.size < 40,
	`a dense cloud hides colliding names (${crowdedSelection.visible.size}/40 shown)`,
);
const shown = [...crowdedSelection.visible].map((path) => denseBoxes.get(path));
for (let index = 0; index < shown.length; index++) {
	for (let peer = index + 1; peer < shown.length; peer++) {
		const a = shown[index];
		const b = shown[peer];
		const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
		assert.ok(!overlaps, `shown labels never overlap (${a.path} vs ${b.path})`);
	}
}

// Cloud spacing is dynamic: contents decide the air, so gaps differ per pair.
const mixed = layoutClouds(
	[
		{ path: 'one', name: 'one', folder: true, notes: [{ path: 'one/a.md' }] },
		{ path: 'few', name: 'few', folder: true, notes: Array.from({ length: 4 }, (_, index) => ({ path: `few/n${index}.md` })) },
		{ path: 'mid', name: 'mid', folder: true, notes: Array.from({ length: 12 }, (_, index) => ({ path: `mid/n${index}.md` })) },
		{ path: 'many', name: 'many', folder: true, notes: Array.from({ length: 30 }, (_, index) => ({ path: `many/n${index}.md` })) },
	],
	1200,
);
for (let first = 0; first < mixed.blobs.length; first++) {
	for (let second = first + 1; second < mixed.blobs.length; second++) {
		const a = mixed.blobs[first];
		const b = mixed.blobs[second];
		const overlaps = Math.abs(a.cx - b.cx) < a.rx + b.rx && Math.abs(a.cy - b.cy) < a.ry + b.ry;
		assert.ok(!overlaps, `relaxed clouds stay separate (${a.path} vs ${b.path})`);
	}
}
const gaps = [];
for (let first = 0; first < mixed.blobs.length; first++) {
	for (let second = first + 1; second < mixed.blobs.length; second++) {
		const a = mixed.blobs[first];
		const b = mixed.blobs[second];
		gaps.push(Math.hypot(a.cx - b.cx, a.cy - b.cy) - (a.rx + b.rx));
	}
}
const spread = Math.max(...gaps) - Math.min(...gaps);
assert.ok(spread > 10, `cloud gaps vary instead of forming a fixed grid (${Math.min(...gaps).toFixed(0)}..${Math.max(...gaps).toFixed(0)})`);
assert.deepEqual(layoutClouds(mixed.blobs.map((blob) => ({ path: blob.path, name: blob.name, folder: blob.folder, notes: Array.from({ length: blob.count }, (_, index) => ({ path: `${blob.path}/seed${index}.md` })) })), 1200).blobs.map((blob) => [blob.cx, blob.cy]), mixed.blobs.map((blob) => [blob.cx, blob.cy]), 'cloud arrangement is deterministic');

console.log('Graph label checks passed');

// Palettes: every scheme resolves to a real colour, and ids survive renaming.
assert.ok(PALETTES.length >= 12, `plenty of palettes ship (${PALETTES.length})`);
const sample = { path: 'areas/projects', count: 12, depth: 2, activity: 0.5 };
for (const palette of PALETTES) {
	const fill = cloudFill(palette.id, sample);
	assert.ok(/^(#|hsl\(|rgb\(|var\()/.test(fill), `${palette.id} returns a CSS colour (${fill})`);
	assert.equal(resolvePalette(palette.id).id, palette.id, `${palette.id} resolves to itself`);
}
assert.equal(resolvePalette('folders').id, 'hues', 'the renamed palette still resolves');
assert.equal(resolvePalette('does-not-exist').id, 'accent', 'an unknown palette falls back to the accent');
assert.equal(resolvePalette(undefined).id, 'accent', 'a missing palette falls back to the accent');
const hueOf = (fill) => Number(fill.replace(/^hsl\(/, '').split(',')[0]);
const coldHue = hueOf(cloudFill('activity', { ...sample, activity: 0 }));
const warmHue = hueOf(cloudFill('activity', { ...sample, activity: 1 }));
assert.ok(warmHue < coldHue, `busier folders read warmer (${coldHue} -> ${warmHue})`);
assert.equal(glyphScale(1), 1);
assert.equal(glyphScale(4) * 4, 1, 'dots and labels stay a stable screen size while zooming');
assert.ok(cloudGrowth(4) > cloudGrowth(1), 'cloud grows while zooming');
assert.ok(cloudGrowth(8) <= 1.35, 'cloud expansion stays bounded');
assert.ok(nodeRadius(9, 1.5) > nodeRadius(9, 1), 'node size scales the dot');
assert.ok(Math.abs(nodeRadius(0, 1) - 5) < 1e-9, 'an unlinked note keeps the base radius');

console.log('Graph palette checks passed');

// Folder nesting: every level exposes its own subfolders and its direct notes.
const nested = buildGraphData(
	[
		{ path: 'a/b/c/three.md', name: 'three', mtime: 100 },
		{ path: 'a/b/two.md', name: 'two', mtime: 100 },
		{ path: 'a/one.md', name: 'one', mtime: 100 },
		{ path: 'other/four.md', name: 'four', mtime: 100 },
		{ path: 'root.md', name: 'root', mtime: 100 },
	],
	['a', 'a/b', 'a/b/c', 'empty', 'other'],
	[],
	10,
);
const rootGroups = buildGroups(nested, '');
assert.deepEqual(
	rootGroups.map((group) => group.path),
	['a', 'empty', 'other', ''],
	'root shows every top-level folder, plus vault notes',
);
assert.equal(rootGroups[0].count, 3, 'top-level folder count includes all descendant notes');
assert.deepEqual(rootGroups[0].notes.map((note) => note.path), ['a/one.md', 'a/b/c/three.md', 'a/b/two.md'], 'overview contains all nested notes');
const aGroups = buildGroups(nested, 'a');
assert.deepEqual(aGroups.map((group) => group.path), ['a/b', ''], 'focusing a folder reveals its subfolders');
assert.deepEqual(
	aGroups[0].notes.map((note) => note.path),
	['a/b/two.md', 'a/b/c/three.md'],
	'a subfolder cloud shows all descendant notes',
);
assert.equal(aGroups[0].count, 2, 'folder count includes notes in deeper subfolders');
assert.deepEqual(aGroups[1].notes.map((note) => note.path), ['a/one.md'], 'direct notes stay at the focused level');
const bGroups = buildGroups(nested, 'a/b');
assert.deepEqual(bGroups.map((group) => group.path), ['a/b/c', ''], 'nesting keeps working two levels down');
assert.deepEqual(
	bGroups[0].notes.map((note) => note.path),
	['a/b/c/three.md'],
	'a deep subfolder still carries its own note',
);
assert.deepEqual(buildGroups(nested, 'empty'), [], 'a folder with nothing in it draws no clouds of its own');
assert.deepEqual(buildGroups(nested, 'missing'), [], 'an unknown focus path draws nothing');
assert.ok(
	rootGroups.every((group) => typeof group.activity === 'number' && group.activity >= 0),
	'every cloud carries its activity for the activity palette',
);

console.log('Graph folder checks passed');

// Pinned positions: only deliberately dragged notes are stored, and bad data is ignored.
loadPinnedPositions(undefined);
assert.deepEqual(serializePinnedPositions(), {}, 'no pinned positions to start with');
loadPinnedPositions({ 'a.md': { x: 1, y: 2 }, 'bad.md': { x: 'nope' }, worse: 5 });
assert.deepEqual(serializePinnedPositions(), { 'a.md': { x: 1, y: 2 } }, 'only valid pinned positions load');
assert.deepEqual(getPinnedPosition('a.md'), { x: 1, y: 2 }, 'a pinned position reads back');
assert.equal(getPinnedPosition('bad.md'), undefined, 'malformed entries are dropped');
let notifications = 0;
const unsubscribe = onPinnedChange(() => {
	notifications += 1;
});
setPinnedPosition('b.md', 3, 4);
assert.equal(notifications, 1, 'pinning a note notifies once');
assert.deepEqual(
	serializePinnedPositions(),
	{ 'a.md': { x: 1, y: 2 }, 'b.md': { x: 3, y: 4 } },
	'pinned positions round-trip through the saved payload',
);
forgetPinnedPosition('a.md');
assert.equal(notifications, 2, 'forgetting a position notifies');
unsubscribe();
setPinnedPosition('c.md', 5, 6);
assert.equal(notifications, 2, 'unsubscribing stops notifications');

// Viewport math: fit shows everything, framing keeps a focused level readable.
const content = { width: 1200, height: 2400 };
const view = { width: 1200, height: 800 };
assert.ok(Math.abs(fitScale(content, view) - 800 / 2400) < 1e-9, 'fit is limited by the tighter axis');
assert.equal(fitScale({ width: 100, height: 100 }, view), 1, 'fit never magnifies past 1:1');
assert.ok(Math.abs(frameScale(content, view) - 0.55) < 1e-9, 'framing clamps to the readable floor');
assert.equal(frameScale({ width: 100, height: 100 }, { width: 1000, height: 700 }), 1, 'framing never magnifies past 1:1');
assert.equal(clampScale(99), 32, 'zoom allows deep nesting but stays capped');
assert.equal(clampScale(0.01), 0.05, 'zoom is floored');

console.log('Graph state checks passed');
