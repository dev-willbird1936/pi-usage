import { describe, expect, test } from "bun:test";
import {
	collectPiAuthUsageReports,
	type PiAuthUsageContext,
} from "../src/pi-auth-usage.ts";

const accessTokens = {
	anthropic: "anthropic-pi-token",
	xai: "xai-pi-token",
};

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("Pi-auth usage collection", () => {
	test("uses Pi OAuth tokens for Claude and Grok billing requests", async () => {
		const requests: Array<{ url: string; authorization?: string }> = [];
		const context: PiAuthUsageContext = {
			modelRegistry: {
				async getProviderAuth(provider) {
					const token = accessTokens[provider as keyof typeof accessTokens];
					return token ? { source: "OAuth", auth: { apiKey: token } } : undefined;
				},
			},
		};
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			const headers = (init?.headers ?? {}) as Record<string, string>;
			requests.push({ url, authorization: headers.authorization ?? headers.Authorization });
			if (url.endsWith("/api/oauth/usage")) {
				return jsonResponse({
					five_hour: { utilization: 25, resets_at: "2026-08-21T17:00:00Z" },
					seven_day: { utilization: 40, resets_at: "2026-08-26T12:00:00Z" },
					limits: [],
				});
			}
			if (url.endsWith("/api/oauth/profile")) {
				return jsonResponse({
					account: { uuid: "claude-account", email: "claude@example.test" },
					organization: { uuid: "claude-org", name: "Claude org" },
				});
			}
			if (url.includes("billing?format=credits")) {
				return jsonResponse({
					config: {
						currentPeriod: {
							start: "2026-08-20T00:00:00Z",
							end: "2026-08-27T00:00:00Z",
							type: "WEEKLY",
						},
						creditUsagePercent: 35,
						productUsage: [],
					},
				});
			}
			if (url.endsWith("/oauth2/userinfo")) {
				return jsonResponse({ sub: "grok-account", email: "grok@example.test" });
			}
			return new Response("not found", { status: 404 });
		};

		const reports = await collectPiAuthUsageReports(context, fetchImpl);
		expect(reports.map(report => report.provider).sort()).toEqual(["anthropic", "xai-oauth"]);
		expect(reports.find(report => report.provider === "anthropic")?.metadata).toMatchObject({
			authSource: "pi",
			email: "claude@example.test",
			orgName: "Claude org",
		});
		expect(reports.find(report => report.provider === "xai-oauth")?.limits[0]).toMatchObject({
			id: "xai-oauth:credits:1w",
			amount: { used: 35 },
		});
		expect(requests.filter(request => request.url.includes("anthropic.com")).every(request => request.authorization === `Bearer ${accessTokens.anthropic}`)).toBe(true);
		expect(requests.filter(request => request.url.includes("grok.com") || request.url.includes("auth.x.ai")).every(request => request.authorization === `Bearer ${accessTokens.xai}`)).toBe(true);
	});

	test("collects Claude usage through the bridge provider even when its model is hidden", async () => {
		const requests: Array<{ url: string; authorization?: string }> = [];
		const reports = await collectPiAuthUsageReports(
			{
				readClaudeCodeAccessToken: () => "claude-code-token",
			},
			async (input, init) => {
				const url = String(input);
				const headers = (init?.headers ?? {}) as Record<string, string>;
				requests.push({ url, authorization: headers.authorization ?? headers.Authorization });
				if (url.endsWith("/api/oauth/usage")) {
					return jsonResponse({
						five_hour: { utilization: 12, resets_at: "2026-08-21T17:00:00Z" },
						seven_day: { utilization: 34, resets_at: "2026-08-26T12:00:00Z" },
						limits: [],
					});
				}
				if (url.endsWith("/api/oauth/profile")) return jsonResponse({ account: { email: "bridge@example.test" } });
				return new Response("not found", { status: 404 });
			},
			"claude-bridge",
		);

		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			provider: "anthropic",
			metadata: { authSource: "claude-code", email: "bridge@example.test" },
		});
		expect(reports[0]?.limits).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "anthropic:5h", amount: expect.objectContaining({ used: 12 }) }),
			expect.objectContaining({ id: "anthropic:7d", amount: expect.objectContaining({ used: 34 }) }),
		]));
		expect(requests.every(request => request.authorization === "Bearer claude-code-token")).toBe(true);
	});

	test("ignores Pi API-key auth for subscription-only usage endpoints", async () => {
		let requests = 0;
		const reports = await collectPiAuthUsageReports(
			{
				modelRegistry: {
					getProviderAuth: async provider => provider === "anthropic" ? { source: "API key", auth: { apiKey: "not-an-oauth-token" } } : undefined,
				},
			},
			async () => {
				requests++;
				return new Response("{}", { status: 200 });
			},
			"anthropic",
		);
		expect(reports).toEqual([]);
		expect(requests).toBe(0);
	});

	test("prefers registry OAuth so Pi can refresh expired stored credentials", async () => {
		const requests: Array<{ url: string; authorization?: string }> = [];
		const context: PiAuthUsageContext = {
			modelRegistry: {
				getProviderAuth: async provider => provider === "cursor" ? { source: "OAuth", auth: { apiKey: "stale-registry-token" } } : undefined,
			},
			readStoredCredential: provider => provider === "cursor" ? { type: "oauth", access: "cursor-token" } : undefined,
		};
		const reports = await collectPiAuthUsageReports(context, async (input, init) => {
			const url = String(input);
			const headers = (init?.headers ?? {}) as Record<string, string>;
			requests.push({ url, authorization: headers.Authorization ?? headers.authorization });
			if (url.includes("DashboardService/GetCurrentPeriodUsage")) {
				return jsonResponse({
					billingCycleStart: "2026-08-01T00:00:00Z",
					billingCycleEnd: "2026-09-01T00:00:00Z",
					planUsage: { totalPercentUsed: 20, autoPercentUsed: 15, apiPercentUsed: 25, limit: 40000 },
				});
			}
			return new Response("not found", { status: 404 });
		}, "cursor");

		expect(reports[0]?.provider).toBe("cursor");
		expect(reports[0]?.limits.map(limit => limit.label)).toEqual(["Cursor included usage", "Cursor Models", "Other Models"]);
		expect(requests[0]?.authorization).toBe("Bearer stale-registry-token");
	});

	test("rejects an expired stored OAuth fallback", async () => {
		const reports = await collectPiAuthUsageReports(
			{
				readStoredCredential: provider => provider === "cursor" ? { type: "oauth", access: "expired-token", expires: Date.now() - 1 } : undefined,
			},
			async () => jsonResponse({}),
			"cursor",
		);
		expect(reports).toEqual([]);
	});

	test("reports provider HTTP failures instead of hiding signed-in accounts", async () => {
		const reports = await collectPiAuthUsageReports(
			{
				modelRegistry: {
					getProviderAuth: async provider => provider === "cursor" ? { source: "OAuth", auth: { apiKey: "cursor-token" } } : undefined,
				},
			},
			async () => new Response("rate limited", { status: 429 }),
			"cursor",
		);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ provider: "cursor", error: expect.stringContaining("HTTP 429") });
	});

	test("does not use Claude Code credentials without an explicit bridge request", async () => {
		const reports = await collectPiAuthUsageReports(
			{ readClaudeCodeAccessToken: () => "bridge-token" },
			async () => jsonResponse({
				five_hour: { utilization: 10 },
				seven_day: { utilization: 20 },
				limits: [],
			}),
			"anthropic",
		);
		expect(reports).toEqual([]);
	});

	test("uses Pi credentials for every verified direct collector", async () => {
		const tokens: Record<string, string> = {
			anthropic: "anthropic-token",
			cursor: "cursor-token",
			deepseek: "deepseek-token",
			"kimi-coding": "kimi-token",
			"openai-codex": "codex-token",
			openrouter: "openrouter-token",
			"opencode-go": "opencode-token",
			xai: "xai-token",
		};
		const requests: Array<{ url: string; method?: string; headers: Record<string, string>; body?: string }> = [];
		const context: PiAuthUsageContext = {
			modelRegistry: {
				async getProviderAuth(provider) {
					const token = tokens[provider];
					return token ? { source: provider === "cursor" ? "stored credential" : "OAuth", auth: { apiKey: token } } : undefined;
				},
			},
		};
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			const headers = Object.fromEntries(new Headers(init?.headers).entries());
			requests.push({ url, method: init?.method, headers, body: typeof init?.body === "string" ? init.body : undefined });
			if (url.endsWith("/api/oauth/usage")) return jsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, limits: [] });
			if (url.endsWith("/api/oauth/profile")) return jsonResponse({});
			if (url.includes("api2.cursor.sh")) return jsonResponse({
				billingCycleStart: "2026-08-01T00:00:00Z",
				billingCycleEnd: "2026-09-01T00:00:00Z",
				planUsage: { totalPercentUsed: 15, autoPercentUsed: 10, apiPercentUsed: 5 },
				individualUsage: { onDemand: { used: 10, limit: 100 } },
			});
			if (url.endsWith("/user/balance")) return jsonResponse({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "10.00", granted_balance: "1.00", topped_up_balance: "9.00" }] });
			if (url.endsWith("/coding/v1/usages")) return jsonResponse({ usage: { used: "10", limit: "100" }, limits: [] });
			if (url.includes("chatgpt.com/backend-api/wham/usage")) return jsonResponse({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000 }, secondary_window: { used_percent: 30, limit_window_seconds: 604_800 } } });
			if (url.endsWith("/api/v1/key")) return jsonResponse({ data: { limit: 10, limit_remaining: 8 } });
			if (url.endsWith("/zen/go/v1/usage")) return jsonResponse({ usage: { rolling: { percent: 10 }, weekly: { percent: 20 }, monthly: { percent: 30 } } });
			if (url.includes("billing?format=credits")) return jsonResponse({ config: { currentPeriod: { start: "2026-08-20T00:00:00Z", end: "2026-08-27T00:00:00Z" }, creditUsagePercent: 35, productUsage: [] } });
			if (url.endsWith("/oauth2/userinfo")) return jsonResponse({ sub: "grok-account" });
			return new Response("not found", { status: 404 });
		};

		const reports = await collectPiAuthUsageReports(context, fetchImpl);
		expect(reports.map(report => report.provider).sort()).toEqual([
			"anthropic",
			"cursor",
			"deepseek",
			"kimi-coding",
			"openai-codex",
			"opencode-go",
			"openrouter",
			"xai-oauth",
		]);
		expect(requests.find(request => request.url.includes("api2.cursor.sh"))).toMatchObject({
			method: "POST",
			body: "{}",
		});
		expect(requests.find(request => request.url.includes("api2.cursor.sh"))?.headers).toMatchObject({
			"connect-protocol-version": "1",
		});
		expect(reports.find(report => report.provider === "cursor")?.limits).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "cursor:usd:individual-auto", label: "Cursor Models" }),
			expect.objectContaining({ id: "cursor:usd:individual-api", label: "Other Models" }),
		]));
		expect(reports.find(report => report.provider === "kimi-coding")?.limits[0]).toMatchObject({
			id: "kimi-coding:weekly",
			label: "Total quota",
			amount: { unit: "unknown" },
		});
		expect(requests.find(request => request.url.includes("chatgpt.com/backend-api"))?.headers).toMatchObject({
			authorization: "Bearer codex-token",
			originator: "pi",
		});
		expect(reports.find(report => report.provider === "openai-codex")?.limits.find(limit => limit.window?.durationMs === 604_800_000)).toMatchObject({
			label: "7 days",
		});
		expect(reports.find(report => report.provider === "openrouter")?.limits).toContainEqual(expect.objectContaining({
			id: "openrouter:key-limit",
			amount: expect.objectContaining({ used: 2, limit: 10, remaining: 8, unit: "usd" }),
		}));
		for (const [host, token] of Object.entries({
			"api2.cursor.sh": "cursor-token",
			"api.deepseek.com": "deepseek-token",
			"api.kimi.com": "kimi-token",
			"chatgpt.com": "codex-token",
			"openrouter.ai": "openrouter-token",
			"opencode.ai": "opencode-token",
			"cli-chat-proxy.grok.com": "xai-token",
		})) {
			expect(requests.filter(request => request.url.includes(host)).every(request => request.headers.authorization === `Bearer ${token}`)).toBe(true);
		}
	});

});
