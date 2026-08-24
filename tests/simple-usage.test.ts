import { describe, expect, test } from "bun:test";
import {
	extractUsageReports,
	formatSimpleUsage,
	formatSimpleUsageStyled,
	isHiddenSimpleLimit,
	type SimpleUsageReport,
} from "../src/simple-usage.ts";

const now = Date.UTC(2026, 7, 21, 12, 0, 0);

const fixture: SimpleUsageReport[] = [
	{
		provider: "openai-codex",
		metadata: { email: "codex@example.test" },
		limits: [
			{
				id: "openai-codex:primary",
				label: "7 days",
				amount: { used: 49, limit: 100, unit: "percent" },
				window: { resetsAt: now + 5 * 24 * 60 * 60 * 1000 },
			},
			{
				id: "openai-codex:spark:primary",
				label: "5 hours (Spark)",
				scope: { modelId: "GPT-5.3-Codex-Spark", tier: "spark" },
				amount: { used: 0, limit: 100, unit: "percent" },
			},
		],
	},
	{
		provider: "xai-oauth",
		metadata: { orgName: "Grok subscription" },
		limits: [
			{
				id: "xai-oauth:credits:1w",
				label: "SuperGrok Weekly Credits",
				amount: { used: 89, limit: 100, unit: "percent" },
			},
			{
				id: "xai-oauth:product:grokbuild:1w",
				label: "Grok Build (Weekly)",
				amount: { used: 89, limit: 100, unit: "percent" },
			},
			{
				id: "xai-oauth:product:groktasks:1w",
				label: "GrokTasks (Weekly)",
				amount: { used: 0, limit: 100, unit: "percent" },
			},
		],
	},
];

