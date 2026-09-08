import { expect, mock, test } from "bun:test";
import { formatSimpleUsage } from "../src/simple-usage.ts";

mock.module("@earendil-works/pi-coding-agent", () => ({
	DynamicBorder: class {},
	readStoredCredential: () => undefined,
	defineTool: (tool: unknown) => tool,
}));
mock.module("@earendil-works/pi-ai", () => ({
	Type: { Object: (shape: unknown) => shape, Optional: (schema: unknown) => schema, String: () => ({}) },
	StringEnum: (values: unknown) => ({ values }),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Box: class {
		children: unknown[] = [];
		addChild(child: unknown) { this.children.push(child); }
	},
	Spacer: class {},
	Text: class {
		constructor(public text: string) {}
	},
}));

const { default: usageExtension } = await import("../src/extension.ts");

function createPi(modelProvider = "anthropic") {
	let command: any;
	let renderer: any;
	let tool: any;
	const messages: any[] = [];
	const notifications: string[] = [];
	const pi = {
		registerTool(definition: any) {
			tool = definition;
		},
		registerMessageRenderer(_name: string, callback: any) {
			renderer = callback;
		},
		registerCommand(_name: string, options: any) {
			command = options;
		},
		sendMessage(message: any, options: any) {
			messages.push({ message, options });
		},
	};
	return {
		pi: pi as any,
		command: () => command,
		renderer: () => renderer,
		tool: () => tool,
		messages,
		notifications,
		ctx: {
			hasUI: true,
			model: { provider: modelProvider },
			scopedModels: [{ model: { provider: "xai-cliproxy" } }],
			ui: { notify(message: string) { notifications.push(message); } },
			modelRegistry: {
				getProviderAuth(provider: string) {
					return Promise.resolve(provider === "anthropic" ? { source: "OAuth", auth: { apiKey: "claude-pi-token" } } : undefined);
				},
			},
		},
	};
}

async function withClaudeUsageFetch<T>(callback: () => Promise<T>): Promise<T> {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/api/oauth/usage")) {
			return new Response(JSON.stringify({
				five_hour: { utilization: 10, resets_at: "2099-08-21T17:00:00Z" },
				seven_day: { utilization: 20, resets_at: "2099-08-26T12:00:00Z" },
				limits: [],
			}));
		}
		if (url.endsWith("/api/oauth/profile")) {
			return new Response(JSON.stringify({ account: { email: "user@example.test" } }));
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	try {
		return await callback();
	} finally {
		globalThis.fetch = previousFetch;
	}
}

test("bare /usage renders the compact direct Pi-auth view", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("--provider anthropic --redact", harness.ctx));

	expect(harness.messages[0].options).toEqual({ triggerTurn: false });
	expect(harness.messages[0].message.details.reports).toHaveLength(1);
	expect(harness.messages[0].message.content).toContain("7 Day");
	expect(harness.messages[0].message.content).not.toContain("5 Hour");
	expect(harness.messages[0].message.content).toContain("Usage · compact");
});

test("/usage chat emits fenced plain text with no renderer payload", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("chat --provider anthropic", harness.ctx));

	const { message } = harness.messages[0];
	expect(message.details).toEqual({ view: "simple" });
	expect(message.content.startsWith("```text\n")).toBe(true);
	expect(message.content.endsWith("\n```")).toBe(true);
	expect(message.content).toContain("Usage · compact");
	expect(message.content).toContain("7 Day");
});

test("the usage tool returns the report through the normal tool-result path", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	const result = await withClaudeUsageFetch(() =>
		harness.tool().execute("call-1", { provider: "anthropic" }, undefined, undefined, harness.ctx),
	);

	expect(harness.tool().name).toBe("usage");
	expect(result.content[0].text).toContain("Usage · compact");
	expect(result.content[0].text).toContain("7 Day");
	expect(result.content[0].text).not.toContain("5 Hour");
	expect(result.content[0].text).not.toContain("```");
	expect(result.details.reports).toHaveLength(1);
	expect(harness.messages).toEqual([]);
});

test("the usage tool expands every limit on request", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	const result = await withClaudeUsageFetch(() =>
		harness.tool().execute("call-1", { provider: "claude", view: "expanded" }, undefined, undefined, harness.ctx),
	);

	expect(result.content[0].text).toContain("Usage · expanded");
	expect(result.content[0].text).toContain("5 Hour");
});

test("the usage tool rejects providers without a verified collector", async () => {
	const harness = createPi();
	usageExtension(harness.pi);

	expect(
		harness.tool().execute("call-1", { provider: "github-copilot" }, undefined, undefined, harness.ctx),
	).rejects.toThrow("No direct usage collector for github-copilot");
});

test("--chat pairs with the expanded view", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("expanded --provider anthropic --chat", harness.ctx));

	expect(harness.messages[0].message.details.view).toBe("expanded");
	expect(harness.messages[0].message.content).toContain("Usage · expanded");
	expect(harness.messages[0].message.content).toContain("5 Hour");
});

test("hidden Claude bridge models still expose Claude usage in /usage", async () => {
	const harness = createPi("claude-bridge");
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("current", harness.ctx));

	expect(harness.messages[0].message.details.view).toBe("current");
	expect(harness.messages[0].message.content).toContain("Claude 7 Day");
	expect(harness.messages[0].message.content).toContain("Claude 5 Hour");
});

