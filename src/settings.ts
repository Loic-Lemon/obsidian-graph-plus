import { App, PluginSettingTab, Setting } from 'obsidian';
import { PALETTES } from './graph/palettes';
import type GraphPlusPlugin from './main';

export interface GraphPlusSettings {
	openOnStartup: boolean;
	palette: string;
	cloudOpacity: number;
	cloudSoftness: number;
	linkOpacity: number;
	/** How far non-neighbours fade while hovering. 1 keeps everything bright. */
	hoverDim: number;
	nodeSize: number;
	recentCount: number;
	/** Days after which a note's freshness has decayed to ~37%. */
	freshnessDays: number;
}

export const DEFAULT_SETTINGS: GraphPlusSettings = {
	openOnStartup: true,
	palette: 'accent',
	cloudOpacity: 0.19,
	cloudSoftness: 16,
	linkOpacity: 0.45,
	hoverDim: 0.55,
	nodeSize: 1,
	recentCount: 10,
	freshnessDays: 21,
};

/** Single source of truth: the plugin persists it, the view reads it live. */
export const settingsStore: { value: GraphPlusSettings } = { value: { ...DEFAULT_SETTINGS } };

type SettingsListener = () => void;
const settingsListeners = new Set<SettingsListener>();

/** Notifies open graph views after a settings change; returns an unsubscribe. */
export function onSettingsChanged(listener: SettingsListener): () => void {
	settingsListeners.add(listener);
	return () => {
		settingsListeners.delete(listener);
	};
}

export function emitSettingsChanged(): void {
	for (const listener of [...settingsListeners]) listener();
}

export class GraphPlusSettingTab extends PluginSettingTab {
	plugin: GraphPlusPlugin;

	constructor(app: App, plugin: GraphPlusPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Open on startup')
			.setDesc('Open the graph when Obsidian starts with an empty workspace.')
			.addToggle((toggle) =>
				toggle.setValue(settingsStore.value.openOnStartup).onChange(async (value) => {
					settingsStore.value.openOnStartup = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Colour scheme')
			.setDesc('How folder clouds are coloured.')
			.addDropdown((dropdown) => {
				for (const palette of PALETTES) dropdown.addOption(palette.id, palette.label);
				dropdown.setValue(settingsStore.value.palette).onChange(async (value) => {
					settingsStore.value.palette = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Cloud opacity')
			.setDesc('How strongly folder clouds are tinted.')
			.addSlider((slider) =>
				slider
					.setLimits(0.04, 0.4, 0.01)
					.setValue(settingsStore.value.cloudOpacity)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settingsStore.value.cloudOpacity = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Cloud softness')
			.setDesc('How much the cloud edges blur.')
			.addSlider((slider) =>
				slider
					.setLimits(4, 28, 1)
					.setValue(settingsStore.value.cloudSoftness)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settingsStore.value.cloudSoftness = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Link opacity')
			.setDesc('How visible links between notes are.')
			.addSlider((slider) =>
				slider
					.setLimits(0.05, 1, 0.05)
					.setValue(settingsStore.value.linkOpacity)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settingsStore.value.linkOpacity = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Hover dimming')
			.setDesc('How much unrelated notes fade while hovering one. Higher keeps more visible.')
			.addSlider((slider) =>
				slider
					.setLimits(0.15, 1, 0.05)
					.setValue(settingsStore.value.hoverDim)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settingsStore.value.hoverDim = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Node size')
			.setDesc('Scales every note dot, on top of its link count.')
			.addSlider((slider) =>
				slider
					.setLimits(0.6, 1.8, 0.05)
					.setValue(settingsStore.value.nodeSize)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settingsStore.value.nodeSize = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Recent notes')
			.setDesc('How many recently edited notes keep their name at full brightness.')
			.addSlider((slider) =>
				slider
					.setLimits(3, 40, 1)
					.setValue(settingsStore.value.recentCount)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settingsStore.value.recentCount = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Note freshness')
			.setDesc('Days until a note counts as half-forgotten; older notes cool and turn dashed.')
			.addSlider((slider) =>
				slider
					.setLimits(5, 180, 1)
					.setValue(settingsStore.value.freshnessDays)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settingsStore.value.freshnessDays = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
