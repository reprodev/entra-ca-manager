const { getAccessToken } = require("./auth");
const { graphRequest } = require("./graphClient");
const { getDemoPolicies } = require("./demoData");
const { getLiveGraphEnabled } = require("./runtimeConfig");

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function deepClone(value) {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function mapPolicyState(state) {
  const stateMap = {
    enabled: { label: "Enabled", enforcementMode: "enforced" },
    disabled: { label: "Disabled", enforcementMode: "disabled" },
    enabledForReportingButNotEnforced: {
      label: "Report only",
      enforcementMode: "report_only"
    }
  };

  if (stateMap[state]) {
    return stateMap[state];
  }

  return { label: "Unknown", enforcementMode: "unknown" };
}

function mapPolicyConditions(conditions) {
  const users = conditions && conditions.users ? conditions.users : {};
  const applications = conditions && conditions.applications ? conditions.applications : {};
  const platforms = conditions && conditions.platforms ? conditions.platforms : {};
  const locations = conditions && conditions.locations ? conditions.locations : {};

  return {
    clientAppTypes: toArray(conditions && conditions.clientAppTypes),
    signInRiskLevels: toArray(conditions && conditions.signInRiskLevels),
    userRiskLevels: toArray(conditions && conditions.userRiskLevels),
    servicePrincipalRiskLevels: toArray(conditions && conditions.servicePrincipalRiskLevels),
    include: {
      users: toArray(users.includeUsers),
      groups: toArray(users.includeGroups),
      roles: toArray(users.includeRoles),
      applications: toArray(applications.includeApplications),
      userActions: toArray(applications.includeUserActions),
      authenticationContextClassReferences: toArray(applications.includeAuthenticationContextClassReferences),
      platforms: toArray(platforms.includePlatforms),
      locations: toArray(locations.includeLocations)
    },
    exclude: {
      users: toArray(users.excludeUsers),
      groups: toArray(users.excludeGroups),
      roles: toArray(users.excludeRoles),
      applications: toArray(applications.excludeApplications),
      platforms: toArray(platforms.excludePlatforms),
      locations: toArray(locations.excludeLocations)
    }
  };
}

function mapGrantControls(grantControls) {
  if (!grantControls || typeof grantControls !== "object") {
    return {
      operator: "",
      builtInControls: [],
      customAuthenticationFactors: [],
      termsOfUse: []
    };
  }

  return {
    operator: grantControls.operator || "",
    builtInControls: toArray(grantControls.builtInControls),
    customAuthenticationFactors: toArray(grantControls.customAuthenticationFactors),
    termsOfUse: toArray(grantControls.termsOfUse)
  };
}

function mapSessionControls(sessionControls) {
  if (!sessionControls || typeof sessionControls !== "object") {
    return {};
  }

  return deepClone(sessionControls);
}

function mapPolicy(policy, options = {}) {
  const state = mapPolicyState(policy.state);
  const mapped = {
    id: policy.id || "",
    name: policy.displayName || "",
    description: policy.description || "",
    state: policy.state || "unknown",
    stateLabel: state.label,
    enforcementMode: state.enforcementMode,
    createdDateTime: policy.createdDateTime || null,
    modifiedDateTime: policy.modifiedDateTime || null,
    conditions: mapPolicyConditions(policy.conditions),
    grantControls: mapGrantControls(policy.grantControls),
    sessionControls: mapSessionControls(policy.sessionControls)
  };

  if (options.includeRaw) {
    mapped.raw = deepClone(policy);
  }

  return mapped;
}

function createPoliciesService({ graphBaseUrl }) {
  function shouldUseDemoData(tenant) {
    if (!tenant || tenant.isDemo) {
      return true;
    }

    if (!getLiveGraphEnabled()) {
      return true;
    }

    return false;
  }

  async function listPolicies(tenant, options = {}) {
    if (shouldUseDemoData(tenant)) {
      const policies = getDemoPolicies().map((policy) => mapPolicy(policy, options));
      return {
        ok: true,
        mode: "demo",
        policyCount: policies.length,
        tokenSource: "demo",
        policies
      };
    }

    const tokenResult = await getAccessToken(tenant);
    if (!tokenResult.ok) {
      return {
        ok: false,
        statusCode: tokenResult.statusCode || 502,
        error: tokenResult.error
      };
    }

    const result = await graphRequest({
      baseUrl: graphBaseUrl,
      token: tokenResult.accessToken,
      path: "/identity/conditionalAccess/policies"
    });

    if (!result.ok) {
      return { ok: false, statusCode: result.statusCode || 502, error: result.error };
    }

    const sourcePolicies = result.data && Array.isArray(result.data.value) ? result.data.value : [];
    const policies = sourcePolicies.map((policy) => mapPolicy(policy, options));

    return {
      ok: true,
      mode: "live",
      policyCount: policies.length,
      tokenSource: tokenResult.source || "msal",
      policies
    };
  }

  return {
    listPolicies
  };
}

module.exports = {
  createPoliciesService,
  mapPolicy
};
