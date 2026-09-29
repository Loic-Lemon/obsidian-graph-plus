import { hashString } from './layout';

export interface PaletteInput {
	path: string;
	count: number;
	depth: number;
	/** 0 = untouched for a long time, 1 = edited today. */
	activity: number;
}

export interface CloudPaletteDefinition {
	id: string;
	label: string;
	fill: (input: PaletteInput) => string;
}

function hsl(hue: number, saturation: number, lightness: number): string {
	return `hsl(${((Math.round(hue) % 360) + 360) % 360}, ${saturation}%, ${lightness}%)`;
}

function hueBand(path: string, start: number, end: number): number {
	const span = Math.max(1, Math.round(end - start));
	return start + (hashString(path) % span);
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

const ACCENT: CloudPaletteDefinition = {
	id: 'accent',
	label: 'Theme accent',
	fill: () => 'var(--interactive-accent)',
};

export const PALETTES: CloudPaletteDefinition[] = [
	ACCENT,
	{ id: 'hues', label: 'Colour per folder', fill: ({ path }) => hsl(hueBand(path, 0, 360), 62, 55) },
	{
		id: 'activity',
		label: 'Hot folders (recent activity)',
		fill: ({ activity }) => hsl(205 - 190 * clamp01(activity), 70, 56),
	},
	{ id: 'depth', label: 'Nesting depth', fill: ({ depth }) => hsl(195 + depth * 42, 62, 55) },
	{ id: 'size', label: 'Folder size', fill: ({ count }) => hsl(200 - 165 * clamp01(count / 40), 66, 55) },
	{ id: 'aurora', label: 'Aurora', fill: ({ path }) => hsl(hueBand(path, 150, 290), 65, 58) },
	{ id: 'sunset', label: 'Sunset', fill: ({ path }) => hsl(hueBand(path, 5, 55), 75, 58) },
	{ id: 'ocean', label: 'Ocean', fill: ({ path }) => hsl(hueBand(path, 185, 255), 60, 55) },
	{ id: 'forest', label: 'Forest', fill: ({ path }) => hsl(hueBand(path, 95, 165), 55, 50) },
	{ id: 'candy', label: 'Candy', fill: ({ path }) => hsl(hueBand(path, 285, 345), 70, 62) },
	{ id: 'neon', label: 'Neon', fill: ({ path }) => hsl(hueBand(path, 0, 360), 95, 60) },
	{ id: 'pastel', label: 'Pastel', fill: ({ path }) => hsl(hueBand(path, 0, 360), 45, 74) },
	{ id: 'muted', label: 'Muted grey', fill: () => 'var(--text-muted)' },
	{ id: 'mono', label: 'Monochrome', fill: () => 'var(--text-normal)' },
];

/** Palette ids renamed after release keep working. */
const RENAMED: Record<string, string> = { folders: 'hues' };

export function resolvePalette(id: string | undefined): CloudPaletteDefinition {
	if (!id) return ACCENT;
	const key = RENAMED[id] ?? id;
	return PALETTES.find((palette) => palette.id === key) ?? ACCENT;
}

export function cloudFill(id: string | undefined, input: PaletteInput): string {
	return resolvePalette(id).fill(input);
}
