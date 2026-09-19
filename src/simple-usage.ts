export interface SimpleUsageAmount {
	used?: number;
	limit?: number;
	remaining?: number;
	usedFraction?: number;
	remainingFraction?: number;
	unit?: string;
}

export interface SimpleUsageScope {
	modelId?: string;
	tier?: string;
	windowId?: string;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	shared?: boolean;
}

export interface SimpleUsageWindow {
	id?: string;
	label?: string;
	/** Full quota-window length when supplied by the provider. */
	durationMs?: number;
	resetsAt?: number;
	resetLabel?: string;
}

export interface SimpleUsageLimit {
	id?: string;
	label?: string;
	scope?: SimpleUsageScope | null;
	window?: SimpleUsageWindow | null;
	amount?: SimpleUsageAmount | null;
	status?: string;
	resetsAt?: number;
}

export interface SimpleUsageReport {
	provider: string;
	fetchedAt?: number;
	limits?: SimpleUsageLimit[];
	notes?: string[];
	error?: string;
	metadata?: Record<string, unknown> | null;
}

export type SimpleUsageThemeColor = "accent" | "dim" | "success" | "warning" | "error";

/** The small part of Pi's Theme used by the usage renderer. */
export interface SimpleUsageTheme {
	bold(text: string): string;
	fg(color: SimpleUsageThemeColor, text: string): string;
}

/** Presentation options shared by both simple-usage renderers. */
export interface SimpleUsageViewOptions {
	/** Header line; defaults to the compact view title. */
	title?: string;
	/** Hide provider detail buckets; defaults to true. */
	hideFilteredLimits?: boolean;
}

const DEFAULT_USAGE_TITLE = "Usage · compact";

const PROVIDER_LABELS: Record<string, string> = {
	"alibaba-token-plan": "Alibaba",
	anthropic: "Claude",
	"claude-bridge": "Claude",
	cursor: "Cursor",
	"github-copilot": "GitHub Copilot",
	"google-antigravity": "Antigravity",
	"google-gemini-cli": "Gemini",
	"kimi-code": "Kimi",
	"kimi-coding": "Kimi",
	"minimax-code": "MiniMax",
	ollama: "Ollama",
	"ollama-cloud": "Ollama Cloud",
	"openai-codex": "Codex",
	deepseek: "DeepSeek",
	openrouter: "OpenRouter",
	"opencode-go": "OpenCode Go",
	synthetic: "Synthetic",
	umans: "Umans",
	"xai-oauth": "Grok",
	zai: "Z.ai",
};

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const SHORT_WINDOW_MAX_MS = 24 * 60 * 60_000;
const SHORT_WINDOW_PATTERN = /\b(?:\d+(?:\.\d+)?\s*(?:h|hr|hrs|hour|hours)|hour(?:s|ly)?)\b/i;

const textValue = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
};

function isXaiProvider(provider: string): boolean {
	return provider === "xai-oauth" || provider === "xai" || provider.includes("grok");
}

/**
 * True when a limit is noise for the default programming-quota view. Kept
 * rows are the provider's main quota or usable balance; detail rows and
 * accounting breakdowns stay in the expanded view.
 */
