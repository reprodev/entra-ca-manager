const { getKeyVaultConfig } = require("./runtimeConfig");

async function hydrateSecretsFromKeyVault(options = {}) {
  const config = options.config || getKeyVaultConfig();
  if (!config.enabled) {
    return { ok: true, enabled: false, loadedCount: 0, skippedCount: 0, errors: [] };
  }

  if (!config.vaultUrl) {
    return { ok: false, enabled: true, loadedCount: 0, skippedCount: 0, errors: ["KEYVAULT_URL is required when ENABLE_KEYVAULT_SECRETS=true."] };
  }

  const mappings = config.secretMappings || {};
  const mappingEntries = Object.entries(mappings);
  if (mappingEntries.length === 0) {
    return { ok: false, enabled: true, loadedCount: 0, skippedCount: 0, errors: ["KEYVAULT_SECRET_MAPPINGS must include at least one ENV_NAME=secret-name mapping."] };
  }

  let SecretClient;
  let DefaultAzureCredential;
  try {
    ({ SecretClient } = require("@azure/keyvault-secrets"));
    ({ DefaultAzureCredential } = require("@azure/identity"));
  } catch (error) {
    return {
      ok: false,
      enabled: true,
      loadedCount: 0,
      skippedCount: 0,
      errors: [`Key Vault dependencies are missing: ${error.message}`]
    };
  }

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(config.vaultUrl, credential);
  const timeoutMs = Math.max(1000, Number(config.timeoutMs) || 10000);
  let loadedCount = 0;
  let skippedCount = 0;
  const errors = [];

  for (const [envName, secretName] of mappingEntries) {
    if (!config.overrideExisting && String(process.env[envName] || "").trim()) {
      skippedCount += 1;
      continue;
    }

    try {
      const secretResult = await Promise.race([
        client.getSecret(secretName),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs))
      ]);
      process.env[envName] = String(secretResult.value || "");
      loadedCount += 1;
    } catch (error) {
      errors.push(`${envName}<=${secretName}: ${error.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    enabled: true,
    loadedCount,
    skippedCount,
    errors
  };
}

module.exports = {
  hydrateSecretsFromKeyVault
};
