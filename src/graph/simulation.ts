export interface SimulationNode {
	x: number;
	y: number;
	vx: number;
	vy: number;
	cloud: number;
	radius: number;
	pinned: boolean;
	anchorX?: number;
	anchorY?: number;
}

export interface SimulationCloud {
	cx: number;
	cy: number;
	rx: number;
	ry: number;
}

export interface SimulationLink {
	source: number;
	target: number;
}

export interface SimulationParams {
	/** Label-aware collision box: notes read as wide-short boxes, not circles. */
	collisionX: number;
	collisionY: number;
	collisionStrength: number;
	repulsion: number;
	/** Radial spring in normalized cloud space: the cloud centre is each note's gravitational centre. */
	gravity: number;
	linkDistance: number;
	linkStrength: number;
	wallStart: number;
	wallStrength: number;
	damping: number;
	maxSpeed: number;
	alphaDecay: number;
	alphaStop: number;
}

// ponytail: hand-tuned constants, no force-layout dependency. If a vault reads
// too loose or too tight, change collisionX/collisionY and repulsion first;
// raise gravity to gather notes closer to their cloud centre.
export const DEFAULT_SIMULATION: SimulationParams = {
	collisionX: 38,
	collisionY: 14,
	collisionStrength: 1.4,
	repulsion: 2600,
	gravity: 3.2,
	linkDistance: 100,
	linkStrength: 0.22,
	wallStart: 0.9,
	wallStrength: 1.8,
	damping: 0.82,
	maxSpeed: 8,
	alphaDecay: 0.985,
	alphaStop: 0.02,
};

export function containmentRatio(cloud: SimulationCloud, x: number, y: number): number {
	return Math.hypot((x - cloud.cx) / cloud.rx, (y - cloud.cy) / cloud.ry);
}

/** Keeps a node inside its cloud ellipse, so clouds stay meaningful containers. */
export function clampToCloud(cloud: SimulationCloud, x: number, y: number): { x: number; y: number } {
	const ratio = containmentRatio(cloud, x, y);
	if (ratio <= 1 || ratio === 0) return { x, y };
	const scale = 1 / ratio;
	return { x: cloud.cx + (x - cloud.cx) * scale, y: cloud.cy + (y - cloud.cy) * scale };
}

export class Simulation {
	alpha = 1;
	private forceX: Float64Array;
	private forceY: Float64Array;

	constructor(
		public nodes: SimulationNode[],
		public clouds: SimulationCloud[],
		public links: SimulationLink[],
		public params: SimulationParams = DEFAULT_SIMULATION,
	) {
		this.forceX = new Float64Array(nodes.length);
		this.forceY = new Float64Array(nodes.length);
	}

	wake(alpha = 1): void {
		this.alpha = Math.max(this.alpha, alpha);
	}

	isActive(): boolean {
		return this.alpha > this.params.alphaStop;
	}

	/** Drag pins a node to the pointer while the rest of its cloud makes room. */
	dragTo(index: number, x: number, y: number): void {
		const node = this.nodes[index];
		if (!node) return;
		const cloud = this.clouds[node.cloud];
		const clamped = cloud ? clampToCloud(cloud, x, y) : { x, y };
		node.x = clamped.x;
		node.y = clamped.y;
		node.vx = 0;
		node.vy = 0;
		node.pinned = true;
		this.wake(0.45);
	}

	step(): void {
		const { nodes, clouds, links, params, forceX, forceY } = this;
		const alpha = this.alpha;
		forceX.fill(0);
		forceY.fill(0);

		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index];
			if (!node) continue;
			for (let peer = index + 1; peer < nodes.length; peer++) {
				const other = nodes[peer];
				if (!other || other.cloud !== node.cloud) continue;
				let dx = other.x - node.x;
				let dy = other.y - node.y;
				let distance = Math.hypot(dx, dy);
				if (distance < 1e-3) {
					dx = (index % 2 === 0 ? 1 : -1) * 0.6;
					dy = 0.6;
					distance = Math.hypot(dx, dy);
				}
				const unitX = dx / distance;
				const unitY = dy / distance;

				const spread = params.repulsion / (distance * distance);
				forceX[index] = (forceX[index] ?? 0) - unitX * spread;
				forceY[index] = (forceY[index] ?? 0) - unitY * spread;
				forceX[peer] = (forceX[peer] ?? 0) + unitX * spread;
				forceY[peer] = (forceY[peer] ?? 0) + unitY * spread;

				const reach = Math.hypot(dx / (params.collisionX * 2), dy / (params.collisionY * 2));
				if (reach < 1) {
					const push = (1 - reach) * params.collisionStrength;
					forceX[index] = (forceX[index] ?? 0) - unitX * push;
					forceY[index] = (forceY[index] ?? 0) - unitY * push;
					forceX[peer] = (forceX[peer] ?? 0) + unitX * push;
					forceY[peer] = (forceY[peer] ?? 0) + unitY * push;
				}
			}
		}

		for (const link of links) {
			const source = nodes[link.source];
			const target = nodes[link.target];
			if (!source || !target) continue;
			const dx = target.x - source.x;
			const dy = target.y - source.y;
			const distance = Math.hypot(dx, dy) || 1e-3;
			const pull = ((distance - params.linkDistance) / distance) * params.linkStrength;
			const fx = dx * pull;
			const fy = dy * pull;
			forceX[link.source] = (forceX[link.source] ?? 0) + fx;
			forceY[link.source] = (forceY[link.source] ?? 0) + fy;
			forceX[link.target] = (forceX[link.target] ?? 0) - fx;
			forceY[link.target] = (forceY[link.target] ?? 0) - fy;
		}

		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index];
			if (!node) continue;
			const cloud = clouds[node.cloud];
			if (cloud) {
				const nx = (node.x - cloud.cx) / cloud.rx;
				const ny = (node.y - cloud.cy) / cloud.ry;
				const ratio = Math.hypot(nx, ny);
				// Gravity: every note is pulled toward the centre of its own cloud.
				forceX[index] = (forceX[index] ?? 0) - nx * params.gravity + (node.anchorX === undefined ? 0 : (node.anchorX - node.x) * 0.04);
				forceY[index] = (forceY[index] ?? 0) - ny * params.gravity + (node.anchorY === undefined ? 0 : (node.anchorY - node.y) * 0.04);
				if (ratio > params.wallStart) {
					const wall = (ratio - params.wallStart) * params.wallStrength;
					forceX[index] = (forceX[index] ?? 0) - (nx / ratio) * wall * cloud.rx * 0.6;
					forceY[index] = (forceY[index] ?? 0) - (ny / ratio) * wall * cloud.ry * 0.6;
				}
			}

			if (!node.pinned) {
				const vx = ((node.vx + (forceX[index] ?? 0) * alpha) * params.damping);
				const vy = ((node.vy + (forceY[index] ?? 0) * alpha) * params.damping);
				const speed = Math.hypot(vx, vy);
				const scale = speed > params.maxSpeed ? params.maxSpeed / speed : 1;
				node.vx = vx * scale;
				node.vy = vy * scale;
				node.x += node.vx;
				node.y += node.vy;
			} else {
				node.vx = 0;
				node.vy = 0;
			}

			if (cloud) {
				const clamped = clampToCloud(cloud, node.x, node.y);
				node.x = clamped.x;
				node.y = clamped.y;
			}
		}

		this.alpha = Math.max(0, this.alpha * params.alphaDecay);
	}
}
