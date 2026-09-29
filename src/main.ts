import { Plugin } from 'obsidian';
import { GraphView, GRAPH_VIEW_TYPE } from './graph/GraphView';
import { loadPinnedPositions, onPinnedChange, serializePinnedPositions } from './graph/positions';
import {
	DEFAULT_SETTINGS,
	GraphPlusSettings,
	GraphPlusSettingTab,
	emitSettingsChanged,
	settingsStore,
} from './settings';

/** Dragged notes are saved lazily: frequent during a drag, so coalesce the writes. */
const SAVE_DELAY_MS = 600;

interface StoredState {
	settings?: Partial<GraphPlusSettings>;
	pinned?: unknown;
}

export default class GraphPlusPlugin extends Plugin {
	private saveTimer: number | undefined;

	async onload() {
		await this.loadState();
		this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphView(leaf));
		this.addSettingTab(new GraphPlusSettingTab(this.app, this));
		this.addRibbonIcon('network', 'Open graph', () => void this.openGraph());
		this.addCommand({
			id: 'open-graph',
			name: 'Open graph',
			callback: () => void this.openGraph(),
		});
		this.register(onPinnedChange(() => this.queueSave()));
		this.register(() => window.clearTimeout(this.saveTimer));
		this.app.workspace.onLayoutReady(() => void this.openOnStartup());
	}

	async openGraph(): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	/** Landing behaviour: fill an empty workspace, never fight a restored note. */
	private async openOnStartup(): Promise<void> {
		if (!settingsStore.value.openOnStartup) return;
		const { workspace } = this.app;
		if (workspace.getLeavesOfType(GRAPH_VIEW_TYPE).length > 0) return;
		if (workspace.getLeavesOfType('markdown').length > 0) return;
		await this.openGraph();
	}

	private queueSave(): void {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.saveState(), SAVE_DELAY_MS);
	}

	async saveSettings(): Promise<void> {
		await this.saveState();
		emitSettingsChanged();
	}

	async loadState(): Promise<void> {
		const raw = (await this.loadData()) as StoredState | null;
		if (raw && typeof raw === 'object' && 'settings' in raw) {
			settingsStore.value = Object.assign({}, DEFAULT_SETTINGS, raw.settings);
			loadPinnedPositions(raw.pinned);
			return;
		}
		// Data written before positions existed was the settings object itself.
		settingsStore.value = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
		loadPinnedPositions(undefined);
	}

	async saveState(): Promise<void> {
		await this.saveData({ settings: settingsStore.value, pinned: serializePinnedPositions() });
	}
}
