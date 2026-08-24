import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import {
	extractUsageReports,
	formatSimpleUsage,
	formatSimpleUsageStyled,
	type SimpleUsageReport,
} from "./simple-usage.ts";
import { getUsageArgumentCompletions } from "./autocomplete.ts";

const MESSAGE_TYPE = "pi-usage";
const USAGE_TIMEOUT_MS = 120_000;

type UsageDetails = {
	view: "native" | "simple";
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

/** Strip ANSI escape codes from CLI output so Pi's theme owns all coloring. */
function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "");
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

function isSimpleArgs(args: readonly string[]): boolean {
	return args.some(arg => arg.toLowerCase() === "--simple") || args[0]?.toLowerCase() === "simple";
}

function removeSimpleArgs(args: readonly string[]): string[] {
	return args.filter((arg, index) => arg.toLowerCase() !== "--simple" && !(index === 0 && arg.toLowerCase() === "simple"));
}

/** Output shapes the styled renderer cannot represent; keep the raw passthrough. */
function isPassthroughArgs(args: readonly string[]): boolean {
	return args.some(
		arg => arg === "invalidate" || arg === "--json" || arg === "--history" || arg.startsWith("--history="),
	);
}

function commandFailure(args: readonly string[], result: { code: number; stderr: string; killed: boolean }): Error {
	if (result.killed) return new Error("usage collection timed out after 120 seconds");
	const details = result.stderr.trim().replace(/\s+/g, " ");
	return new Error(
		`omp usage ${args.join(" ") || "failed"} (exit ${result.code})${details ? `: ${details.slice(0, 1000)}` : ""}`,
	);
}

export default function usageExtension(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<UsageDetails>(MESSAGE_TYPE, (message, _options, theme) => {
		const details = message.details;
		const body = details?.reports
			? formatSimpleUsageStyled(details.reports, theme, undefined, undefined, {
					title: details.view === "simple" ? "Usage (simple)" : "Usage",
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
		description: "Show provider usage limits; add `simple` for the compact view",
		getArgumentCompletions: getUsageArgumentCompletions,
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const args = splitArgs(rawArgs);
			const simple = isSimpleArgs(args);
			const forwardedArgs = simple ? removeSimpleArgs(args) : args;
			const passthrough = !simple && isPassthroughArgs(forwardedArgs);

			try {
				if (simple && forwardedArgs.some(arg => arg === "--history" || arg.startsWith("--history="))) {
					throw new Error("/usage simple shows the live snapshot; remove --history");
				}

				const executable = process.platform === "win32" ? "omp.exe" : "omp";
				const commandArgs = !passthrough
					? ["usage", "--json", ...forwardedArgs.filter(arg => arg !== "--json")]
					: ["usage", ...forwardedArgs];
				const result = await pi.exec(executable, commandArgs, { timeout: USAGE_TIMEOUT_MS });
				if (result.code !== 0) throw commandFailure(commandArgs.slice(1), result);

				if (!passthrough) {
					const reports = extractUsageReports(JSON.parse(result.stdout));
					const view = simple ? "simple" : "native";
					pi.sendMessage(
						{
							customType: MESSAGE_TYPE,
							content: formatSimpleUsage(reports, Date.now(), {
								title: simple ? "Usage (simple)" : "Usage",
								hideFilteredLimits: simple,
							}),
							details: { view, reports },
							display: true,
						},
						{ triggerTurn: false },
					);
				} else {
					const output = stripAnsi(result.stdout.trim() || result.stderr.trim()) || "No usage output.";
					pi.sendMessage(
						{
							customType: MESSAGE_TYPE,
							content: output,
							details: { view: "native" },
							display: true,
						},
						{ triggerTurn: false },
					);
				}
			} catch (error) {
				const message = stripAnsi(`Usage failed: ${errorMessage(error)}`);
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				pi.sendMessage(
					{
						customType: MESSAGE_TYPE,
						content: message,
						details: { view: simple ? "simple" : "native", error: true },
						display: !ctx.hasUI,
					},
					{ triggerTurn: false },
				);
			}
		},
	});
}
