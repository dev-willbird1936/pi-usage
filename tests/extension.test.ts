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
	await command.handler("--provider anthropic --redact", { hasUI: true, ui: { notify() {} } });

	expect(calls[0][1]).toEqual(["usage", "--json", "--provider", "anthropic", "--redact"]);
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
