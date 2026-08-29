import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import {
	formatSimpleUsage,
	formatSimpleUsageStyled,
	type SimpleUsageReport,
} from "./simple-usage.ts";
import {
	collectPiAuthUsageReports,
	PI_AUTH_USAGE_PROVIDER_IDS,
	isPiAuthUsageProvider,
	redactPiAuthUsageReports,
} from "./pi-auth-usage.ts";
import { getUsageArgumentCompletions } from "./autocomplete.ts";

const MESSAGE_TYPE = "pi-usage";

type UsageView = "simple" | "expanded" | "current";

type UsageDetails = {
	view: UsageView;
	reports?: SimpleUsageReport[];
	error?: boolean;
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content ?? "");
	return content
		.map(block => {
			if (!block || typeof block !== "object") return "";
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "\"" | "'" | undefined;
	let escaped = false;

	for (const character of input.trim()) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
		} else if (/\s/.test(character)) {
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += character;
		}
	}

	if (escaped) current += "\\";
	if (current) args.push(current);
	return args;
}

function requestedView(args: readonly string[]): UsageView {
	const first = args[0]?.toLowerCase();
	return first === "current" ? "current" : first === "expanded" ? "expanded" : "simple";
}

function removeViewArg(args: readonly string[]): string[] {
	return args.filter((arg, index) => index !== 0 || !["current", "expanded"].includes(arg.toLowerCase()));
}

function hasRemovedSimpleArg(args: readonly string[]): boolean {
	return args.some(arg => arg.toLowerCase() === "--simple") || args[0]?.toLowerCase() === "simple";
}

function normalizeProvider(provider: string | undefined): string | undefined {
	const normalized = provider?.toLowerCase();
	return normalized === "xai" ? "xai-oauth" : normalized;
}

function usageTitle(view: UsageView): string {
	return view === "simple" ? "Usage" : view === "current" ? "Usage (current)" : "Usage (expanded)";
}

function requestedProvider(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg.startsWith("--provider=")) return arg.slice("--provider=".length).trim().toLowerCase() || undefined;
		if (arg === "--provider") return args[index + 1]?.trim().toLowerCase() || undefined;
	}
	return undefined;
}

function hasArgument(args: readonly string[], value: string): boolean {
	return args.some(arg => arg.toLowerCase() === value);
}

export default function usageExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<UsageDetails>(MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details;
		const body = details?.reports
			? formatSimpleUsageStyled(details.reports, theme, undefined, undefined, {
					title: usageTitle(details.view),
					hideFilteredLimits: details.view === "simple",
				})
			: textFromContent(message.content);
		const content = details?.error ? theme.fg("error", body) : body;
		const block = new Box(0, 0);
		block.addChild(new DynamicBorder(text => theme.fg("borderMuted", text)));
		block.addChild(new Spacer(1));
		block.addChild(new Text(content, 1, 0));
		block.addChild(new DynamicBorder(text => theme.fg("borderMuted", text)));
		return block;
	});

	pi.registerCommand("usage", {
		description: "Show programming quotas; use `current` or `expanded` for detail",
		getArgumentCompletions: getUsageArgumentCompletions,
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = splitArgs(rawArgs);
			const view = requestedView(args);
			const forwardedArgs = removeViewArg(args);
			const wantsJson = hasArgument(forwardedArgs, "--json");
			const provider = requestedProvider(forwardedArgs);
			const piProvider = normalizeProvider(provider ?? (view === "current" ? ctx.model?.provider : undefined));

			try {
				if (hasRemovedSimpleArg(args)) throw new Error("`simple` was removed; use `/usage` for the compact view");
				const removedArgument = forwardedArgs.find(
					arg => arg === "invalidate" || arg === "--history" || arg.startsWith("--history="),
				);
				if (removedArgument) throw new Error(`${removedArgument} is no longer supported; /usage reports Pi-auth quotas only`);
				if (view === "current" && !piProvider) throw new Error("No active model provider; use `/usage --provider <provider>`");
				if (provider && !isPiAuthUsageProvider(provider)) {
					throw new Error(`No direct usage collector for ${provider}; supported providers: ${PI_AUTH_USAGE_PROVIDER_IDS.join(", ")}`);
				}
				if (piProvider && !isPiAuthUsageProvider(piProvider)) {
					throw new Error(`No direct usage collector for ${piProvider}; supported providers: ${PI_AUTH_USAGE_PROVIDER_IDS.join(", ")}`);
				}

				const piReports = await collectPiAuthUsageReports(ctx, fetch, piProvider);
				const reports = hasArgument(forwardedArgs, "--redact")
					? redactPiAuthUsageReports(piReports)
					: piReports;
				if (wantsJson) {
					pi.sendMessage(
						{
							customType: MESSAGE_TYPE,
							content: JSON.stringify({ reports }, null, 2),
							details: { view },
							display: true,
						},
						{ triggerTurn: false },
					);
					return;
				}
				pi.sendMessage(
					{
						customType: MESSAGE_TYPE,
						content: formatSimpleUsage(reports, Date.now(), {
							title: usageTitle(view),
							hideFilteredLimits: view === "simple",
						}),
						details: { view, reports },
						display: true,
					},
					{ triggerTurn: false },
				);
			} catch (error) {
				const message = `Usage failed: ${errorMessage(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				pi.sendMessage(
					{
						customType: MESSAGE_TYPE,
						content: message,
						details: { view, error: true },
						display: !ctx.hasUI,
					},
					{ triggerTurn: false },
				);
			}
		},
	});
}
