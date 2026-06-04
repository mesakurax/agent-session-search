import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { apiProviderPreset, normalizeApiConfig, type ApiConfig } from "./api-config";

export type CodexProfileName = "codex" | "codexzh";
export type CodexApplyProfileName = CodexProfileName | "generated";

export interface ApplyCodexProfileOptions {
  codexHome?: string;
  profile: CodexProfileName;
  apiConfig?: Partial<ApiConfig> | null;
  now?: Date;
}

export interface ApplyCodexProfileResult {
  profile: string;
  codexHome: string;
  authSource: string | null;
  configSource: string | null;
  authTarget: string;
  configTarget: string;
  backupPaths: string[];
}

export function codexProfileForApiConfig(
  config: Pick<ApiConfig, "activeProvider"> & Partial<Pick<ApiConfig, "customProviderId">>,
): CodexApplyProfileName {
  if (config.activeProvider !== "custom") return "codex";
  return config.customProviderId === "codexzh" || !config.customProviderId ? "codexzh" : "generated";
}

export async function loadCodexProfileDefaults(codexHome = path.join(os.homedir(), ".codex")): Promise<Partial<ApiConfig>> {
  const [activeConfigText, codexZhConfigText, codexZhAuthText] = await Promise.all([
    readOptionalFile(path.join(codexHome, "config.toml")),
    readOptionalFile(path.join(codexHome, "config_codexzh.toml")),
    readOptionalFile(path.join(codexHome, "auth_codexzh.json")),
  ]);

  const defaults: Partial<ApiConfig> = {};
  const activeModelProvider = readTomlString(activeConfigText, "model_provider");
  if (activeModelProvider) defaults.activeProvider = activeModelProvider === "codexzh" ? "custom" : "official";

  const providerId = firstCodexModelProviderId(codexZhConfigText) ?? "codexzh";
  const providerSection = readTomlSection(codexZhConfigText, `[model_providers.${providerId}]`);
  const providerName = readTomlString(providerSection, "name");
  const baseUrl = readTomlString(providerSection, "base_url");
  const wireApi = readTomlString(providerSection, "wire_api");
  const model = readTomlString(codexZhConfigText, "model");
  const apiKey = readOpenAiApiKey(codexZhAuthText);

  if (providerName) defaults.customProviderName = providerName;
  defaults.customProviderId = "codexzh";
  if (baseUrl) defaults.customBaseUrl = baseUrl;
  if (model) defaults.customModel = model;
  if (apiKey) defaults.customApiKey = apiKey;
  if (wireApi) defaults.customApiFormat = wireApi === "responses" ? "openai_responses" : "openai_chat";
  return defaults;
}

export async function applyCodexApiConfig(options: {
  codexHome?: string;
  apiConfig: Partial<ApiConfig>;
  now?: Date;
}): Promise<ApplyCodexProfileResult> {
  const apiConfig = apiConfigWithPresetDefaults(options.apiConfig);
  const profile = codexProfileForApiConfig(apiConfig);
  if (profile === "codex" || profile === "codexzh") {
    return applyCodexProfile({
      codexHome: options.codexHome,
      profile,
      apiConfig,
      now: options.now,
    });
  }
  return applyGeneratedCodexProvider({
    codexHome: options.codexHome,
    apiConfig,
    now: options.now,
  });
}

export async function applyCodexProfile(options: ApplyCodexProfileOptions): Promise<ApplyCodexProfileResult> {
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const profile = options.profile;
  const authSource = path.join(codexHome, `auth_${profile}.json`);
  const configSource = path.join(codexHome, `config_${profile}.toml`);
  const authTarget = path.join(codexHome, "auth.json");
  const configTarget = path.join(codexHome, "config.toml");
  const backupDir = path.join(codexHome, "backups");
  const stamp = backupStamp(options.now ?? new Date());

  await assertReadable(authSource, `Missing auth profile: ${authSource}`);
  await assertReadable(configSource, `Missing config profile: ${configSource}`);
  await mkdir(backupDir, { recursive: true });

  const backupPaths = await backupExistingTargets([
    { target: authTarget, backup: path.join(backupDir, `auth.json.before-${profile}-${stamp}`) },
    { target: configTarget, backup: path.join(backupDir, `config.toml.before-${profile}-${stamp}`) },
  ]);

  if (profile === "codexzh" && options.apiConfig) {
    const apiConfig = normalizeApiConfig(options.apiConfig);
    const configText = applyCodexZhConfigOverrides(await readFile(configSource, "utf8"), apiConfig);
    const authText = apiConfig.customApiKey ? `${JSON.stringify({ OPENAI_API_KEY: apiConfig.customApiKey }, null, 2)}\n` : await readFile(authSource, "utf8");
    await writeFile(configTarget, configText, { mode: 0o600 });
    await writeFile(authTarget, authText, { mode: 0o600 });
  } else {
    await copyFile(configSource, configTarget);
    await copyFile(authSource, authTarget);
  }

  await chmod(authTarget, 0o600);
  await chmod(configTarget, 0o600);

  return {
    profile,
    codexHome,
    authSource,
    configSource,
    authTarget,
    configTarget,
    backupPaths,
  };
}

