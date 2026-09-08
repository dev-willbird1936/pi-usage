import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { USAGE_PROVIDER_IDS } from "./pi-auth-usage.ts";

const USAGE_ITEMS: AutocompleteItem[] = [
	{
		value: "current ",
		label: "current",
		description: "Show expanded usage for the active provider",
	},
	{
		value: "expanded ",
		label: "expanded",
		description: "Show every direct provider limit",
	},
	{
		value: "chat ",
		label: "chat",
		description: "Render as plain chat text for non-terminal clients",
	},
	{
		value: "--provider ",
		label: "--provider",
		description: "Only show usage for one provider",
	},
	{
		value: "--json ",
		label: "--json",
		description: "Output the usage report as JSON",
	},
	{
		value: "--redact ",
		label: "--redact",
		description: "Redact account identifiers",
	},
	{
		value: "--chat ",
		label: "--chat",
		description: "Render as plain chat text for non-terminal clients",
	},
];

export function getUsageArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const providerMatch = /^--provider(?:\s+(\S*))?$/i.exec(prefix);
	if (providerMatch) {
		const partial = (providerMatch[1] ?? "").toLowerCase();
		const matches = USAGE_PROVIDER_IDS.filter(id => id.startsWith(partial)).map(id => ({
			value: `--provider ${id} `,
			label: id,
			description: "Only show usage for this provider",
		}));
		return matches.length > 0 ? matches : null;
	}
	if (prefix.includes(" ")) return null;
	const normalized = prefix.toLowerCase();
	const matches = USAGE_ITEMS.filter(item => item.label.toLowerCase().startsWith(normalized));
	return matches.length > 0 ? matches : null;
}
