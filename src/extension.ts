import {
	defineTool,
	DynamicBorder,
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import {
	formatSimpleUsage,
	formatSimpleUsageForChat,
	formatSimpleUsageStyled,
	type SimpleUsageReport,
} from "./simple-usage.ts";
import {
	collectPiAuthUsageReports,
	USAGE_PROVIDER_IDS,
	isPiAuthUsageProvider,
	readClaudeCodeAccessToken,
	readClaudeCodeCredential,
	writeClaudeCodeCredential,
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
	return first === "current" ? "current" : first === "expanded" || first === "extended" ? "expanded" : "simple";
}

function removeViewArg(args: readonly string[]): string[] {
	return args.filter((arg, index) => index !== 0 || !["current", "expanded", "extended"].includes(arg.toLowerCase()));
}

function hasRemovedSimpleArg(args: readonly string[]): boolean {
	return args.some(arg => arg.toLowerCase() === "--simple") || args[0]?.toLowerCase() === "simple";
}

function normalizeProvider(provider: string | undefined): string | undefined {
	const normalized = provider?.toLowerCase();
	if (!normalized) return undefined;
	return {
		claude: "anthropic",
		"claude-code": "anthropic",
		"claude-bridge": "anthropic",
		xai: "xai-oauth",
		"xai-cliproxy": "xai-oauth",
		"cursor-cliproxy": "cursor",
		"deepseek-cliproxy": "deepseek",
		"kimi-code": "kimi-coding",
		"kimi-cliproxy": "kimi-coding",
		"openrouter-cliproxy": "openrouter",
		opencode: "opencode-go",
	}[normalized] ?? normalized;
}

function usageTitle(view: UsageView): string {
	return view === "simple" ? "Usage · compact" : view === "current" ? "Usage · current" : "Usage · expanded";
}

/** `chat` renders plain fenced text so non-TUI clients show it as a chat message. */
function takeChatFlag(args: readonly string[]): { chat: boolean; rest: string[] } {
	const rest = args.filter((arg, index) => arg.toLowerCase() !== "--chat" && !(index === 0 && arg.toLowerCase() === "chat"));
	return { chat: rest.length !== args.length, rest };
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

type UsageAuthContext = Parameters<typeof collectPiAuthUsageReports>[0];

async function collectUsage(
	ctx: UsageAuthContext,
	provider: string | undefined,
	redact: boolean,
): Promise<SimpleUsageReport[]> {
	const reports = await collectPiAuthUsageReports(
		{ ...ctx, readStoredCredential, readClaudeCodeAccessToken, readClaudeCodeCredential, writeClaudeCodeCredential },
		fetch,
		provider,
	);
	return redact ? redactPiAuthUsageReports(reports) : reports;
}

/**
 * Tool form of `/usage`. Slash commands render as a custom message, which only
 * Pi's TUI draws; a tool result travels the normal agent-chat path, so hosts
 * that render messages rather than terminal components still show the report.
 */
const usageTool = defineTool({
	name: "usage",
	label: "Usage",
	description:
		"Report the user's remaining AI provider quotas: quota left, reset countdown, and a burn-rate estimate for each signed-in provider (Claude, Codex, Cursor, DeepSeek, Grok, Kimi, OpenRouter, OpenCode Go). Use when asked how much quota, credit, or rate limit is left, or when a provider looks exhausted. The result is already formatted for display: show it verbatim instead of restating the numbers.",
	promptSnippet: "Report remaining AI provider quotas and reset times",
	parameters: Type.Object({
		view: Type.Optional(
			StringEnum(["compact", "expanded"] as const, {
				description:
					"'compact' (default) keeps each provider's main programming quota. Use 'expanded' only when the user asks for every limit, a model/product breakdown, or short quota windows.",
			}),
		),
		provider: Type.Optional(
			Type.String({ description: `Limit the report to one provider: ${USAGE_PROVIDER_IDS.join(", ")}. Omit to report every signed-in provider.` }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const provider = normalizeProvider(params.provider);
		if (provider && !isPiAuthUsageProvider(provider)) {
			throw new Error(`No direct usage collector for ${params.provider}; supported providers: ${USAGE_PROVIDER_IDS.join(", ")}`);
		}
		const expanded = params.view === "expanded";
		const reports = await collectUsage(ctx, provider, false);
		const text = formatSimpleUsage(reports, Date.now(), {
			title: expanded ? "Usage · expanded" : "Usage · compact",
			hideFilteredLimits: !expanded,
		});
		return { content: [{ type: "text", text }], details: { reports } };
	},
});

export default function usageExtension(pi: ExtensionAPI): void {
	pi.registerTool(usageTool);

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
		description: "Show programming quotas; use `current`, `expanded`, or `chat`",
		getArgumentCompletions: getUsageArgumentCompletions,
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			const { chat, rest: args } = takeChatFlag(splitArgs(rawArgs));
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
				if (removedArgument) throw new Error(`${removedArgument} is no longer supported; /usage reports verified quotas only`);
				if (view === "current" && !piProvider) throw new Error("No active model provider; use `/usage --provider <provider>`");
				if (provider && !isPiAuthUsageProvider(piProvider)) {
					throw new Error(`No direct usage collector for ${provider}; supported providers: ${USAGE_PROVIDER_IDS.join(", ")}`);
				}
				if (piProvider && !isPiAuthUsageProvider(piProvider)) {
					throw new Error(`No direct usage collector for ${piProvider}; supported providers: ${USAGE_PROVIDER_IDS.join(", ")}`);
				}

				const reports = await collectUsage(ctx, piProvider, hasArgument(forwardedArgs, "--redact"));
				const viewOptions = { title: usageTitle(view), hideFilteredLimits: view === "simple" };
				// JSON and chat carry their own literal payload, so they omit `reports`
				// and the renderer prints the content verbatim in every client.
				if (wantsJson || chat) {
					pi.sendMessage(
						{
							customType: MESSAGE_TYPE,
							content: wantsJson
								? JSON.stringify({ reports }, null, 2)
								: formatSimpleUsageForChat(reports, Date.now(), viewOptions),
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
						content: formatSimpleUsage(reports, Date.now(), viewOptions),
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
