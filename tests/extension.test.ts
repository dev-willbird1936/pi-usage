import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
	DynamicBorder: class {},
}));
mock.module("@earendil-works/pi-tui", () => ({
	Box: class {},
	Spacer: class {},
	Text: class {},
}));

const { default: usageExtension } = await import("../src/extension.ts");

function createPi() {
	let command: any;
	const messages: any[] = [];
	const notifications: string[] = [];
	const pi = {
		registerMessageRenderer() {},
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
		messages,
		notifications,
		ctx: {
			hasUI: true,
			model: { provider: "anthropic" },
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
	expect(harness.messages[0].message.content).toContain("5 Hour");
	expect(harness.messages[0].message.content).toContain("Usage");
});

test("/usage current expands the active Pi provider", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("current", harness.ctx));

	expect(harness.messages[0].message.details.view).toBe("current");
	expect(harness.messages[0].message.content).toContain("Usage (current)");
	expect(harness.messages[0].message.content).toContain("5 Hour");
});

test("/usage expanded renders every direct Pi provider", async () => {
	const harness = createPi();
	usageExtension(harness.pi);
	await withClaudeUsageFetch(() => harness.command().handler("expanded --provider anthropic", harness.ctx));

	expect(harness.messages[0].message.details.view).toBe("expanded");
	expect(harness.messages[0].message.content).toContain("Usage (expanded)");
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