export function isHiddenSimpleLimit(report: SimpleUsageReport, limit: SimpleUsageLimit): boolean {
	const provider = report.provider.toLowerCase();
	const id = (limit.id ?? "").toLowerCase();

	const windowDuration = limit.window?.durationMs;
	const windowDescription = [limit.window?.id, limit.window?.label, limit.scope?.windowId, limit.label, limit.id]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	if ((finite(windowDuration) && windowDuration > 0 && windowDuration <= SHORT_WINDOW_MAX_MS) || SHORT_WINDOW_PATTERN.test(windowDescription)) {
		return true;
	}

	// Claude's model buckets are detail rows; the account-level weekly quota
	// remains visible in the compact view.
	const isClaudeProvider = provider === "anthropic" || provider === "claude-bridge";
	if (isClaudeProvider && (id.startsWith("anthropic:7d:") || /\bfable\b/i.test(`${id} ${limit.label ?? ""} ${limit.scope?.tier ?? ""}`))) return true;

	// Codex metered-feature buckets (Spark and any future meters): the shared
	// primary/secondary windows carry the subscription quota; tiered buckets
	// only restate them per feature. Credits are a usable API balance, so keep
	// that row in the compact view.
	if (provider === "openai-codex") {
		if (limit.scope?.tier) return true;
		return id !== "openai-codex:credits" && `${id} ${limit.label ?? ""}`.toLowerCase().includes("spark");
	}

	// Kimi's detail windows are real programming quotas; hide only a detail row
	// that repeats the weekly summary. Extra balance is usable; its accounting
	// components stay expanded-only.
	if (provider === "kimi-coding" && id.startsWith("kimi-coding:detail:")) {
		const weekly = (report.limits ?? []).find(item => item.id?.toLowerCase() === "kimi-coding:weekly");
		if (weekly && (!limit.window?.durationMs || !weekly.window?.durationMs || limit.window.durationMs === weekly.window.durationMs)) return true;
	}
	if (provider === "kimi-coding" && id.startsWith("kimi-coding:wallet:") && id !== "kimi-coding:wallet:balance") return true;

	// OpenRouter's usage_* fields are spend analytics, not a remaining quota.
	// The key spending cap is expanded-only when account credits are present.
	if (provider === "openrouter" && id.startsWith("openrouter:usage:")) return true;
	if (provider === "openrouter" && id === "openrouter:key-limit" && (report.limits ?? []).some(item => item.id === "openrouter:credits")) return true;

	// DeepSeek's granted/topped-up balances are components of total balance.
	if (provider === "deepseek" && (id.includes(":granted_balance") || id.includes(":topped_up_balance"))) return true;

	// xAI per-product credit splits (Grok Build, GrokTasks, API, ...): the
	// overall SuperGrok credits row already aggregates them.
	if (isXaiProvider(provider) && id.includes(":product:")) return true;

	// Copilot per-model billing items: Premium Requests (plus Chat/Completions
	// when limited) is the plan quota; per-model gross quantities are noise.
	if (provider === "github-copilot" && id.startsWith("copilot:model:")) return true;

	// Z.ai feature quotas (zread/search bundle), unrelated to coding tokens.
	if (provider === "zai" && id.startsWith("zai:features:")) return true;

	// Umans concurrency is an instantaneous gauge, not a windowed quota.
	if (provider === "umans" && id === "umans:concurrency") return true;

	// OpenCode Go monthly is display-only: an exhausted monthly never blocks.
	if (provider === "opencode-go" && (id === "monthly" || id === "opencode-go:monthly" || limit.window?.id === "monthly")) return true;

	return false;
}

/** Cursor rows that merely aggregate the itemized meters. */
function isCursorAggregateLimit(limit: SimpleUsageLimit): boolean {
	const id = (limit.id ?? "").toLowerCase();
	return id === "cursor:plan" || id === "cursor:usd:individual-plan" || id === "cursor:usd:individual-overall";
}

/**
 * Limits visible in the compact view. Context-aware: a Cursor aggregate row
 * ("Personal Usage") is dropped only when the report also carries the
 * itemized meters it duplicates, so a plan with nothing else still renders.
 * Provider-specific detail rows are omitted; longer quota windows stay.
 */
export function filterSimpleLimits(report: SimpleUsageReport): SimpleUsageLimit[] {
	const limits = (report.limits ?? []).filter(limit => !isHiddenSimpleLimit(report, limit));
	if (report.provider.toLowerCase() !== "cursor") return limits;
	const hasPlanDetails = limits.some(limit => {
		const id = (limit.id ?? "").toLowerCase();
		return id === "cursor:usd:individual-auto" || id === "cursor:usd:individual-api";
	});
	return hasPlanDetails ? limits.filter(limit => !isCursorAggregateLimit(limit)) : limits;
}

function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider.toLowerCase()] ??
		provider
			.split(/[-_]/g)
			.filter(Boolean)
			.map(part => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
}

function isEmptyUsageReport(report: SimpleUsageReport): boolean {
	return (report.limits ?? []).length === 0;
}

function usedFraction(limit: SimpleUsageLimit): number | undefined {
	const amount = limit.amount;
	if (!amount) return undefined;
	if (finite(amount.usedFraction)) return amount.usedFraction;
	if (finite(amount.used) && finite(amount.limit) && amount.limit !== 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && finite(amount.used)) return amount.used / 100;
	if (finite(amount.remainingFraction)) return 1 - amount.remainingFraction;
	if (finite(amount.remaining) && finite(amount.limit) && amount.limit !== 0) {
		return (amount.limit - amount.remaining) / amount.limit;
	}
	return undefined;
}

