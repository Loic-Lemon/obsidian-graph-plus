export interface PinnedPosition {
	x: number;
	y: number;
}

// Only deliberately dragged notes are stored: everything else re-settles from the
// simulation, which keeps this map (and the saved plugin data) small.
const pinned = new Map<string, PinnedPosition>();
type Listener = () => void;
const listeners = new Set<Listener>();

function isPosition(value: unknown): value is PinnedPosition {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<PinnedPosition>;
	return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

export function loadPinnedPositions(raw: unknown): void {
	pinned.clear();
	if (typeof raw !== 'object' || raw === null) return;
	for (const [path, value] of Object.entries(raw)) {
		if (isPosition(value)) pinned.set(path, { x: value.x, y: value.y });
	}
}

export function serializePinnedPositions(): Record<string, PinnedPosition> {
	const out: Record<string, PinnedPosition> = {};
	for (const [path, position] of pinned) out[path] = { x: position.x, y: position.y };
	return out;
}

export function getPinnedPosition(path: string): PinnedPosition | undefined {
	return pinned.get(path);
}

export function setPinnedPosition(path: string, x: number, y: number): void {
	pinned.set(path, { x, y });
	for (const listener of [...listeners]) listener();
}

export function forgetPinnedPosition(path: string): void {
	if (!pinned.delete(path)) return;
	for (const listener of [...listeners]) listener();
}

/** Used by the plugin to persist changes; returns an unsubscribe. */
export function onPinnedChange(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