test("bare /usage renders the compact provider set with native usage bars", () => {
	const harness = createPi();
	usageExtension(harness.pi);
	const reports = [
		{
			provider: "anthropic",
			limits: [
				{ id: "anthropic:5h", label: "Claude 5 Hour", window: { durationMs: 5 * 60 * 60_000 }, amount: { used: 10, limit: 100, unit: "percent" } },
				{ id: "anthropic:7d", label: "Claude 7 Day", window: { durationMs: 7 * 24 * 60 * 60_000 }, amount: { used: 33, limit: 100, unit: "percent" } },
				{ id: "anthropic:7d:fable", label: "Claude 7 Day (Fable)", window: { durationMs: 7 * 24 * 60 * 60_000 }, amount: { used: 40, limit: 100, unit: "percent" } },
			],
		},
		{
			provider: "openai-codex",
			limits: [
				{ id: "openai-codex:primary", label: "Codex primary", window: { durationMs: 5 * 60 * 60_000 }, amount: { used: 5, limit: 100, unit: "percent" } },
				{ id: "openai-codex:secondary", label: "7 days", window: { durationMs: 7 * 24 * 60 * 60_000 }, amount: { used: 15, limit: 100, unit: "percent" } },
			],
		},
		{
			provider: "cursor",
			limits: [
				{ id: "cursor:plan", label: "Cursor included usage", window: { id: "monthly", label: "Monthly", durationMs: 31 * 24 * 60 * 60_000 }, amount: { used: 16, limit: 100, unit: "percent" } },
				{ id: "cursor:usd:individual-auto", label: "Cursor Models", window: { id: "monthly", label: "Monthly", durationMs: 31 * 24 * 60 * 60_000 }, amount: { used: 16, limit: 100, unit: "percent" } },
				{ id: "cursor:usd:individual-api", label: "Other Models", window: { id: "monthly", label: "Monthly", durationMs: 31 * 24 * 60 * 60_000 }, amount: { used: 400, limit: 400, unit: "usd" } },
			],
		},
		{
			provider: "deepseek",
			limits: [
				{ id: "deepseek:usd:total_balance", label: "DeepSeek USD total", amount: { remaining: 2.48, unit: "usd" } },
				{ id: "deepseek:usd:granted_balance", label: "DeepSeek USD granted", amount: { remaining: 1, unit: "usd" } },
				{ id: "deepseek:usd:topped_up_balance", label: "DeepSeek USD topped-up", amount: { remaining: 1.48, unit: "usd" } },
			],
		},
		{
			provider: "xai-oauth",
			limits: [
				{ id: "xai-oauth:credits:1w", label: "SuperGrok Weekly Credits", window: { durationMs: 7 * 24 * 60 * 60_000 }, amount: { used: 2, limit: 100, unit: "percent" } },
				{ id: "xai-oauth:product:grokbuild:1w", label: "Grok Build (Weekly)", window: { durationMs: 7 * 24 * 60 * 60_000 }, amount: { used: 2, limit: 100, unit: "percent" } },
			],
		},
	];
	const content = formatSimpleUsage(reports, 0);
	const message = { content, details: { view: "simple", reports } };

	const box = harness.renderer()(message, {}, {
		bold: (text: string) => text,
		fg: (_color: string, text: string) => text,
	});
	const body = (box.children[2] as { text: string }).text;
	expect(body).toContain("████████");
	expect(body).toContain("Usage · compact");
	expect(body).toContain("7 days");
	expect(body).toContain("Cursor Models");
	expect(body).toContain("Other Models");
	expect(body).toContain("DeepSeek USD total");
	expect(body).toContain("$2.48 left");
	expect(body).toContain("SuperGrok Weekly Credits");
	expect(body).toContain("Total usage");
	expect(body).not.toContain("Claude 5 Hour");
	expect(body).not.toContain("Codex primary");
	expect(body).not.toContain("Grok Build (Weekly)");
});

test("/usage current expands the active Pi provider", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("current", harness.ctx));

	expect(harness.messages[0].message.details.view).toBe("current");
	expect(harness.messages[0].message.content).toContain("Usage · current");
	expect(harness.messages[0].message.content).toContain("5 Hour");
});

test("/usage extended is an alias for expanded", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("extended --provider anthropic", harness.ctx));

	expect(harness.messages[0].message.details.view).toBe("expanded");
	expect(harness.messages[0].message.content).toContain("Usage · expanded");
});

test("/usage expanded renders every direct Pi provider", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("expanded --provider anthropic", harness.ctx));

	expect(harness.messages[0].message.details.view).toBe("expanded");
	expect(harness.messages[0].message.content).toContain("Usage · expanded");
});

test("removed simple mode fails clearly", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await harness.command().handler("simple --provider anthropic", harness.ctx);

	expect(harness.notifications[0]).toContain("`simple` was removed");
	expect(harness.messages[0].message.details.error).toBe(true);
});

test("/usage --json emits only direct Pi-auth reports", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("--provider anthropic --json", harness.ctx));

	const payload = JSON.parse(harness.messages[0].message.content);
	expect(payload.reports).toHaveLength(1);
	expect(payload.reports[0].provider).toBe("anthropic");
	expect(harness.notifications).toEqual([]);
});

test("removed external-collector arguments fail clearly", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await harness.command().handler("--history --days 30", harness.ctx);

	expect(harness.notifications[0]).toContain("--history is no longer supported");
	expect(harness.messages[0].message.details.error).toBe(true);
});

test("unsupported providers fail instead of using a fallback collector", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await harness.command().handler("--provider github-copilot", harness.ctx);

	expect(harness.notifications[0]).toContain("No direct usage collector for github-copilot");
});