function remainingFraction(limit: SimpleUsageLimit, used: number | undefined): number | undefined {
	const amount = limit.amount;
	if (!amount) return undefined;
	if (finite(amount.remainingFraction)) return amount.remainingFraction;
	if (used !== undefined) return 1 - used;
	if (finite(amount.remaining) && finite(amount.limit) && amount.limit !== 0) {
		return amount.remaining / amount.limit;
	}
	return undefined;
}

function decimal(value: number, maximumFractionDigits = 2): string {
	return new Intl.NumberFormat("en-US", { maximumFractionDigits }).format(value);
}

function percent(fraction: number): string {
	return `${decimal(fraction * 100, fraction * 100 >= 10 ? 1 : 2)}%`;
}

function quantity(value: number, unit: string | undefined): string {
	if (unit === "usd") return `$${decimal(value, 2)}`;
	if (unit === "tokens") return `${decimal(value, 0)} tokens`;
	if (unit === "requests") return `${decimal(value, 0)} requests`;
	if (unit === "minutes") return `${decimal(value, 1)} minutes`;
	if (unit === "bytes") return `${decimal(value, 0)} bytes`;
	return decimal(value, 2);
}

function duration(milliseconds: number): string {
	const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

export interface SimpleRemainingEstimate {
	/** Projected time until the quota is exhausted at the current burn rate. */
	milliseconds: number;
}

function inferredWindowDuration(limit: SimpleUsageLimit, resetAt?: number): number | undefined {
	const declared = limit.window?.durationMs;
	if (finite(declared) && declared > 0) return declared;

	const description = [limit.window?.label, limit.scope?.windowId, limit.label, limit.id]
		.filter((value): value is string => typeof value === "string")
		.join(" ")
		.toLowerCase();
	if (/month|monthly/.test(description)) {
		if (resetAt !== undefined) {
			const start = new Date(resetAt);
			start.setUTCMonth(start.getUTCMonth() - 1);
			const durationMs = resetAt - start.getTime();
			if (finite(durationMs) && durationMs > 0) return durationMs;
		}
		return 30 * 24 * 60 * 60_000;
	}
	if (/week|weekly/.test(description)) return 7 * 24 * 60 * 60_000;
	const match = /\b(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|days?|d|minutes?|mins?|m)\b/i.exec(description);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const unit = match[2].toLowerCase();
	if (unit.startsWith("d")) return value * 24 * 60 * 60_000;
	if (unit.startsWith("h")) return value * 60 * 60_000;
	return value * 60_000;
}

/**
 * Forecast the time until quota exhaustion at the observed average consumption
 * rate for this window. The reset countdown remains separate in the display;
 * this value intentionally reports the pure burn-rate projection even when it
 * falls after the provider reset.
 */
export function estimateRemainingQuotaTime(limit: SimpleUsageLimit, now = Date.now()): SimpleRemainingEstimate | undefined {
	const resetAt = limit.window?.resetsAt ?? limit.resetsAt;
	const used = usedFraction(limit);
	if (!finite(resetAt) || resetAt <= now || used === undefined) return undefined;
	const durationMs = inferredWindowDuration(limit, resetAt);
	if (durationMs === undefined || durationMs <= 0) return undefined;

	const remainingUntilReset = Math.max(resetAt - now, 0);
	const elapsed = Math.max(0, durationMs - Math.min(remainingUntilReset, durationMs));
	const clampedUsed = Math.min(Math.max(used, 0), 1);
	if (clampedUsed === 0 || elapsed === 0) return undefined;

	const projectedUntilExhausted = elapsed * ((1 - clampedUsed) / clampedUsed);
	if (!Number.isFinite(projectedUntilExhausted)) return undefined;
	return { milliseconds: Math.max(0, projectedUntilExhausted) };
}

function cleanLabel(value: unknown): string {
	return String(value ?? "quota").replace(/[\r\n]+/g, " ").trim() || "quota";
}

type SimpleDisplayStatus = "ok" | "warning" | "exhausted" | "neutral" | "unknown";

const TOTAL_QUANTITY_UNITS = new Set(["usd", "tokens", "requests", "minutes", "bytes"]);

const BAR_WIDTH_MAX = 24;
const BAR_WIDTH_MIN = 8;
const LABEL_WIDTH_MAX = 30;
const VALUE_WIDTH_MAX = 22;
const RENDER_WIDTH_MAX = 110;
const RENDER_WIDTH_MIN = 46;
const CHAT_RENDER_WIDTH = 76;

const PLAIN_THEME: SimpleUsageTheme = { bold: text => text, fg: (_color, text) => text };

function isUsedOnlyAbsoluteAmount(limit: SimpleUsageLimit): boolean {
	const amount = limit.amount;
	return Boolean(
		amount &&
		amount.unit !== "percent" &&
		amount.unit !== "unknown" &&
		finite(amount.used) &&
		!finite(amount.limit) &&
		!finite(amount.remaining) &&
		!finite(amount.usedFraction),
	);
}

function displayStatus(limit: SimpleUsageLimit): SimpleDisplayStatus {
	const status = limit.status?.toLowerCase();
	if (status === "exhausted") return "exhausted";
	if (status === "warning") return "warning";
	if (status === "ok") return "ok";

	const used = usedFraction(limit);
	if (used !== undefined && used >= 1) return "exhausted";
	if (used !== undefined && used >= 0.8) return "warning";
	if (used !== undefined) return "ok";
	if (isUsedOnlyAbsoluteAmount(limit)) return "neutral";
	return "unknown";
}

function statusIcon(status: SimpleDisplayStatus, uiTheme: SimpleUsageTheme): string {
	if (status === "exhausted") return uiTheme.fg("error", "✗");
	if (status === "warning") return uiTheme.fg("warning", "!");
	if (status === "ok") return uiTheme.fg("success", "✓");
	return uiTheme.fg("dim", "·");
}

function statusColor(status: SimpleDisplayStatus): SimpleUsageThemeColor {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

function isQuantityUnit(unit: string | undefined): unit is string {
	return typeof unit === "string" && TOTAL_QUANTITY_UNITS.has(unit.toLowerCase());
}

/** The headline number for a limit: what is still available. */
function headlineValue(limit: SimpleUsageLimit): string {
	const amount = limit.amount;
	if (!amount) return "";
	if (isUsedOnlyAbsoluteAmount(limit)) return `${quantity(amount.used!, amount.unit)} used`;
	if (finite(amount.limit) && !finite(amount.used) && !finite(amount.remaining)) {
		return `${quantity(amount.limit, amount.unit)} limit`;
	}
	if (isQuantityUnit(amount.unit) && finite(amount.used) && finite(amount.limit)) {
		return `${quantity(Math.max(0, amount.limit - amount.used), amount.unit)} left`;
	}
	if (finite(amount.remaining) && amount.unit !== "percent" && amount.unit !== "unknown") {
		return `${quantity(amount.remaining, amount.unit)} left`;
	}
	const left = remainingFraction(limit, usedFraction(limit));
	return left === undefined ? "" : `${percent(Math.max(0, left))} free`;
}

/** Supporting numbers for the dim detail line under a limit. */
function detailValue(limit: SimpleUsageLimit): string {
	const amount = limit.amount;
	if (!amount) return "";
	const used = usedFraction(limit);
	if (isQuantityUnit(amount.unit) && finite(amount.used) && finite(amount.limit)) {
		const ratio = `${quantity(amount.used, amount.unit)} / ${quantity(amount.limit, amount.unit)}`;
		return used === undefined ? ratio : `${ratio} · ${percent(used)} used`;
	}
	return used === undefined ? "" : `${percent(used)} used`;
}

function resetText(limit: SimpleUsageLimit, now: number): string {
	const resetAt = limit.window?.resetsAt ?? limit.resetsAt;
	if (!finite(resetAt)) return "";
	const verb = limit.window?.resetLabel ?? "resets";
	return resetAt <= now ? `${verb} now` : `${verb} in ${duration(resetAt - now)}`;
}

function runsOutText(limit: SimpleUsageLimit, now: number): string {
	const estimate = estimateRemainingQuotaTime(limit, now);
	return estimate && estimate.milliseconds > 0 ? `runs out in ~${duration(estimate.milliseconds)}` : "";
}

function limitTitle(limit: SimpleUsageLimit): string {
	const label = cleanLabel(limit.label ?? limit.window?.label ?? limit.id);
	const tier = textValue(limit.scope?.tier);
	if (tier && !label.toLowerCase().includes(tier.toLowerCase())) return `${label} (${tier})`;
	return label;
}

function windowKey(limit: SimpleUsageLimit): string {
	return cleanLabel(limit.window?.id ?? limit.scope?.windowId ?? limit.window?.label ?? "default");
}

function windowSuffix(limit: SimpleUsageLimit, label: string): string {
	const windowLabel = cleanLabel(limit.window?.label ?? limit.scope?.windowId ?? "default");
	const normalized = windowLabel.toLowerCase();
	if (normalized === "default" || normalized === "quota window") return "";
	return label.toLowerCase().includes(normalized) ? "" : windowLabel;
}

function visibleWidth(value: string): number {
	return Array.from(value.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")).length;
}

function truncate(value: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(value) <= width) return value;
	if (width === 1) return "…";
	return `${Array.from(value).slice(0, width - 1).join("")}…`;
}

function padEnd(value: string, width: number): string {
	const padding = width - visibleWidth(value);
	return padding > 0 ? `${value}${" ".repeat(padding)}` : value;
}

function padStart(value: string, width: number): string {
	const padding = width - visibleWidth(value);
	return padding > 0 ? `${" ".repeat(padding)}${value}` : value;
}

function orgSuffix(report: SimpleUsageReport): string {
	const org = textValue(report.metadata?.orgName) ?? textValue(report.metadata?.orgId);
	return org ? ` (${org})` : "";
}

/** Human identity for an account, or undefined when the provider reports none. */
function accountIdentity(report: SimpleUsageReport, limit?: SimpleUsageLimit): string | undefined {
	const metadata = report.metadata;
	const email = textValue(metadata?.email);
	if (email) return `${email}${orgSuffix(report)}`;
	const accountId = textValue(metadata?.accountId) ?? textValue(limit?.scope?.accountId);
	if (accountId) return `${accountId}${orgSuffix(report)}`;
	const projectId = textValue(metadata?.projectId) ?? textValue(limit?.scope?.projectId);
	if (projectId) return projectId;
	const org = textValue(metadata?.orgName) ?? textValue(metadata?.organization);
	return org ?? textValue(metadata?.planType);
}

function renderBar(limit: SimpleUsageLimit, uiTheme: SimpleUsageTheme, width: number): string {
	const fraction = usedFraction(limit);
	if (fraction === undefined) return uiTheme.fg("dim", "·".repeat(width));

	const clamped = Math.min(Math.max(fraction, 0), 1);
	const exact = clamped * width;
	const fullCells = Math.floor(exact);
	const remainder = exact - fullCells;
	const partial = remainder >= 2 / 3 ? "▓" : remainder >= 1 / 3 ? "▒" : "";
	const leading = "█".repeat(fullCells) + partial;
	const empty = "░".repeat(Math.max(0, width - fullCells - (partial ? 1 : 0)));
	return `${uiTheme.fg(statusColor(displayStatus(limit)), leading)}${uiTheme.fg("dim", empty)}`;
}

function quotaCount(count: number): string {
	return `${count} ${count === 1 ? "quota" : "quotas"}`;
}

/** Aggregate visible limits without mixing incompatible units. */
function totalUsageLines(limits: readonly SimpleUsageLimit[]): string[] {
	const lines: string[] = [];
	const percentageLimits = limits.filter(limit => {
		const fraction = usedFraction(limit);
		if (fraction === undefined) return false;
		const amount = limit.amount;
		return !(amount && finite(amount.used) && finite(amount.limit) && amount.limit > 0 && isQuantityUnit(amount.unit));
	});
	if (percentageLimits.length > 0) {
		const used = percentageLimits
			.map(limit => Math.min(Math.max(usedFraction(limit) ?? 0, 0), 1))
			.reduce((sum, fraction) => sum + fraction, 0) / percentageLimits.length;
		lines.push(`${percent(used)} used · ${percent(Math.max(0, 1 - used))} left · ${quotaCount(percentageLimits.length)}`);
	}

	const amounts = new Map<string, { used: number; limit: number; count: number }>();
	for (const limit of limits) {
		const amount = limit.amount;
		const unit = typeof amount?.unit === "string" ? amount.unit.toLowerCase() : undefined;
		if (!amount || !isQuantityUnit(unit) || !finite(amount.used) || !finite(amount.limit) || amount.limit <= 0) continue;
		const total = amounts.get(unit) ?? { used: 0, limit: 0, count: 0 };
		total.used += amount.used;
		total.limit += amount.limit;
		total.count++;
		amounts.set(unit, total);
	}
	for (const [unit, total] of amounts) {
		const used = Math.min(Math.max(total.used / total.limit, 0), 1);
		lines.push(
			`${quantity(total.used, unit)} / ${quantity(total.limit, unit)} · ${percent(used)} used · ${quantity(Math.max(0, total.limit - total.used), unit)} left · ${quotaCount(total.count)}`,
		);
	}

	const usedOnly = new Map<string, { used: number; count: number }>();
	for (const limit of limits) {
		const amount = limit.amount;
		const unit = typeof amount?.unit === "string" ? amount.unit.toLowerCase() : undefined;
		if (!amount || !isQuantityUnit(unit) || !finite(amount.used) || finite(amount.limit) || finite(amount.remaining)) continue;
		const total = usedOnly.get(unit) ?? { used: 0, count: 0 };
		total.used += amount.used;
		total.count++;
		usedOnly.set(unit, total);
	}
	for (const [unit, total] of usedOnly) {
		lines.push(`${quantity(total.used, unit)} used · ${quotaCount(total.count)}`);
	}

	return lines;
}

function terminalWidth(): number {
	const columns = typeof process !== "undefined" ? process.stdout?.columns : undefined;
	return typeof columns === "number" && Number.isFinite(columns) ? Math.max(40, columns - 4) : 100;
}

interface UsageRow {
	limit: SimpleUsageLimit;
	label: string;
	window: string;
	account?: string;
	headline: string;
}

interface ProviderEntry {
	report: SimpleUsageReport;
	visibleLimits: SimpleUsageLimit[];
}

/** One row per limit, with same-quota rows from different accounts kept adjacent. */
function providerRows(entries: readonly ProviderEntry[], showAccount: boolean): UsageRow[] {
	const groups = new Map<string, UsageRow[]>();
	for (const [index, { report, visibleLimits }] of entries.entries()) {
		for (const limit of visibleLimits) {
			const label = limitTitle(limit);
			const key = `${label}|${windowKey(limit)}`;
			const rows = groups.get(key) ?? [];
			rows.push({
				limit,
				label,
				window: windowSuffix(limit, label),
				account: showAccount ? accountIdentity(report, limit) ?? `account ${index + 1}` : undefined,
				headline: headlineValue(limit),
			});
			groups.set(key, rows);
		}
	}
	return [...groups.values()].flat();
}

function headerLine(title: string, stamp: string, width: number, uiTheme: SimpleUsageTheme): string {
	const heading = uiTheme.bold(uiTheme.fg("accent", title));
	if (!stamp) return heading;
	const gap = width - visibleWidth(heading) - stamp.length;
	return `${heading}${" ".repeat(Math.max(1, gap))}${uiTheme.fg("dim", stamp)}`;
}

function renderUsage(
	reports: readonly SimpleUsageReport[],
	uiTheme: SimpleUsageTheme,
	availableWidth: number,
	now: number,
	options: SimpleUsageViewOptions,
): string {
	const hideFilteredLimits = options.hideFilteredLimits ?? true;
	const width = Math.min(Math.max(availableWidth, RENDER_WIDTH_MIN), RENDER_WIDTH_MAX);
	const fetchedAt = Math.max(0, ...reports.map(report => report.fetchedAt ?? 0));
	const stamp = fetchedAt ? `updated ${duration(Math.max(0, now - fetchedAt))} ago` : "";
	const rule = uiTheme.fg("dim", "─".repeat(width));
	const lines = [headerLine(options.title ?? DEFAULT_USAGE_TITLE, stamp, width, uiTheme), rule];

	const visible = reports
		.map(report => ({
			report,
			visibleLimits: hideFilteredLimits ? filterSimpleLimits(report) : [...(report.limits ?? [])],
		}))
		.filter(item => item.report.error || item.visibleLimits.length > 0 || isEmptyUsageReport(item.report));
	if (visible.length === 0) {
		lines.push("", uiTheme.fg("dim", "No visible usage data."));
		return lines.join("\n");
	}

	const providers = new Map<string, ProviderEntry[]>();
	for (const item of visible) {
		providers.set(item.report.provider, [...(providers.get(item.report.provider) ?? []), item]);
	}

	const sections = [...providers.entries()]
		.map(([provider, entries]) => {
			// One account per provider is the norm: its identity belongs in the
			// provider heading, never repeated (or faked) on every row.
			const single = entries.length === 1;
			return {
				provider,
				entries,
				shared: single ? accountIdentity(entries[0].report, entries[0].visibleLimits[0]) : undefined,
				rows: providerRows(entries, !single),
				burn: entries
					.flatMap(entry => entry.visibleLimits)
					.reduce((sum, limit) => sum + (usedFraction(limit) ?? 0), 0),
			};
		})
		.sort((left, right) => left.burn - right.burn || left.provider.localeCompare(right.provider));

	const allRows = sections.flatMap(section => section.rows);
	const labelWidth = Math.min(
		LABEL_WIDTH_MAX,
		Math.max(1, ...allRows.map(row => row.label.length + (row.window ? row.window.length + 3 : 0))),
	);
	const valueWidth = Math.min(VALUE_WIDTH_MAX, Math.max(0, ...allRows.map(row => row.headline.length)));
	const barWidth = Math.min(BAR_WIDTH_MAX, Math.max(BAR_WIDTH_MIN, width - labelWidth - valueWidth - 8));

	for (const section of sections) {
		const heading = uiTheme.bold(uiTheme.fg("accent", providerLabel(section.provider)));
		const identity = section.shared
			? ` ${uiTheme.fg("dim", truncate(`· ${section.shared}`, width - visibleWidth(heading) - 1))}`
			: "";
		lines.push("", `${heading}${identity}`);

		for (const row of section.rows) {
			const status = displayStatus(row.limit);
			// Truncate before styling; slicing a colored string would cut escape codes.
			const suffix = row.window ? ` (${row.window})` : "";
			const label = uiTheme.bold(truncate(row.label, Math.max(1, labelWidth - suffix.length)))
				+ (suffix ? uiTheme.fg("dim", suffix) : "");
			const headline = status === "warning" || status === "exhausted"
				? uiTheme.fg(statusColor(status), row.headline)
				: row.headline;
			lines.push(
				` ${statusIcon(status, uiTheme)} ${padEnd(label, labelWidth)}  ${renderBar(row.limit, uiTheme, barWidth)}  ${padStart(headline, valueWidth)}`.trimEnd(),
			);

			const meta = [row.account, detailValue(row.limit), resetText(row.limit, now), runsOutText(row.limit, now)]
				.filter(Boolean)
				.join(" · ");
			if (meta) lines.push(`   ${uiTheme.fg("dim", truncate(meta, width - 3))}`);
		}

		for (const { report, visibleLimits } of section.entries) {
			if (report.error) {
				lines.push(` ${uiTheme.fg("error", `! ${cleanLabel(report.error)}`)}`);
			}
			if (report.notes?.length) {
				for (const note of report.notes) lines.push(` ${uiTheme.fg("warning", `! ${cleanLabel(note)}`)}`);
			}
			if (visibleLimits.length === 0 && !report.error) {
				lines.push(` ${uiTheme.fg("dim", `· ${accountIdentity(report) ?? "account"} — no usage data`)}`);
			}
		}
	}

	if (hideFilteredLimits) {
		const totals = totalUsageLines(allRows.map(row => row.limit));
		if (totals.length > 0) {
			lines.push("", rule, uiTheme.bold(uiTheme.fg("accent", "Total usage")));
			lines.push(...totals.map(line => `   ${uiTheme.fg("dim", line)}`));
		}
	}

	return lines.join("\n");
}

/** Render the report as plain text, for chat clients and LLM context. */
export function formatSimpleUsage(
	reports: readonly SimpleUsageReport[],
	now = Date.now(),
	options: SimpleUsageViewOptions = {},
): string {
	return renderUsage(reports, PLAIN_THEME, CHAT_RENDER_WIDTH, now, options);
}

/** Wrap the plain render in a fenced block so markdown chat clients keep the alignment. */
export function formatSimpleUsageForChat(
	reports: readonly SimpleUsageReport[],
	now = Date.now(),
	options: SimpleUsageViewOptions = {},
): string {
	return `\`\`\`text\n${formatSimpleUsage(reports, now, options)}\n\`\`\``;
}

/** Render the report with Pi theme colors for the TUI. */
export function formatSimpleUsageStyled(
	reports: readonly SimpleUsageReport[],
	uiTheme: SimpleUsageTheme,
	availableWidth = terminalWidth(),
	now = Date.now(),
	options: SimpleUsageViewOptions = {},
): string {
	return renderUsage(reports, uiTheme, availableWidth, now, options);
}
