export interface Point {
	x: number;
	y: number;
}

export interface Size {
	width: number;
	height: number;
}

/** Wide enough to feel like an endless canvas: far out for the whole vault, far in for one note. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 32;
export const FRAME_MIN_SCALE = 0.55;
const DRAG_THRESHOLD = 4;
const ANIMATION_MS = 260;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

interface Camera {
	scale: number;
	offsetX: number;
	offsetY: number;
}

function prefersReducedMotion(): boolean {
	return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
		? window.matchMedia(REDUCED_MOTION_QUERY).matches
		: false;
}

export function clampScale(scale: number): number {
	return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
}

/** Whole-graph view, never magnifying past 1:1. */
export function fitScale(content: Size, view: Size): number {
	return clampScale(Math.min(view.width / content.width, view.height / content.height, 1));
}

/** A newly focused level, bounded so the result stays readable. */
export function frameScale(content: Size, view: Size): number {
	const fit = Math.min(view.width / content.width, view.height / content.height);
	return Math.min(1, Math.max(FRAME_MIN_SCALE, fit));
}

export interface NavigatorHost {
	layer: () => SVGGElement | undefined;
	refreshLabels: () => void;
	resolveNote: (target: Element) => { index: number; path: string } | undefined;
	resolveNotePath: (target: Element) => string | undefined;
	nodePosition: (index: number) => Point | undefined;
	moveNode: (index: number, x: number, y: number) => void;
	wakeSimulation: (alpha?: number) => void;
	markDragging: (index: number, dragging: boolean) => void;
	openNote: (path: string) => void;
}

interface DragState {
	pointerId: number;
	x: number;
	y: number;
	originX: number;
	originY: number;
	moved: boolean;
	nodeIndex?: number;
	nodePath?: string;
	grabX: number;
	grabY: number;
}

/**
 * Owns pan, zoom and note dragging. Movement under the drag threshold counts as a
 * click, so the same pointer gesture both pans the canvas and opens notes.
 */
export class GraphNavigator {
	private scale = 1;
	private offsetX = 0;
	private offsetY = 0;
	private drag: DragState | undefined;
	private animation: number | undefined;

	constructor(
		private svg: SVGSVGElement,
		private host: NavigatorHost,
	) {
		this.attach();
	}

	get currentScale(): number {
		return this.scale;
	}

	toLocal(point: Point): Point {
		return { x: (point.x - this.offsetX) / this.scale, y: (point.y - this.offsetY) / this.scale };
	}

	apply(): void {
		this.host.layer()?.setAttribute('transform', `translate(${this.offsetX} ${this.offsetY}) scale(${this.scale})`);
	}

	placeTopLeft(content: Size, view: Size): void {
		this.animateTo({ scale: 1, offsetX: Math.max(0, (view.width - content.width) / 2), offsetY: 0 });
	}

	fit(content: Size, view: Size): void {
		this.animateTo(this.targetFor(fitScale(content, view), content, view));
	}

	frame(content: Size, view: Size): void {
		this.animateTo(this.targetFor(frameScale(content, view), content, view));
	}

	private targetFor(scale: number, content: Size, view: Size): Camera {
		return {
			scale,
			offsetX: (view.width - content.width * scale) / 2,
			offsetY: (view.height - content.height * scale) / 2,
		};
	}

	/** Eases the camera, so focusing a folder reads as movement rather than a jump. */
	private animateTo(target: Camera): void {
		this.cancelAnimation();
		if (prefersReducedMotion()) {
			this.setCamera(target);
			return;
		}
		const from: Camera = { scale: this.scale, offsetX: this.offsetX, offsetY: this.offsetY };
		const started = window.performance.now();
		const step = () => {
			const progress = Math.min(1, (window.performance.now() - started) / ANIMATION_MS);
			const eased = 1 - (1 - progress) ** 3;
			this.setCamera({
				scale: from.scale + (target.scale - from.scale) * eased,
				offsetX: from.offsetX + (target.offsetX - from.offsetX) * eased,
				offsetY: from.offsetY + (target.offsetY - from.offsetY) * eased,
			});
			this.animation = progress < 1 ? window.requestAnimationFrame(step) : undefined;
		};
		this.animation = window.requestAnimationFrame(step);
	}

	private cancelAnimation(): void {
		if (this.animation === undefined) return;
		window.cancelAnimationFrame(this.animation);
		this.animation = undefined;
	}

