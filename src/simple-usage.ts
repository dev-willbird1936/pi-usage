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
}

export interface SimpleUsageWindow {
	id?: string;
	label?: string;
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
	/** Header line; defaults to `Usage (simple)`. */
	title?: string;
	/** Hide provider buckets filtered from the simple view; defaults to true. */
	hideFilteredLimits?: boolean;
}

const DEFAULT_USAGE_TITLE = "Usage (simple)";

const PROVIDER_LABELS: Record<string, string> = {
	"alibaba-token-plan": "Alibaba",
	anthropic: "Claude",
	cursor: "Cursor",
	"github-copilot": "GitHub Copilot",
	"google-antigravity": "Antigravity",
	"google-gemini-cli": "Gemini",
	"kimi-code": "Kimi",
	"minimax-code": "MiniMax",
	ollama: "Ollama",
	"ollama-cloud": "Ollama Cloud",
	"openai-codex": "Codex",
	"opencode-go": "OpenCode Go",
	synthetic: "Synthetic",
	umans: "Umans",
	"xai-oauth": "Grok",
	zai: "Z.ai",
};

/** Provider ids that expose usage reports, for `--provider` completion. */
export const USAGE_PROVIDER_IDS: readonly string[] = Object.keys(PROVIDER_LABELS);

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const textValue = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
};

function isXaiProvider(provider: string): boolean {
	return provider === "xai-oauth" || provider === "xai" || provider.includes("grok");
}

/**
 * True when a limit is noise for the simple view. Kept rows answer "how much
 * of my subscription is left": account-level quota windows and paid overage.
 * Hidden rows are per-model/per-product breakdowns that duplicate the account
 * aggregate, feature side-quotas, instantaneous gauges, and display-only
 * windows that never block.
 */
export function isHiddenSimpleLimit(report: SimpleUsageReport, limit: SimpleUsageLimit): boolean {
	const provider = report.provider.toLowerCase();
	const id = (limit.id ?? "").toLowerCase();

	// Codex metered-feature buckets (Spark and any future meters): the shared
	// primary/secondary windows carry the subscription quota; tiered buckets
	// only restate them per feature. A label fallback catches reports that
	// omit scope.tier.
	if (provider === "openai-codex") {
		if (limit.scope?.tier) return true;
		return `${id} ${limit.label ?? ""}`.toLowerCase().includes("spark");
	}

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
	if (provider === "opencode-go" && (id === "monthly" || limit.window?.id === "monthly")) return true;

	return false;
}

/** Cursor rows that merely aggregate the other monthly USD meters. */
function isCursorAggregateLimit(limit: SimpleUsageLimit): boolean {
	const id = (limit.id ?? "").toLowerCase();
	return id === "cursor:usd:individual-plan" || id === "cursor:usd:individual-overall";
}

/**
 * Limits visible in the simple view. Context-aware: a Cursor aggregate row
 * ("Personal Usage") is dropped only when the report also carries the
 * itemized meters it duplicates, so a plan with nothing else still renders.
 */
export function filterSimpleLimits(report: SimpleUsageReport): SimpleUsageLimit[] {
	const limits = (report.limits ?? []).filter(limit => !isHiddenSimpleLimit(report, limit));
	if (report.provider.toLowerCase() !== "cursor") return limits;
	const itemized = limits.filter(limit => !isCursorAggregateLimit(limit));
	return itemized.length > 0 ? itemized : limits;
}

function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider.toLowerCase()] ??
		provider
			.split(/[-_]/g)
			.filter(Boolean)
			.map(part => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
}

