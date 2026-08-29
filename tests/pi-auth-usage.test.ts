import { describe, expect, test } from "bun:test";
import {
	collectPiAuthUsageReports,
	mergePiAuthUsageReports,
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

	test("ignores Pi API-key auth for subscription-only usage endpoints", async () => {
		let requests = 0;
		const reports = await collectPiAuthUsageReports(
			{
				modelRegistry: {
					getProviderAuth: async () => ({ source: "API key", auth: { apiKey: "not-an-oauth-token" } }),
				},
			},
			async () => {
				requests++;
				return new Response("{}", { status: 200 });
			},
		);
		expect(reports).toEqual([]);
		expect(requests).toBe(0);
	});

	test("does not fall back to an OMP report for Pi-auth providers", () => {
		const merged = mergePiAuthUsageReports(
			[
				{ provider: "anthropic", limits: [{ id: "omp-anthropic" }] },
				{ provider: "xai-oauth", limits: [{ id: "omp-grok" }] },
				{ provider: "cursor", limits: [{ id: "omp-cursor" }] },
			],
			[],
		);
		expect(merged.map(report => report.provider)).toEqual(["cursor"]);
	});
});
