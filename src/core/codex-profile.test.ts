import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_PROVIDER_PRESETS, defaultApiConfig, mergeApiConfigWithProfileDefaults, normalizeApiConfig } from "./api-config";
import { applyCodexApiConfig, applyCodexProfile, codexProfileForApiConfig, loadCodexProfileDefaults } from "./codex-profile";

async function withCodexHome<T>(run: (codexHome: string) => Promise<T>): Promise<T> {
  const codexHome = await mkdtemp(path.join(tmpdir(), "agent-session-search-codex-"));
  try {
    return await run(codexHome);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

describe("codex profile switching", () => {
  it("copies the selected profile into active Codex files and backs up existing files", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "auth_codexzh.json"), "{\"OPENAI_API_KEY\":\"profile-key\"}\n");
      await writeFile(path.join(codexHome, "config_codexzh.toml"), "model_provider = \"codexzh\"\n");
      await writeFile(path.join(codexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"old\"}\n");
      await writeFile(path.join(codexHome, "config.toml"), "model_provider = \"old\"\n");
      await chmod(path.join(codexHome, "auth.json"), 0o600);

      const result = await applyCodexProfile({
        codexHome,
        profile: "codexzh",
        now: new Date("2026-06-03T08:09:10.111Z"),
      });

      await expect(readFile(path.join(codexHome, "auth.json"), "utf8")).resolves.toBe("{\"OPENAI_API_KEY\":\"profile-key\"}\n");
      await expect(readFile(path.join(codexHome, "config.toml"), "utf8")).resolves.toBe("model_provider = \"codexzh\"\n");
      await expect(readFile(path.join(codexHome, "backups/auth.json.before-codexzh-2026-06-03T08-09-10-111Z"), "utf8")).resolves.toBe(
        "{\"OPENAI_API_KEY\":\"old\"}\n",
      );
      await expect(readFile(path.join(codexHome, "backups/config.toml.before-codexzh-2026-06-03T08-09-10-111Z"), "utf8")).resolves.toBe(
        "model_provider = \"old\"\n",
      );
      expect((await stat(path.join(codexHome, "auth.json"))).mode & 0o777).toBe(0o600);
      expect(result.profile).toBe("codexzh");
      expect(result.backupPaths).toHaveLength(2);
    });
  });

  it("overlays CodexZH form fields onto the copied profile", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "auth_codexzh.json"), "{\"OPENAI_API_KEY\":\"profile-key\"}\n");
      await writeFile(
        path.join(codexHome, "config_codexzh.toml"),
        [
          'model_provider = "codexzh"',
          'model = "old-model"',
          "",
          "[model_providers.codexzh]",
          'name = "codexzh"',
          'base_url = "https://old.example/v1"',
          'wire_api = "responses"',
          "requires_openai_auth = true",
          "",
          "[features]",
          "hooks = true",
          "",
        ].join("\n"),
      );

      await applyCodexProfile({
        codexHome,
        profile: "codexzh",
        apiConfig: {
          activeProvider: "custom",
          customProviderName: "  CodexZH  ",
          customBaseUrl: " https://api.codexzh.com/v1 ",
          customApiKey: " sk-new ",
          customModel: " gpt-5.5 ",
          customApiFormat: "openai_responses",
        },
      });

      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('model_provider = "codexzh"');
      expect(config).toContain('model = "gpt-5.5"');
      expect(config).toContain("[model_providers.codexzh]");
      expect(config).toContain('name = "CodexZH"');
      expect(config).toContain('base_url = "https://api.codexzh.com/v1"');
      expect(config).toContain('wire_api = "responses"');
      expect(config).toContain("[features]");
      await expect(readFile(path.join(codexHome, "auth.json"), "utf8")).resolves.toBe('{\n  "OPENAI_API_KEY": "sk-new"\n}\n');
    });
  });

  it("maps the app provider choice to local Codex profile names", () => {
    expect(codexProfileForApiConfig({ activeProvider: "official" })).toBe("codex");
    expect(codexProfileForApiConfig({ activeProvider: "custom", customProviderId: "codexzh" })).toBe("codexzh");
    expect(codexProfileForApiConfig({ activeProvider: "custom", customProviderId: "deepseek" })).toBe("generated");
  });

  it("loads CodexZH defaults from local Codex profile files", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "config.toml"), 'model_provider = "codexzh"\n');
      await writeFile(
        path.join(codexHome, "config_codexzh.toml"),
        [
          'model_provider = "codexzh"',
          'model = "gpt-5.5"',
          "",
          "[model_providers.codexzh]",
          'name = "codexzh"',
          'base_url = "https://api.codexzh.com/v1"',
          'wire_api = "responses"',
          "",
        ].join("\n"),
      );
      await writeFile(path.join(codexHome, "auth_codexzh.json"), '{"OPENAI_API_KEY":"profile-key"}\n');

      await expect(loadCodexProfileDefaults(codexHome)).resolves.toMatchObject({
        activeProvider: "custom",
        customProviderName: "codexzh",
        customBaseUrl: "https://api.codexzh.com/v1",
        customApiKey: "profile-key",
        customModel: "gpt-5.5",
        customApiFormat: "openai_responses",
      });
    });
  });

  it("fills missing API settings from profile defaults without overriding saved fields", () => {
    expect(
      mergeApiConfigWithProfileDefaults(
        { ...defaultApiConfig, customBaseUrl: "https://saved.example/v1" },
        { customBaseUrl: "https://saved.example/v1" },
        {
          activeProvider: "custom",
          customBaseUrl: "https://profile.example/v1",
          customApiKey: "profile-key",
          customModel: "gpt-5.5",
          customApiFormat: "openai_responses",
        },
      ),
    ).toMatchObject({
      activeProvider: "custom",
      customBaseUrl: "https://saved.example/v1",
      customApiKey: "profile-key",
      customModel: "gpt-5.5",
      customApiFormat: "openai_responses",
    });
  });

  it("keeps common provider presets from cc-switch available", () => {
    expect(API_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "codexzh",
      "deepseek",
      "zhipu_glm",
      "longcat",
      "kimi",
      "xiaomi_mimo",
    ]);
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "deepseek")).toMatchObject({
      providerName: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiFormat: "openai_chat",
    });
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "zhipu_glm")).toMatchObject({
      providerName: "zhipu_glm",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-5.1",
    });
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "longcat")).toMatchObject({
      providerName: "longcat",
      baseUrl: "https://api.longcat.chat/openai/v1",
      model: "LongCat-Flash-Chat",
    });
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "kimi")).toMatchObject({
      providerName: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
    });
    expect(API_PROVIDER_PRESETS.find((preset) => preset.id === "xiaomi_mimo")).toMatchObject({
      providerName: "xiaomi_mimo",
      baseUrl: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2.5-pro",
    });
  });

  it("normalizes preset ids and falls back to CodexZH", () => {
    expect(normalizeApiConfig({ activeProvider: "custom", customProviderId: "deepseek" }).customProviderId).toBe("deepseek");
    expect(normalizeApiConfig({ activeProvider: "custom", customProviderId: "missing" }).customProviderId).toBe("codexzh");
  });

  it("generates active Codex config for common providers without profile files", async () => {
    await withCodexHome(async (codexHome) => {
      await writeFile(path.join(codexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"old\"}\n");
      await writeFile(path.join(codexHome, "config.toml"), "model_provider = \"old\"\n");

      const result = await applyCodexApiConfig({
        codexHome,
        apiConfig: {
          activeProvider: "custom",
          customProviderId: "deepseek",
          customProviderName: "deepseek",
          customBaseUrl: "https://api.deepseek.com",
          customApiKey: "sk-deepseek",
          customModel: "deepseek-v4-flash",
          customApiFormat: "openai_chat",
        },
        now: new Date("2026-06-03T08:09:10.111Z"),
      });

      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('model_provider = "deepseek"');
      expect(config).toContain('model = "deepseek-v4-flash"');
      expect(config).toContain("[model_providers.deepseek]");
      expect(config).toContain('base_url = "https://api.deepseek.com"');
      expect(config).toContain('wire_api = "responses"');
      await expect(readFile(path.join(codexHome, "auth.json"), "utf8")).resolves.toBe('{\n  "OPENAI_API_KEY": "sk-deepseek"\n}\n');
      expect(result.profile).toBe("deepseek");
      await expect(readFile(path.join(codexHome, "backups/auth.json.before-deepseek-2026-06-03T08-09-10-111Z"), "utf8")).resolves.toBe(
        "{\"OPENAI_API_KEY\":\"old\"}\n",
      );
    });
  });
});