function accountLabel(report: SimpleUsageReport): string | undefined {
	const metadata = report.metadata;
	if (!metadata) return undefined;

	const parts = [
		metadata.orgName,
		metadata.organization,
		metadata.email,
	].map(textValue).filter((value): value is string => Boolean(value));

	return [...new Set(parts)].join(" · ") || undefined;
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

function usageDetail(limit: SimpleUsageLimit): string {
	const amount = limit.amount;
	if (!amount) return "no data";

	const used = usedFraction(limit);
	let detail: string;
	if (amount.unit === "percent" && used !== undefined) {
		detail = `${percent(used)} used`;
	} else if (amount.unit === "usd" && finite(amount.used) && finite(amount.limit)) {
		detail = `${quantity(amount.used, amount.unit)} / ${quantity(amount.limit, amount.unit)}`;
	} else if (finite(amount.used) && finite(amount.limit)) {
		detail = `${quantity(amount.used, amount.unit)} / ${quantity(amount.limit, amount.unit)}`;
	} else if (used !== undefined) {
		detail = `${percent(used)} used`;
	} else if (finite(amount.used)) {
		detail = `${quantity(amount.used, amount.unit)} used`;
	} else if (finite(amount.remaining)) {
		detail = `${quantity(amount.remaining, amount.unit)} left`;
	} else {
		detail = "no data";
	}

	const left = remainingFraction(limit, used);
	if (left !== undefined && left >= 0 && amount.unit !== "unknown") {
		detail += ` · ${percent(Math.max(0, left))} left`;
	}
	return detail;
}

function statusMarker(limit: SimpleUsageLimit): string {
	const status = limit.status?.toLowerCase();
	const used = usedFraction(limit);
	if (status === "exhausted" || (used !== undefined && used >= 1)) return "✗";
	if (status === "warning" || (used !== undefined && used >= 0.8)) return "!";
	if (status === "ok" || used !== undefined) return "✓";
	return "·";
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

function resetSuffix(limit: SimpleUsageLimit, now: number): string {
	const resetAt = limit.window?.resetsAt ?? limit.resetsAt;
	if (!finite(resetAt)) return "";
	if (resetAt <= now) return " · resets now";
	return ` · resets in ${duration(resetAt - now)}`;
}

function cleanLabel(value: unknown): string {
	return String(value ?? "quota").replace(/[\r\n]+/g, " ").trim() || "quota";
}

/** Render only the compact, user-facing quota view. */
export function formatSimpleUsage(
	reports: readonly SimpleUsageReport[],
	now = Date.now(),
	options: SimpleUsageViewOptions = {},
): string {
	const hideFilteredLimits = options.hideFilteredLimits ?? true;
	const prepared = reports
		.flatMap((report, reportIndex) => {
			const visibleLimits = hideFilteredLimits ? filterSimpleLimits(report) : [...(report.limits ?? [])];
			if (visibleLimits.length === 0) return [];
			return [{ report, reportIndex, visibleLimits, account: accountLabel(report) }];
		})
		.sort((left, right) => {
			const providerOrder = providerLabel(left.report.provider).localeCompare(providerLabel(right.report.provider));
			return providerOrder || (left.account ?? "").localeCompare(right.account ?? "") || left.reportIndex - right.reportIndex;
		});

	const lines = [options.title ?? DEFAULT_USAGE_TITLE];
	if (prepared.length === 0) return `${lines[0]}\nNo visible usage data.`;

	const providerCounts = new Map<string, number>();
	for (const item of prepared) {
		const key = item.report.provider.toLowerCase();
		providerCounts.set(key, (providerCounts.get(key) ?? 0) + 1);
	}
	const providerPositions = new Map<string, number>();

	for (const item of prepared) {
		const provider = providerLabel(item.report.provider);
		const providerKey = item.report.provider.toLowerCase();
		const providerPosition = (providerPositions.get(providerKey) ?? 0) + 1;
		providerPositions.set(providerKey, providerPosition);
		const fallbackAccount = providerCounts.get(providerKey)! > 1 ? `account ${providerPosition}` : undefined;
		const heading = [provider, item.account ?? fallbackAccount].filter(Boolean).join(" — ");
		lines.push("", heading);
		for (const limit of item.visibleLimits) {
			lines.push(`  ${statusMarker(limit)} ${cleanLabel(limit.label ?? limit.window?.label ?? limit.id)}: ${usageDetail(limit)}${resetSuffix(limit, now)}`);
		}
	}

	return lines.join("\n");
}

type SimpleDisplayStatus = "ok" | "warning" | "exhausted" | "neutral" | "unknown";

const SIMPLE_BAR_WIDTH_MAX = 24;
const SIMPLE_COLUMN_WIDTH_MIN = 4;

function simpleDisplayStatus(limit: SimpleUsageLimit): SimpleDisplayStatus {
	const status = limit.status?.toLowerCase();
	if (status === "exhausted") return "exhausted";
	if (status === "warning") return "warning";
	if (status === "ok") return "ok";

	const used = usedFraction(limit);
	if (used !== undefined && used >= 1) return "exhausted";
	if (used !== undefined && used >= 0.8) return "warning";
	if (used !== undefined) return "ok";
	if (isSimpleUsedOnlyAbsoluteAmount(limit)) return "neutral";
	return "unknown";
}

function simpleAggregateStatus(limits: readonly SimpleUsageLimit[]): SimpleDisplayStatus {
	const statuses = limits.map(simpleDisplayStatus);
	const hasOk = statuses.includes("ok");
	const hasWarning = statuses.includes("warning");
	const hasExhausted = statuses.includes("exhausted");
	if (hasOk) return hasWarning || hasExhausted ? "warning" : "ok";
	if (hasWarning) return "warning";
	if (hasExhausted) return "exhausted";
	if (statuses.length > 0 && statuses.every(status => status === "neutral")) return "neutral";
	return "unknown";
}

function simpleStatusIcon(status: SimpleDisplayStatus, uiTheme: SimpleUsageTheme): string {
	if (status === "exhausted") return uiTheme.fg("error", "✗");
	if (status === "warning") return uiTheme.fg("warning", "!");
	if (status === "ok") return uiTheme.fg("success", "✓");
	return uiTheme.fg("dim", "·");
}

function simpleStatusColor(status: SimpleDisplayStatus): SimpleUsageThemeColor {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "success";
	return "dim";
}

function isSimpleUsedOnlyAbsoluteAmount(limit: SimpleUsageLimit): boolean {
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

function simpleLimitTitle(limit: SimpleUsageLimit): string {
	const label = cleanLabel(limit.label ?? limit.window?.label ?? limit.id);
	const tier = textValue(limit.scope?.tier);
	if (tier && !label.toLowerCase().includes(tier.toLowerCase())) return `${label} (${tier})`;
	return label;
}

function simpleWindowId(limit: SimpleUsageLimit): string {
	return cleanLabel(limit.window?.id ?? limit.scope?.windowId ?? limit.window?.label ?? "default");
}

function simpleWindowLabel(limit: SimpleUsageLimit): string {
	return cleanLabel(limit.window?.label ?? limit.scope?.windowId ?? "default");
}

function simpleWindowSuffix(label: string, windowLabel: string, uiTheme: SimpleUsageTheme): string {
	const normalizedLabel = label.toLowerCase();
	const normalizedWindow = windowLabel.toLowerCase();
	if (normalizedWindow === "default" || normalizedWindow === "quota window") return "";
	if (normalizedLabel.includes(normalizedWindow)) return "";
	return uiTheme.fg("dim", `(${windowLabel})`);
}

function simpleVisibleWidth(value: string): number {
	return Array.from(value.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")).length;
}

function simpleTruncate(value: string, width: number): string {
	if (width <= 0) return "";
	if (simpleVisibleWidth(value) <= width) return value;
	if (width === 1) return "…";
	return `${Array.from(value).slice(0, width - 1).join("")}…`;
}

function simplePad(value: string, width: number): string {
	const padding = width - simpleVisibleWidth(value);
	return padding > 0 ? `${value}${" ".repeat(padding)}` : value;
}

function simpleOrgSuffix(report: SimpleUsageReport): string {
	const metadata = report.metadata;
	const org = textValue(metadata?.orgName) ?? textValue(metadata?.orgId);
	return org ? ` (${org})` : "";
}

function simpleAccountLabel(limit: SimpleUsageLimit, report: SimpleUsageReport, index: number): string {
	const metadata = report.metadata;
	const email = textValue(metadata?.email);
	if (email) return `${email}${simpleOrgSuffix(report)}`;
	const accountId = textValue(metadata?.accountId) ?? textValue(limit.scope?.accountId);
	if (accountId) return `${accountId}${simpleOrgSuffix(report)}`;
	const projectId = textValue(metadata?.projectId) ?? textValue(limit.scope?.projectId);
	if (projectId) return projectId;
	return `account ${index + 1}`;
}

function simpleResetShort(limit: SimpleUsageLimit, now: number): string | undefined {
	const resetAt = limit.window?.resetsAt ?? limit.resetsAt;
	if (!finite(resetAt) || resetAt <= now) return undefined;
	return duration(resetAt - now);
}

function simpleAccountHeaderRow(
	limits: readonly SimpleUsageLimit[],
	reports: readonly SimpleUsageReport[],
	now: number,
	columnWidth: number,
	uiTheme: SimpleUsageTheme,
): string[] {
	const parts = limits.map((limit, index) => ({
		label: simpleAccountLabel(limit, reports[index] ?? { provider: "unknown" }, index),
		suffix: simpleResetShort(limit, now),
	}));
	const maxSuffixWidth = parts.reduce((max, part) => Math.max(max, simpleVisibleWidth(part.suffix ? `(${part.suffix})` : "")), 0);
	const gap = maxSuffixWidth > 0 ? 1 : 0;
	const prefixBudget = columnWidth - maxSuffixWidth - gap;

	if (prefixBudget < 2) {
		return parts.map(part => {
			const full = part.suffix ? `${part.label} (${part.suffix})` : part.label;
			return simplePad(simpleTruncate(full, columnWidth), columnWidth);
		});
	}

	return parts.map(part => {
		const prefix = simpleTruncate(part.label, prefixBudget);
		const prefixCell = simplePad(prefix, prefixBudget);
		if (!part.suffix) return `${prefixCell}${" ".repeat(maxSuffixWidth + gap)}`;
		const suffix = `(${part.suffix})`;
		return `${prefixCell} ${" ".repeat(maxSuffixWidth - simpleVisibleWidth(suffix))}${uiTheme.fg("dim", suffix)}`;
	});
}

function simpleRenderBar(limit: SimpleUsageLimit, uiTheme: SimpleUsageTheme, width: number): string {
	const amount = limit.amount;
	if (amount?.used !== undefined && isSimpleUsedOnlyAbsoluteAmount(limit)) {
		return uiTheme.fg("dim", simpleTruncate(`${quantity(amount.used, amount.unit)} used`, width));
	}

	const fraction = usedFraction(limit);
	if (fraction === undefined) return uiTheme.fg("dim", "·".repeat(width));

	const clamped = Math.min(Math.max(fraction, 0), 1);
	const exact = clamped * width;
	const fullCells = Math.floor(exact);
	const remainder = exact - fullCells;
	const partial = remainder >= 2 / 3 ? "▓" : remainder >= 1 / 3 ? "▒" : "";
	const leading = "█".repeat(fullCells) + partial;
	const empty = "░".repeat(Math.max(0, width - fullCells - (partial ? 1 : 0)));
	return `${uiTheme.fg(simpleStatusColor(simpleDisplayStatus(limit)), leading)}${uiTheme.fg("dim", empty)}`;
}

function simpleAggregateAmount(limits: readonly SimpleUsageLimit[]): string {
	const fractions = limits.map(usedFraction);
	if (fractions.every((value): value is number => value !== undefined) && fractions.length > 0) {
		const averageRemaining = Math.max(0, ((limits.length - fractions.reduce((sum, value) => sum + value, 0)) / limits.length) * 100);
		return `${decimal(averageRemaining, 1)}% free`;
	}

	const amounts = limits.map(limit => limit.amount).filter(
		(amount): amount is SimpleUsageAmount => Boolean(amount && finite(amount.used) && finite(amount.limit) && amount.limit > 0),
	);
	if (amounts.length === limits.length && amounts.length > 0) {
		const totalUsed = amounts.reduce((sum, amount) => sum + (amount.used ?? 0), 0);
		const totalLimit = amounts.reduce((sum, amount) => sum + (amount.limit ?? 0), 0);
		return `${decimal(Math.max(0, 100 - (totalUsed / totalLimit) * 100), 1)}% free`;
	}
	if (limits.length > 0 && limits.every(isSimpleUsedOnlyAbsoluteAmount)) return "";

	const uniqueAccountIds = new Set(
		limits.map(limit => textValue(limit.scope?.accountId)).filter((id): id is string => Boolean(id)),
	);
	const count = uniqueAccountIds.size || limits.length;
	return `${count} ${count === 1 ? "acct" : "accts"}`;
}

function simpleResetRange(limits: readonly SimpleUsageLimit[], now: number): string | null {
	const windows = limits
		.map(limit => ({
			at: limit.window?.resetsAt ?? limit.resetsAt,
			label: limit.window?.resetLabel ?? "resets",
		}))
		.filter(window => finite(window.at) && window.at > now) as Array<{ at: number; label: string }>;
	if (windows.length === 0) return null;

	const labels = new Set(windows.map(window => window.label));
	const verb = labels.size === 1 ? [...labels][0] : "resets";
	const offsets = windows.map(window => window.at - now);
	const minReset = Math.min(...offsets);
	const maxReset = Math.max(...offsets);
	return maxReset - minReset > 60_000
		? `${verb} in ${duration(minReset)}–${duration(maxReset)}`
		: `${verb} in ${duration(minReset)}`;
}

function simpleColumnWidth(count: number, available: number, trailing: number): number {
	if (count <= 0) return SIMPLE_BAR_WIDTH_MAX;
	const spaceForBars = available - 2 - (count - 1) - (trailing > 0 ? trailing + 1 : 0);
	const ideal = Math.floor(spaceForBars / count);
	return ideal < SIMPLE_COLUMN_WIDTH_MIN ? SIMPLE_COLUMN_WIDTH_MIN : ideal;
}

interface SimpleLimitGroup {
	label: string;
	windowLabel: string;
	limits: SimpleUsageLimit[];
	reports: SimpleUsageReport[];
}

function simpleTerminalWidth(): number {
	const columns = typeof process !== "undefined" ? process.stdout?.columns : undefined;
	return typeof columns === "number" && Number.isFinite(columns) ? Math.max(40, columns - 4) : 100;
}

/** Render the report with the same visual grammar as native `/usage show`. */
export function formatSimpleUsageStyled(
	reports: readonly SimpleUsageReport[],
	uiTheme: SimpleUsageTheme,
	availableWidth = simpleTerminalWidth(),
	now = Date.now(),
	options: SimpleUsageViewOptions = {},
): string {
	const hideFilteredLimits = options.hideFilteredLimits ?? true;
	const latestFetchedAt = Math.max(...reports.map(report => report.fetchedAt ?? 0));
	const headerSuffix = latestFetchedAt ? ` (${duration(Math.max(0, now - latestFetchedAt))} ago)` : "";
	const lines = [uiTheme.bold(uiTheme.fg("accent", `${options.title ?? DEFAULT_USAGE_TITLE}${headerSuffix}`))];

	const visibleByReport = reports
		.map(report => ({
			report,
			visibleLimits: hideFilteredLimits ? filterSimpleLimits(report) : [...(report.limits ?? [])],
		}))
		.filter(item => item.visibleLimits.length > 0);
	if (visibleByReport.length === 0) {
		lines.push("", uiTheme.fg("dim", "No visible usage data."));
		return lines.join("\n");
	}

	const providers = new Map<string, Array<{ report: SimpleUsageReport; visibleLimits: SimpleUsageLimit[] }>>();
	for (const item of visibleByReport) {
		const providerReports = providers.get(item.report.provider) ?? [];
		providerReports.push(item);
		providers.set(item.report.provider, providerReports);
	}

	const providerEntries = [...providers.entries()]
		.map(([provider, providerReports]) => ({
			provider,
			providerReports,
			totalUsage: providerReports
				.flatMap(item => item.visibleLimits)
				.map(limit => usedFraction(limit) ?? 0)
				.reduce((sum, value) => sum + value, 0),
		}))
		.sort((left, right) => left.totalUsage - right.totalUsage || left.provider.localeCompare(right.provider));

	for (const { provider, providerReports } of providerEntries) {
		lines.push("", uiTheme.bold(uiTheme.fg("accent", providerLabel(provider))));

		const groups = new Map<string, SimpleLimitGroup>();
		for (const { report, visibleLimits } of providerReports) {
			for (const limit of visibleLimits) {
				const label = simpleLimitTitle(limit);
				const windowLabel = simpleWindowLabel(limit);
				const key = `${label}|${simpleWindowId(limit)}`;
				const group = groups.get(key) ?? { label, windowLabel, limits: [], reports: [] };
				group.limits.push(limit);
				group.reports.push(report);
				groups.set(key, group);
			}
		}

		const accountRank = new Map<SimpleUsageReport, number>();
		providerReports.forEach(({ report, visibleLimits }, position) => {
			const worst = visibleLimits.reduce((max, limit) => Math.max(max, usedFraction(limit) ?? -1), -1);
			accountRank.set(report, -worst * 1000 + position);
		});

		const renderableGroups = [...groups.values()].map(group => {
			const entries = group.limits.map((limit, index) => ({ limit, report: group.reports[index], index }));
			entries.sort((left, right) => {
				const leftRank = accountRank.get(left.report) ?? left.index;
				const rightRank = accountRank.get(right.report) ?? right.index;
				return leftRank - rightRank || left.index - right.index;
			});
			return {
				group,
				limits: entries.map(entry => entry.limit),
				reports: entries.map(entry => entry.report),
				amountText: simpleAggregateAmount(entries.map(entry => entry.limit)),
			};
		});

		const sectionCount = renderableGroups.reduce((max, group) => Math.max(max, group.limits.length), 0);
		const sectionTrailing = renderableGroups.reduce((max, group) => Math.max(max, simpleVisibleWidth(group.amountText)), 0);
		const sectionColumnWidth = simpleColumnWidth(sectionCount, availableWidth, sectionTrailing);
		const sectionBarWidth = Math.min(sectionColumnWidth, SIMPLE_BAR_WIDTH_MAX);

		for (const { group, limits, reports: groupReports, amountText } of renderableGroups) {
			const windowSuffix = simpleWindowSuffix(group.label, group.windowLabel, uiTheme);
			lines.push(`${simpleStatusIcon(simpleAggregateStatus(limits), uiTheme)} ${uiTheme.bold(group.label)} ${windowSuffix}`.trim());
			const accountLabels = simpleAccountHeaderRow(limits, groupReports, now, sectionColumnWidth, uiTheme);
			lines.push(`  ${accountLabels.join(" ")}`.trimEnd());
			const bars = limits.map(limit => simplePad(simpleRenderBar(limit, uiTheme, sectionBarWidth), sectionColumnWidth));
			lines.push(`  ${bars.join(" ")}${amountText ? ` ${amountText}` : ""}`.trimEnd());
			const resetText = limits.length <= 1 ? simpleResetRange(limits, now) : null;
			if (resetText) lines.push(`  ${uiTheme.fg("dim", resetText)}`.trimEnd());
		}
	}

	return lines.join("\n");
}

/** Accept both a bare report array and the JSON command's wrapper object. */
export function extractUsageReports(payload: unknown): SimpleUsageReport[] {
	if (Array.isArray(payload)) return payload as SimpleUsageReport[];
	if (!payload || typeof payload !== "object") return [];

	const record = payload as Record<string, unknown>;
	for (const key of ["reports", "usageReports", "data"]) {
		if (Array.isArray(record[key])) return record[key] as SimpleUsageReport[];
	}
	return [];
}
