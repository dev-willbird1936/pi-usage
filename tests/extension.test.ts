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

const report = {
	provider: "openai-codex",
	metadata: { email: "user@example.test" },
	limits: [
		{ label: "7 days", amount: { used: 1, limit: 10, unit: "percent" } },
		{ label: "Spark", amount: { used: 1, limit: 10, unit: "percent" } },
	],
};

test("/usage simple delegates to the JSON report and sends the filtered view", async () => {
	let command: any;
	const calls: any[] = [];
	const messages: any[] = [];
	const pi = {
		registerMessageRenderer() {},
		registerCommand(_name: string, options: any) {
			command = options;
		},
		exec(...args: any[]) {
			calls.push(args);
			return Promise.resolve({
				stdout: JSON.stringify({ reports: [report] }),
				stderr: "",
				code: 0,
				killed: false,
			});
		},
		sendMessage(message: any, options: any) {
			messages.push({ message, options });
		},
	} as any;

	usageExtension(pi);
	await command.handler("simple --redact", { hasUI: true, ui: { notify() {} } });

	expect(calls[0][1]).toEqual(["usage", "--json", "--redact"]);
	expect(messages[0].options).toEqual({ triggerTurn: false });
	expect(messages[0].message.details.reports).toHaveLength(1);
	expect(messages[0].message.content).toContain("7 days");
	expect(messages[0].message.content).not.toContain("Spark");
});

test("/usage renders the full view through the same styled renderer", async () => {
	let command: any;
	const calls: any[] = [];
	const messages: any[] = [];
	const pi = {
		registerMessageRenderer() {},
		registerCommand(_name: string, options: any) {
			command = options;
		},
		exec(...args: any[]) {
			calls.push(args);
			return Promise.resolve({
				stdout: JSON.stringify({ reports: [report] }),
				stderr: "",
				code: 0,
				killed: false,
			});
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any;

	usageExtension(pi);
	await command.handler("--provider cursor --redact", { hasUI: true, ui: { notify() {} } });

	expect(calls[0][1]).toEqual(["usage", "--json", "--provider", "cursor", "--redact"]);
	expect(messages[0].details.view).toBe("native");
	expect(messages[0].details.reports).toHaveLength(1);
	expect(messages[0].content).toContain("Usage\n");
	expect(messages[0].content).toContain("7 days");
	expect(messages[0].content).toContain("Spark");
});

test("/usage --history keeps the raw passthrough and strips ANSI codes", async () => {
	let command: any;
	const calls: any[] = [];
	const messages: any[] = [];
	const pi = {
		registerMessageRenderer() {},
		registerCommand(_name: string, options: any) {
			command = options;
		},
		exec(...args: any[]) {
			calls.push(args);
			return Promise.resolve({ stdout: "\x1b[32mUsage history\x1b[0m\n", stderr: "", code: 0, killed: false });
		},
		sendMessage(message: any) {
			messages.push(message);
		},
	} as any;

	usageExtension(pi);
	await command.handler("--history --days 30", { hasUI: true, ui: { notify() {} } });

	expect(calls[0][1]).toEqual(["usage", "--history", "--days", "30"]);
	expect(messages[0].content).toBe("Usage history");
	expect(messages[0].details).toEqual({ view: "native" });
});

test("/usage --provider anthropic uses Pi OAuth without invoking omp", async () => {
	let command: any;
	const calls: any[] = [];
	const messages: any[] = [];
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
		if (url.includes("billing?format=credits")) {
			return new Response(JSON.stringify({
				config: {
					currentPeriod: { start: "2099-08-20T00:00:00Z", end: "2099-08-27T00:00:00Z", type: "WEEKLY" },
					creditUsagePercent: 30,
					productUsage: [],
				},
			}));
		}
		if (url.endsWith("/oauth2/userinfo")) return new Response(JSON.stringify({ email: "grok@example.test" }));
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	try {
		const pi = {
			registerMessageRenderer() {},
			registerCommand(_name: string, options: any) {
				command = options;
			},
			exec(...args: any[]) {
				calls.push(args);
				return Promise.reject(new Error("omp unavailable"));
			},
			sendMessage(message: any) {
				messages.push(message);
			},
		} as any;
		usageExtension(pi);
		await command.handler("--provider anthropic", {
			hasUI: true,
			ui: { notify() {} },
			modelRegistry: {
				getProviderAuth(provider: string) {
					return Promise.resolve(provider === "anthropic"
						? { source: "OAuth", auth: { apiKey: "claude-pi-token" } }
						: provider === "xai"
							? { source: "OAuth", auth: { apiKey: "xai-pi-token" } }
							: undefined);
				},
			},
		});
	} finally {
		globalThis.fetch = previousFetch;
	}

	expect(calls).toHaveLength(0);
	expect(messages[0].details.reports.map((report: any) => report.provider)).toEqual(["anthropic"]);
	expect(messages[0].content).toContain("Claude");
});
