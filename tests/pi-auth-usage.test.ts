import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	collectPiAuthUsageReports,
	readClaudeCodeCredential,
	writeClaudeCodeCredential,
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

function cursorJwt(sub = "cursor-user"): string {
	const payload = Buffer.from(JSON.stringify({
		iss: "https://authentication.cursor.sh",
		aud: "https://cursor.com",
		sub,
	})).toString("base64url");
	return `eyJhbGciOiJub25lIn0.${payload}.x`;
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

	test("refreshes an expired Claude Code token before querying usage", async () => {
		const requests: Array<{ url: string; authorization?: string }> = [];
		let persisted: unknown;
		const reports = await collectPiAuthUsageReports(
			{
				readClaudeCodeCredential: () => ({
					accessToken: "expired-claude-token",
					refreshToken: "claude-refresh-token",
					expiresAt: Date.now() - 1,
				}),
				writeClaudeCodeCredential: updates => { persisted = updates; },
			},
			async (input, init) => {
				const url = String(input);
				const headers = (init?.headers ?? {}) as Record<string, string>;
				requests.push({ url, authorization: headers.authorization ?? headers.Authorization });
				if (url.endsWith("/v1/oauth/token")) {
					return jsonResponse({ access_token: "fresh-claude-token", refresh_token: "rotated-refresh-token", expires_in: 3600 });
				}
				if (url.endsWith("/api/oauth/usage")) {
					return jsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, limits: [] });
				}
				if (url.endsWith("/api/oauth/profile")) return jsonResponse({ account: { email: "fresh@example.test" } });
				return new Response("not found", { status: 404 });
			},
			"anthropic",
		);

		expect(reports[0]).toMatchObject({ provider: "anthropic", metadata: { email: "fresh@example.test" } });
		expect(requests.filter(request => request.url.includes("api.anthropic.com")).every(request => request.authorization === "Bearer fresh-claude-token")).toBe(true);
		expect(persisted).toMatchObject({ accessToken: "fresh-claude-token", refreshToken: "rotated-refresh-token" });
	});

	test("refreshes Claude Code after the usage API rejects the current token", async () => {
		let persisted: unknown;
		let usageCalls = 0;
		const reports = await collectPiAuthUsageReports(
			{
				readClaudeCodeCredential: () => ({
					accessToken: "stale-claude-token",
					refreshToken: "claude-refresh-token",
					expiresAt: Date.now() + 60_000,
				}),
				writeClaudeCodeCredential: updates => { persisted = updates; },
			},
			async (input, init) => {
				const url = String(input);
				const headers = (init?.headers ?? {}) as Record<string, string>;
				const authorization = headers.authorization ?? headers.Authorization;
				if (url.endsWith("/v1/oauth/token")) {
					return jsonResponse({ access_token: "fresh-claude-token", refresh_token: "rotated-refresh-token", expires_in: 3600 });
				}
				if (url.endsWith("/api/oauth/usage")) {
					usageCalls++;
					if (authorization !== "Bearer fresh-claude-token") return new Response("unauthorized", { status: 401 });
					return jsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 }, limits: [] });
				}
				if (url.endsWith("/api/oauth/profile")) {
					if (authorization !== "Bearer fresh-claude-token") return new Response("unauthorized", { status: 401 });
					return jsonResponse({ account: { email: "fresh@example.test" } });
				}
				return new Response("not found", { status: 404 });
			},
			"anthropic",
		);

		expect(reports[0]).toMatchObject({ provider: "anthropic", metadata: { email: "fresh@example.test" } });
		expect(usageCalls).toBeGreaterThan(1);
		expect(persisted).toMatchObject({ accessToken: "fresh-claude-token", refreshToken: "rotated-refresh-token" });
	});

	test("reads and replaces Claude Code credentials under CLAUDE_CONFIG_DIR", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-usage-claude-"));
		const previous = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = dir;
		try {
			const credentialsPath = join(dir, ".credentials.json");
			writeFileSync(credentialsPath, `${JSON.stringify({
				claudeAiOauth: {
					accessToken: "old-access",
					refreshToken: "old-refresh",
					expiresAt: 1_800_000_000_000,
				},
				other: "keep-me",
			}, null, 2)}\n`);
			expect(readClaudeCodeCredential()).toEqual({
				accessToken: "old-access",
				refreshToken: "old-refresh",
				expiresAt: 1_800_000_000_000,
			});
			writeClaudeCodeCredential({
				accessToken: "new-access",
				refreshToken: "new-refresh",
				expiresAt: 1_900_000_000_000,
			});
			const payload = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
				other: string;
				claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number };
			};
			expect(payload.other).toBe("keep-me");
			expect(payload.claudeAiOauth).toMatchObject({
				accessToken: "new-access",
				refreshToken: "new-refresh",
				expiresAt: 1_900_000_000_000,
			});
			expect(readClaudeCodeCredential()?.accessToken).toBe("new-access");
		} finally {
			if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previous;
			rmSync(dir, { recursive: true, force: true });
		}
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

	test("uses Claude Code credentials for compact Claude usage when Pi Anthropic is missing", async () => {
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
			if (url.endsWith("/api/v1/credits")) return jsonResponse({ data: { total_credits: 12.5, total_usage: 4 } });
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
			id: "openrouter:credits",
			amount: expect.objectContaining({ remaining: 8.5, unit: "usd" }),
		}));
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

	test("uses the Cursor session JWT instead of a CLIProxy API key", async () => {
		const jwt = cursorJwt();
		const requests: string[] = [];
		const reports = await collectPiAuthUsageReports(
			{
				modelRegistry: {
					getProviderAuth: async provider => provider === "cursor" ? { source: "API key", auth: { apiKey: "sk-cliproxy" } } : undefined,
				},
				readStoredCredential: provider => provider === "cursor" ? { type: "oauth", access: jwt } : undefined,
			},
			async (input, init) => {
				const headers = (init?.headers ?? {}) as Record<string, string>;
				requests.push(headers.Authorization ?? headers.authorization ?? "");
				if (String(input).includes("DashboardService/GetCurrentPeriodUsage")) {
					return jsonResponse({
						billingCycleStart: "2026-08-01T00:00:00Z",
						billingCycleEnd: "2026-09-01T00:00:00Z",
						planUsage: { totalPercentUsed: 20, autoPercentUsed: 15, apiPercentUsed: 25, limit: 40000 },
					});
				}
				return new Response("not found", { status: 404 });
			},
			"cursor",
		);
		expect(reports[0]?.provider).toBe("cursor");
		expect(requests[0]).toBe(`Bearer ${jwt}`);
		expect(requests.some(value => value.includes("sk-cliproxy"))).toBe(false);
	});

	test("treats omitted SuperGrok weekly percent as 0% for unified billing", async () => {
		const start = new Date(Date.now() - 60 * 60_000).toISOString();
		const end = new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString();
		const reports = await collectPiAuthUsageReports(
			{
				modelRegistry: {
					getProviderAuth: async provider => provider === "xai" ? { source: "OAuth", auth: { apiKey: "xai-token" } } : undefined,
				},
			},
			async input => {
				const url = String(input);
				if (url.includes("billing?format=credits")) {
					return jsonResponse({
						config: {
							currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
							onDemandCap: { val: 0 },
							onDemandUsed: { val: 0 },
							isUnifiedBillingUser: true,
							prepaidBalance: { val: 0 },
						},
					});
				}
				if (url.includes("/v1/billing")) {
					return jsonResponse({
						config: {
							monthlyLimit: { val: 0 },
							used: { val: 118 },
							billingPeriodStart: "2026-09-01T00:00:00+00:00",
							billingPeriodEnd: "2026-10-01T00:00:00+00:00",
						},
					});
				}
				if (url.endsWith("/oauth2/userinfo")) return jsonResponse({ sub: "grok-account", email: "grok@example.test" });
				return new Response("not found", { status: 404 });
			},
			"xai-oauth",
		);

		expect(reports).toHaveLength(1);
		expect(reports[0]?.error).toBeUndefined();
		expect(reports[0]?.limits[0]).toMatchObject({
			id: "xai-oauth:credits:1w",
			label: "SuperGrok Weekly Credits",
			amount: { used: 0, limit: 100, unit: "percent" },
		});
	});

	test("omits Kimi when the coding plan is exhausted", async () => {
		const reports = await collectPiAuthUsageReports(
			{
				modelRegistry: {
					getProviderAuth: async provider => provider === "kimi-coding" ? { source: "API key", auth: { apiKey: "kimi-token" } } : undefined,
				},
			},
			async () => new Response(JSON.stringify({ code: "resource_exhausted", message: "insufficient balance" }), { status: 429 }),
			"kimi-coding",
		);
		expect(reports).toEqual([]);
	});

});
