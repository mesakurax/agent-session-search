import type { SearchOptions, SessionSource, SessionStatsPeriod } from "../../core/types";
import type { AppSettings } from "../../core/platform";
import type { ResumeRouteResult } from "../../core/resume-router";
import { localize, type LanguageMode } from "./language";
import { liveStateLabel, type LiveSessionState, type LiveStatusFilter } from "./live-filter";

export const SOURCE_LABEL: Record<SessionSource, string> = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude App",
  "claude-internal": "Claude Extra",
  "codex-cli": "Codex CLI",
  "codex-app": "Codex App",
  "codex-internal": "Codex Extra",
  "codebuddy-cli": "CodeBuddy CLI",
};

const BASE_SOURCE_FILTERS: Array<{ label: string; value: SearchOptions["source"] }> = [
  { label: "All", value: "all" },
  { label: "Claude", value: "claude" },
  { label: "Codex", value: "codex" },
  { label: "Claude Code", value: "claude-cli" },
  { label: "Claude App", value: "claude-app" },
  { label: "Codex CLI", value: "codex-cli" },
  { label: "Codex App", value: "codex-app" },
];

export function sourceFilters(settings: AppSettings | null): Array<{ label: string; value: SearchOptions["source"] }> {
  return [
    ...BASE_SOURCE_FILTERS,
    ...(settings?.includeClaudeInternal ? [{ label: "Claude Extra", value: "claude-internal" as const }] : []),
    ...(settings?.includeCodexInternal ? [{ label: "Codex Extra", value: "codex-internal" as const }] : []),
    ...(settings?.includeCodeBuddyCli ? [{ label: "CodeBuddy CLI", value: "codebuddy-cli" as const }] : []),
  ];
}

export function isBranchTag(tagName: string): boolean {
  return tagName.startsWith("branch:");
}

export function sourceUiFamily(source: SessionSource): "claude" | "codex" | "codebuddy" {
  if (source.startsWith("claude")) return "claude";
  if (source.startsWith("codex")) return "codex";
  return "codebuddy";
}

export function statsPeriodLabel(value: SessionStatsPeriod, language: LanguageMode): string {
  if (value === "today") return localize(language, "Today", "今天");
  if (value === "sevenDay") return localize(language, "7D", "7 天");
  if (value === "thirtyDay") return localize(language, "30D", "30 天");
  return localize(language, "All", "全部");
}

export function liveStatusFilterLabel(value: LiveStatusFilter, language: LanguageMode): string {
  if (value === "open") return localize(language, "Open", "打开");
  if (value === "closed") return localize(language, "Closed", "关闭");
  return localize(language, "All", "全部");
}

export function sourceFilterLabel(item: { label: string; value: SearchOptions["source"] }, language: LanguageMode): string {
  return item.value === "all" ? localize(language, "All", "全部") : item.label;
}

export function localizedLiveStateLabel(state: LiveSessionState, language: LanguageMode): string {
  return localize(language, liveStateLabel(state), state === "open" ? "打开" : state === "closed" ? "关闭" : "未知");
}

export function resumeRouteMessage(result: ResumeRouteResult, language: LanguageMode): string {
  return result.route === "focus"
    ? localize(language, "Terminal brought to front.", "终端已前置。")
    : localize(language, "Resume command sent to terminal.", "Resume 命令已发送到终端。");
}
