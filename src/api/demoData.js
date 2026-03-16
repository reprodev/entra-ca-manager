const demoTenant = {
  id: "kontoso-demo-tenant",
  name: "Kontoso Managed Services",
  domain: "kontoso.com",
  tenantId: "00000000-0000-0000-0000-000000000001",
  clientId: "",
  clientSecret: "",
  accessToken: "",
  status: "healthy",
  isDemo: true
};

const demoPolicies = [
  {
    id: "kontoso-policy-001",
    displayName: "Kontoso Baseline MFA",
    description: "Require MFA for all admins in the Kontoso demo tenant.",
    state: "enabled",
    createdDateTime: "2026-01-10T09:00:00Z",
    modifiedDateTime: "2026-03-10T11:15:00Z",
    conditions: {
      users: {
        includeRoles: [
          "62e90394-69f5-4237-9190-012177145e10"
        ],
        excludeUsers: []
      },
      applications: {
        includeApplications: ["All"]
      },
      locations: {
        includeLocations: ["All"],
        excludeLocations: []
      },
      platforms: {
        includePlatforms: ["all"]
      }
    },
    grantControls: {
      operator: "OR",
      builtInControls: ["mfa"]
    }
  },
  {
    id: "kontoso-policy-002",
    displayName: "Kontoso Legacy Auth Block",
    description: "Block legacy authentication protocols for the demo estate.",
    state: "enabled",
    createdDateTime: "2026-02-04T15:20:00Z",
    modifiedDateTime: "2026-03-11T08:05:00Z",
    conditions: {
      users: {
        includeUsers: ["All"],
        excludeUsers: []
      },
      clientAppTypes: ["exchangeActiveSync", "other"]
    },
    grantControls: {
      operator: "OR",
      builtInControls: ["block"]
    }
  },
  {
    id: "kontoso-policy-003",
    displayName: "Kontoso Travel Access (Report Only)",
    description: "Report-only travel policy example for whitelabel demos.",
    state: "enabledForReportingButNotEnforced",
    createdDateTime: "2026-03-01T10:30:00Z",
    modifiedDateTime: "2026-03-12T16:40:00Z",
    conditions: {
      users: {
        includeGroups: ["00000000-0000-0000-0000-000000000900"]
      },
      locations: {
        includeLocations: ["00000000-0000-0000-0000-000000000777"]
      }
    },
    grantControls: {
      operator: "OR",
      builtInControls: ["compliantDevice", "mfa"]
    },
    sessionControls: {
      signInFrequency: {
        value: 12,
        type: "hours",
        isEnabled: true
      }
    }
  }
];

function deepClone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function getDemoTenant() {
  return deepClone(demoTenant);
}

function getDemoPolicies() {
  return deepClone(demoPolicies);
}

module.exports = {
  getDemoPolicies,
  getDemoTenant
};
