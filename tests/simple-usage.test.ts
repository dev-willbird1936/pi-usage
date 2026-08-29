import { describe, expect, test } from "bun:test";
import {
	estimateRemainingQuotaTime,
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

	test("keeps main programming windows and hides Claude detail buckets", () => {
		const report: SimpleUsageReport = {
			provider: "anthropic",
			limits: [
				{ id: "anthropic:5h", label: "Claude 5 Hour", amount: { used: 10, limit: 100, unit: "percent" } },
				{ id: "anthropic:7d", label: "Claude 7 Day", amount: { used: 20, limit: 100, unit: "percent" } },
				{ id: "anthropic:7d:fable", label: "Claude 7 Day (Fable)", amount: { used: 30, limit: 100, unit: "percent" } },
			],
		};
		const output = formatSimpleUsage([report], now);
		expect(output).toContain("Claude 7 Day");
		expect(output).toContain("Claude 5 Hour");
		expect(output).not.toContain("Fable");
		expect(output).toContain("Total usage");
		expect(output).toContain("15% used · 85% left · 2 quotas");
		expect(isHiddenSimpleLimit({ provider: "cursor" }, {
			id: "cursor:short",
			window: { durationMs: 5 * 60 * 60 * 1000 },
		})).toBe(true);
		const full = formatSimpleUsage([report], now, { title: "Usage", hideFilteredLimits: false });
		expect(full).toContain("Claude 5 Hour");
		expect(full).toContain("Fable");
	});

	test("keeps every provider's primary subscription quota across the supported matrix", () => {
		const hidden: Array<[string, string, Record<string, unknown>?]> = [
			// [provider, hidden limit id, extra limit fields]
			["xai-oauth", "xai-oauth:product:api:1w"],
			["github-copilot", "copilot:model:gpt-5"],
			["zai", "zai:features:zread:7d"],
			["umans", "umans:concurrency"],
			["anthropic", "anthropic:7d:fable"],
			["anthropic", "anthropic:7d:opus"],
			["minimax-code", "general:5h"],
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
			["anthropic", "anthropic:7d"],
			["anthropic", "anthropic:5h"],
			["anthropic", "anthropic:extra"],
			["xai-oauth", "xai-oauth:credits:1w"],
			["xai-oauth", "xai-oauth:included:1mo"],
			["xai-oauth", "xai-oauth:on-demand"],
			["github-copilot", "copilot:premium"],
			["github-copilot", "copilot:chat"],
			["github-copilot", "copilot:completions"],
			["zai", "zai:tokens:7d"],
			["zai", "zai:requests:7d"],
			["umans", "umans:requests"],
			["umans", "umans:requests:soft"],
			["umans", "umans:requests:hard"],
			["opencode-go", "monthly"],
			["alibaba-token-plan", "credits:7d"],
			["kimi-code", "kimi-code:0"],
			["minimax-code", "general:7d"],
			["google-gemini-cli", "gemini-3-pro:quota"],
			["google-antigravity", "google-antigravity:default:default:7d"],
			["synthetic", "synthetic:usd:7d"],
			["cursor", "cursor:on-demand"],
		];
		for (const [provider, id] of kept) {
			expect(isHiddenSimpleLimit({ provider }, { id })).toBe(false);
		}
		expect(isHiddenSimpleLimit({ provider: "openai-codex" }, { id: "openai-codex:primary", window: { durationMs: 5 * 60 * 60 * 1000 } })).toBe(false);
		expect(isHiddenSimpleLimit({ provider: "opencode-go" }, { id: "opencode-go:monthly" })).toBe(false);
		expect(isHiddenSimpleLimit({ provider: "deepseek" }, { id: "deepseek:usd:granted_balance" })).toBe(true);
		expect(isHiddenSimpleLimit({ provider: "openrouter" }, { id: "openrouter:usage:monthly" })).toBe(true);
		expect(isHiddenSimpleLimit({ provider: "cursor" }, { id: "cursor:auto" })).toBe(true);
		expect(isHiddenSimpleLimit({ provider: "cursor" }, { id: "cursor:api" })).toBe(true);
		expect(isHiddenSimpleLimit({ provider: "kimi-coding", limits: [{ id: "kimi-coding:weekly" }] }, { id: "kimi-coding:detail:300:0" })).toBe(true);
		expect(isHiddenSimpleLimit({ provider: "kimi-coding" }, { id: "kimi-coding:detail:300:0", window: { durationMs: 5 * 60 * 60 * 1000 } })).toBe(false);
	expect(isHiddenSimpleLimit({ provider: "kimi-coding" }, { id: "kimi-coding:wallet:used" })).toBe(true);
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
			{ provider: "minimax-code", limits: [{ id: "general:7d", label: "General 7 Day" }] },
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

	test("forecasts remaining quota time from the observed window burn rate", () => {
		const limit = {
			id: "openai-codex:primary",
			label: "7 days",
			amount: { used: 50, limit: 100, unit: "percent" },
			window: { durationMs: 7 * 24 * 60 * 60 * 1000, resetsAt: now + 5 * 24 * 60 * 60 * 1000 },
		};
		const estimate = estimateRemainingQuotaTime(limit, now);
		expect(estimate).toEqual({ milliseconds: 2 * 24 * 60 * 60 * 1000 });

		const oneDayInAt25Percent = estimateRemainingQuotaTime({
			...limit,
			amount: { used: 25, limit: 100, unit: "percent" },
			window: { durationMs: 7 * 24 * 60 * 60 * 1000, resetsAt: now + 6 * 24 * 60 * 60 * 1000 },
		}, now);
		expect(oneDayInAt25Percent).toEqual({ milliseconds: 3 * 24 * 60 * 60 * 1000 });

		const slowBurn = estimateRemainingQuotaTime(
			{ ...limit, amount: { used: 10, limit: 100, unit: "percent" } },
			now,
		);
		expect(slowBurn).toEqual({ milliseconds: 18 * 24 * 60 * 60 * 1000 });

		const plain = formatSimpleUsage([{ provider: "openai-codex", limits: [limit] }], now);
		expect(plain).toContain("REMAINING: ~2d");
		const styled = formatSimpleUsageStyled(
			[{ provider: "openai-codex", limits: [limit] }],
			{ bold: text => text, fg: (_color, text) => text },
			100,
			now,
		);
		expect(styled).toContain("REMAINING: ~2d");
	});

	test("adds simple-view totals for percentages and quantities", () => {
		const plain = formatSimpleUsage(fixture, now);
		expect(plain).toContain("Total usage\n  69% used · 31% left · 2 quotas");

		const styled = formatSimpleUsageStyled(
			fixture,
			{ bold: text => text, fg: (_color, text) => text },
			100,
			now,
		);
		expect(styled).toContain("Total usage");
		expect(styled).toContain("69% used · 31% left · 2 quotas");

		const money = formatSimpleUsage(
			[{ provider: "cursor", limits: [{ id: "cursor:usd:meter", label: "Usage", amount: { used: 2, limit: 10, unit: "usd" } }] }],
			now,
		);
		expect(money).toContain("$2 / $10 · 20% used · $8 left · 1 quota");

		const full = formatSimpleUsage(fixture, now, { title: "Usage", hideFilteredLimits: false });
		expect(full).not.toContain("Total usage");
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

		expect(styled).toContain("Usage");
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