describe("simple usage filtering", () => {
	test("removes Codex Spark and Grok product buckets", () => {
		const output = formatSimpleUsage(fixture, now);

		expect(output).toContain("7 days");
		expect(output).toContain("SuperGrok Weekly Credits");
		expect(output).not.toContain("Models with usage data");
		expect(output).not.toContain("Spark");
		expect(output).not.toContain("Grok Build");
		expect(output).not.toContain("GrokTasks");
	});

	test("matches hidden names in IDs and scope metadata", () => {
		expect(isHiddenSimpleLimit(fixture[0], fixture[0].limits![1])).toBe(true);
		expect(isHiddenSimpleLimit(fixture[1], fixture[1].limits![1])).toBe(true);
		expect(isHiddenSimpleLimit(fixture[1], fixture[1].limits![2])).toBe(true);
	});

	test("keeps every provider's primary subscription quota across the supported matrix", () => {
		const hidden: Array<[string, string, Record<string, unknown>?]> = [
			// [provider, hidden limit id, extra limit fields]
			["xai-oauth", "xai-oauth:product:api:1w"],
			["github-copilot", "copilot:model:gpt-5"],
			["zai", "zai:features:zread:7d"],
			["umans", "umans:concurrency"],
			["opencode-go", "monthly"],
		];
		for (const [provider, id] of hidden) {
			const report = { provider };
			expect(isHiddenSimpleLimit(report, { id })).toBe(true);
		}

		// Any Codex tiered meter bucket is hidden; primary/secondary stay.
		expect(isHiddenSimpleLimit({ provider: "openai-codex" }, { id: "openai-codex:futuremeter:primary", scope: { tier: "futuremeter" } })).toBe(true);
		expect(isHiddenSimpleLimit({ provider: "openai-codex" }, { id: "openai-codex:primary" })).toBe(false);
		expect(isHiddenSimpleLimit({ provider: "openai-codex" }, { id: "openai-codex:secondary" })).toBe(false);

		const kept: Array<[string, string]> = [
			["anthropic", "anthropic:5h"],
			["anthropic", "anthropic:7d"],
			["anthropic", "anthropic:7d:opus"],
			["anthropic", "anthropic:7d:fable"],
			["anthropic", "anthropic:extra"],
			["xai-oauth", "xai-oauth:credits:1w"],
			["xai-oauth", "xai-oauth:included:1mo"],
			["xai-oauth", "xai-oauth:on-demand"],
			["github-copilot", "copilot:premium"],
			["github-copilot", "copilot:chat"],
			["github-copilot", "copilot:completions"],
			["zai", "zai:tokens:7d"],
			["zai", "zai:requests:5h"],
			["umans", "umans:requests"],
			["umans", "umans:requests:soft"],
			["umans", "umans:requests:hard"],
			["opencode-go", "rolling-5h"],
			["opencode-go", "weekly"],
			["alibaba-token-plan", "credits:5h"],
			["alibaba-token-plan", "credits:7d"],
			["kimi-code", "kimi-code:0"],
			["minimax-code", "general:5h"],
			["minimax-code", "m2:5h"],
			["google-gemini-cli", "gemini-3-pro:quota"],
			["google-antigravity", "google-antigravity:default:default:5h"],
			["synthetic", "synthetic:requests:5h"],
			["synthetic", "synthetic:usd:7d"],
			["cursor", "cursor:usd:individual-auto"],
			["cursor", "cursor:usd:individual-api"],
			["cursor", "cursor:usd:individual-ondemand"],
		];
		for (const [provider, id] of kept) {
			expect(isHiddenSimpleLimit({ provider }, { id })).toBe(false);
		}
	});

	test("drops Cursor aggregate rows only when itemized meters exist", () => {
		const withItemized: SimpleUsageReport = {
			provider: "cursor",
			limits: [
				{ id: "cursor:usd:individual-auto", label: "Cursor Models" },
				{ id: "cursor:usd:individual-overall", label: "Personal Usage" },
			],
		};
		expect(formatSimpleUsage([withItemized])).toContain("Cursor Models");
		expect(formatSimpleUsage([withItemized])).not.toContain("Personal Usage");

		const aggregateOnly: SimpleUsageReport = {
			provider: "cursor",
			limits: [{ id: "cursor:usd:individual-overall", label: "Personal Usage" }],
		};
		expect(formatSimpleUsage([aggregateOnly])).toContain("Personal Usage");
	});

	test("labels every supported provider", () => {
		const reports: SimpleUsageReport[] = [
			{ provider: "github-copilot", limits: [{ id: "copilot:premium", label: "Premium Requests" }] },
			{ provider: "google-gemini-cli", limits: [{ id: "quota", label: "Gemini 3 Pro" }] },
			{ provider: "minimax-code", limits: [{ id: "general:5h", label: "General 5 Hour" }] },
			{ provider: "zai", limits: [{ id: "zai:tokens:7d", label: "ZAI 7 Day Token Quota" }] },
		];
		const output = formatSimpleUsage(reports);
		expect(output).toContain("GitHub Copilot");
		expect(output).toContain("Gemini\n");
		expect(output).toContain("MiniMax");
		expect(output).toContain("Z.ai");
	});

	test("keeps account labels and reset countdowns", () => {
		const output = formatSimpleUsage(fixture, now);

		expect(output).toContain("Codex — codex@example.test");
		expect(output).toContain("resets in 5d");
	});

	test("handles the wrapped JSON shape", () => {
		expect(extractUsageReports({ reports: fixture })).toEqual(fixture);
		expect(extractUsageReports({ accountsWithoutUsage: [] })).toEqual([]);
	});

	test("renders the filtered report with native usage bars and status colors", () => {
		const styled = formatSimpleUsageStyled(
			fixture,
			{
				bold: text => `<bold>${text}</bold>`,
				fg: (color, text) => `<${color}>${text}</${color}>`,
			},
			100,
			now,
		);

		expect(styled).toContain("Usage (simple)");
		expect(styled).toContain("51% free");
		expect(styled).toContain("██████████");
		expect(styled).not.toContain("Models with usage data");
		expect(styled).not.toContain("Spark");
		expect(styled).not.toContain("Grok Build");
		expect(styled).not.toContain("GrokTasks");
	});

	test("renders the unfiltered full view with a custom title", () => {
		const theme = {
			bold: (text: string) => `<bold>${text}</bold>`,
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		};
		const options = { title: "Usage", hideFilteredLimits: false };

		const plain = formatSimpleUsage(fixture, now, options);
		expect(plain).toContain("Usage\n");
		expect(plain).toContain("5 hours (Spark)");
		expect(plain).toContain("Grok Build");
		expect(plain).toContain("GrokTasks");

		const styled = formatSimpleUsageStyled(fixture, theme, 100, now, options);
		expect(styled).toContain("<accent>Usage</accent>");
		expect(styled).toContain("Spark");
		expect(styled).toContain("Grok Build");
		expect(styled).toContain("GrokTasks");
	});
});