async function applyGeneratedCodexProvider(options: {
  codexHome?: string;
  apiConfig: ApiConfig;
  now?: Date;
}): Promise<ApplyCodexProfileResult> {
  const codexHome = options.codexHome ?? path.join(os.homedir(), ".codex");
  const apiConfig = options.apiConfig;
  const providerId = codexProviderId(apiConfig.customProviderName);
  const authTarget = path.join(codexHome, "auth.json");
  const configTarget = path.join(codexHome, "config.toml");
  const backupDir = path.join(codexHome, "backups");
  const stamp = backupStamp(options.now ?? new Date());

  if (!apiConfig.customApiKey) throw new Error(`API key is required to apply ${apiConfig.customProviderName}.`);
  if (!apiConfig.customBaseUrl) throw new Error(`Base URL is required to apply ${apiConfig.customProviderName}.`);
  if (!apiConfig.customModel) throw new Error(`Model is required to apply ${apiConfig.customProviderName}.`);

  await mkdir(backupDir, { recursive: true });
  const backupPaths = await backupExistingTargets([
    { target: authTarget, backup: path.join(backupDir, `auth.json.before-${providerId}-${stamp}`) },
    { target: configTarget, backup: path.join(backupDir, `config.toml.before-${providerId}-${stamp}`) },
  ]);

  await writeFile(authTarget, `${JSON.stringify({ OPENAI_API_KEY: apiConfig.customApiKey }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(configTarget, generatedCodexConfig(apiConfig, providerId), { mode: 0o600 });
  await chmod(authTarget, 0o600);
  await chmod(configTarget, 0o600);

  return {
    profile: providerId,
    codexHome,
    authSource: null,
    configSource: null,
    authTarget,
    configTarget,
    backupPaths,
  };
}

async function assertReadable(filePath: string, message: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new Error(message);
  }
}

async function backupExistingTargets(targets: Array<{ target: string; backup: string }>): Promise<string[]> {
  const backupPaths: string[] = [];
  for (const item of targets) {
    try {
      await stat(item.target);
    } catch {
      continue;
    }
    await copyFile(item.target, item.backup);
    backupPaths.push(item.backup);
  }
  return backupPaths;
}

function applyCodexZhConfigOverrides(text: string, apiConfig: ApiConfig): string {
  const providerId = codexProviderId(apiConfig.customProviderName);
  let next = replaceTopLevelString(text, "model_provider", providerId);
  if (apiConfig.customModel) next = replaceTopLevelString(next, "model", apiConfig.customModel);
  next = replaceFirstProviderSectionHeader(next, providerId);
  next = replaceOrInsertSectionString(next, `[model_providers.${providerId}]`, "name", apiConfig.customProviderName);
  if (apiConfig.customBaseUrl) next = replaceOrInsertSectionString(next, `[model_providers.${providerId}]`, "base_url", apiConfig.customBaseUrl);
  next = replaceOrInsertSectionString(next, `[model_providers.${providerId}]`, "wire_api", "responses");
  return next.endsWith("\n") ? next : `${next}\n`;
}

function apiConfigWithPresetDefaults(config: Partial<ApiConfig>): ApiConfig {
  const normalized = normalizeApiConfig(config);
  const preset = apiProviderPreset(normalized.customProviderId);
  return normalizeApiConfig({
    ...normalized,
    customProviderId: preset.id,
    customProviderName: config.customProviderName?.trim() || preset.providerName,
    customBaseUrl: config.customBaseUrl?.trim() || preset.baseUrl,
    customModel: config.customModel?.trim() || preset.model,
    customApiFormat: config.customApiFormat ?? preset.apiFormat,
  });
}

function generatedCodexConfig(apiConfig: ApiConfig, providerId: string): string {
  return `model_provider = ${tomlString(providerId)}
model = ${tomlString(apiConfig.customModel)}
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.${providerId}]
name = ${tomlString(apiConfig.customProviderName)}
base_url = ${tomlString(apiConfig.customBaseUrl)}
wire_api = "responses"
requires_openai_auth = true
`;
}

function codexProviderId(providerName: string): string {
  const normalized = providerName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "codexzh";
}

function replaceTopLevelString(text: string, key: string, value: string): string {
  const line = `${key} = ${tomlString(value)}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${line}\n${text}`;
}

function replaceFirstProviderSectionHeader(text: string, providerId: string): string {
  const header = `[model_providers.${providerId}]`;
  const pattern = /^\[model_providers\.[^\]]+\]\s*$/m;
  if (pattern.test(text)) return text.replace(pattern, header);
  return `${text.trimEnd()}\n\n${header}\n`;
}

function replaceOrInsertSectionString(text: string, sectionHeader: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  let sectionStart = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionStart < 0) {
    lines.push("", sectionHeader);
    sectionStart = lines.length - 1;
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const line = `${key} = ${tomlString(value)}`;
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = line;
      return lines.join("\n");
    }
  }
  lines.splice(sectionStart + 1, 0, line);
  return lines.join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function firstCodexModelProviderId(text: string): string | null {
  const match = text.match(/^\s*\[model_providers\.([^\]]+)\]\s*$/m);
  return match?.[1]?.trim() || null;
}

function readTomlSection(text: string, sectionHeader: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === sectionHeader);
  if (start < 0) return "";
  const sectionLines: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join("\n");
}

function readTomlString(text: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*$`, "m");
  const rawValue = text.match(pattern)?.[1];
  if (!rawValue) return null;
  return parseTomlString(rawValue);
}

function parseTomlString(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const withoutComment = trimmed.startsWith('"') ? trimmed : trimmed.split("#")[0]?.trim() ?? "";
  if (!withoutComment.startsWith('"')) return withoutComment || null;
  try {
    const parsed = JSON.parse(withoutComment);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return withoutComment.slice(1, withoutComment.lastIndexOf('"'));
  }
}

function readOpenAiApiKey(text: string): string | null {
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as { OPENAI_API_KEY?: unknown };
    return typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null;
  } catch {
    return null;
  }
}

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}