	private setCamera(camera: Camera): void {
		this.scale = camera.scale;
		this.offsetX = camera.offsetX;
		this.offsetY = camera.offsetY;
		this.apply();
		this.host.refreshLabels();
	}

	private zoomAt(point: Point, factor: number): void {
		const next = clampScale(this.scale * factor);
		const ratio = next / this.scale;
		this.offsetX = point.x - ratio * (point.x - this.offsetX);
		this.offsetY = point.y - ratio * (point.y - this.offsetY);
		this.scale = next;
	}

	private toSvgPoint(event: PointerEvent | WheelEvent): Point {
		const matrix = this.svg.getScreenCTM();
		if (matrix) {
			const point = this.svg.createSVGPoint();
			point.x = event.clientX;
			point.y = event.clientY;
			return point.matrixTransform(matrix.inverse());
		}
		const bounds = this.svg.getBoundingClientRect();
		return {
			x: ((event.clientX - bounds.left) / bounds.width) * this.svg.viewBox.baseVal.width,
			y: ((event.clientY - bounds.top) / bounds.height) * this.svg.viewBox.baseVal.height,
		};
	}

	private attach(): void {
		const svg = this.svg;
		svg.addEventListener('pointerdown', (event) => {
			// Only the primary button drags, pans or clicks; right-click must reach
			// the context menu instead of being captured as a drag.
			if (event.button !== 0) return;
			if ((event.target as Element).closest('.graph-plus-folder-action, .graph-plus-inner-cloud-title')) return;
			this.cancelAnimation();
			const point = this.toSvgPoint(event);
			const target = event.target as Element;
			const notePath = this.host.resolveNotePath(target);
			const note = target.closest('.graph-plus-note-dot') ? this.host.resolveNote(target) : undefined;
			const local = this.toLocal(point);
			const node = note ? this.host.nodePosition(note.index) : undefined;
			this.drag = {
				pointerId: event.pointerId,
				x: point.x,
				y: point.y,
				originX: this.offsetX,
				originY: this.offsetY,
				moved: false,
				nodeIndex: note?.index,
				nodePath: notePath,
				grabX: node ? node.x - local.x : 0,
				grabY: node ? node.y - local.y : 0,
			};
			svg.setPointerCapture(event.pointerId);
		});
		svg.addEventListener('pointermove', (event) => {
			const drag = this.drag;
			if (!drag || drag.pointerId !== event.pointerId) return;
			const point = this.toSvgPoint(event);
			if (Math.hypot(point.x - drag.x, point.y - drag.y) > DRAG_THRESHOLD) drag.moved = true;
			if (drag.nodeIndex !== undefined) {
				if (!drag.moved) return;
				const local = this.toLocal(point);
				this.host.moveNode(drag.nodeIndex, local.x + drag.grabX, local.y + drag.grabY);
				this.host.markDragging(drag.nodeIndex, true);
				this.host.wakeSimulation();
				return;
			}
			if (!drag.moved) return;
			this.offsetX = drag.originX + point.x - drag.x;
			this.offsetY = drag.originY + point.y - drag.y;
			svg.classList.add('is-panning');
			this.apply();
		});
		const finish = (event: PointerEvent) => {
			const drag = this.drag;
			if (!drag || drag.pointerId !== event.pointerId) return;
			this.drag = undefined;
			svg.classList.remove('is-panning');
			if (drag.nodeIndex !== undefined) {
				this.host.markDragging(drag.nodeIndex, false);
				if (drag.moved) this.host.wakeSimulation(0.5);
				else if (drag.nodePath) this.host.openNote(drag.nodePath);
				return;
			}
			if (!drag.moved && drag.nodePath) {
				this.host.openNote(drag.nodePath);
				return;
			}
		};
		svg.addEventListener('pointerup', finish);
		svg.addEventListener('pointercancel', (event) => {
			const drag = this.drag;
			if (!drag || drag.pointerId !== event.pointerId) return;
			this.drag = undefined;
			svg.classList.remove('is-panning');
			if (drag.nodeIndex !== undefined) this.host.markDragging(drag.nodeIndex, false);
		});
		svg.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault();
				this.cancelAnimation();
				this.zoomAt(this.toSvgPoint(event), event.deltaY < 0 ? 1.1 : 0.9);
				this.apply();
				this.host.refreshLabels();
			},
			{ passive: false },
		);
	}
}
