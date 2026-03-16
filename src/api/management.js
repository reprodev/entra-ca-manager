const crypto = require("crypto");
const { getAccessToken } = require("./auth");
const { graphRequest } = require("./graphClient");
const { getCalendarIntegrationConfig } = require("./runtimeConfig");

function summarizePolicies(policies) {
  const summary = {
    total: policies.length,
    enabled: 0,
    disabled: 0,
    reportOnly: 0,
    unknown: 0
  };

  for (const policy of policies) {
    if (policy.state === "enabled") {
      summary.enabled += 1;
      continue;
    }

    if (policy.state === "disabled") {
      summary.disabled += 1;
      continue;
    }

    if (policy.state === "enabledForReportingButNotEnforced") {
      summary.reportOnly += 1;
      continue;
    }

    summary.unknown += 1;
  }

  return summary;
}

function addDays(date, days) {
  const cloned = new Date(date.getTime());
  cloned.setUTCDate(cloned.getUTCDate() + days);
  return cloned;
}

function formatLocalDateTime(date) {
  return date.toISOString().slice(0, 19);
}

function chooseReminderWindowDays(policy, calendarConfig) {
  if (policy.state === "enabledForReportingButNotEnforced") {
    return calendarConfig.reportOnlyReviewDays;
  }

  if (policy.state === "disabled") {
    return calendarConfig.disabledReviewDays;
  }

  return calendarConfig.standardReviewDays;
}

function buildReminderKey({ tenant, reminderType, policyId, startDateTime }) {
  return [tenant.id, reminderType, policyId || "none", startDateTime].join("|");
}

function toTransactionId(reminderKey) {
  const hex = crypto.createHash("sha1").update(reminderKey).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildPolicyReminder(tenant, policy, now, calendarConfig) {
  const daysAhead = chooseReminderWindowDays(policy, calendarConfig);
  const reminderDate = addDays(now, daysAhead);
  reminderDate.setUTCHours(calendarConfig.defaultHourUtc, calendarConfig.defaultMinuteUtc, 0, 0);

  const endDate = new Date(reminderDate.getTime() + calendarConfig.durationMinutes * 60 * 1000);
  const startDateTime = formatLocalDateTime(reminderDate);
  const endDateTime = formatLocalDateTime(endDate);

  const reminderType = "policy-review";
  const reminderKey = buildReminderKey({
    tenant,
    reminderType,
    policyId: policy.id,
    startDateTime
  });

  return {
    reminderType,
    reminderKey,
    transactionId: toTransactionId(reminderKey),
    title: `[CA Manager] Review "${policy.name}" (${policy.stateLabel})`,
    description: [
      `Tenant: ${tenant.name} (${tenant.domain || tenant.tenantId || tenant.id})`,
      `Policy: ${policy.name}`,
      `State: ${policy.stateLabel}`,
      `Enforcement: ${policy.enforcementMode}`,
      "Action: Confirm policy state is still correct for business operations."
    ].join("\n"),
    startDateTime,
    endDateTime,
    timeZone: calendarConfig.timeZone,
    importance: policy.state === "enabledForReportingButNotEnforced" ? "high" : "normal",
    policyId: policy.id
  };
}

function buildSummaryReminder(tenant, policySummary, now, calendarConfig) {
  if (!calendarConfig.createSummaryReminder) {
    return null;
  }

  const reminderDate = addDays(now, calendarConfig.summaryReviewDays);
  reminderDate.setUTCHours(calendarConfig.defaultHourUtc, calendarConfig.defaultMinuteUtc, 0, 0);
  const endDate = new Date(reminderDate.getTime() + calendarConfig.durationMinutes * 60 * 1000);
  const startDateTime = formatLocalDateTime(reminderDate);
  const endDateTime = formatLocalDateTime(endDate);

  const reminderType = "daily-summary";
  const reminderKey = buildReminderKey({
    tenant,
    reminderType,
    policyId: "",
    startDateTime
  });

  return {
    reminderType,
    reminderKey,
    transactionId: toTransactionId(reminderKey),
    title: `[CA Manager] ${tenant.name} policy state check`,
    description: [
      `Tenant: ${tenant.name} (${tenant.domain || tenant.tenantId || tenant.id})`,
      `Total policies: ${policySummary.total}`,
      `Enabled: ${policySummary.enabled}`,
      `Report only: ${policySummary.reportOnly}`,
      `Disabled: ${policySummary.disabled}`,
      `Unknown: ${policySummary.unknown}`,
      "Action: Review current posture and decide if any change requests are needed."
    ].join("\n"),
    startDateTime,
    endDateTime,
    timeZone: calendarConfig.timeZone,
    importance: "normal",
    policyId: ""
  };
}

function buildReminderPlan(tenant, policies, now = new Date()) {
  const calendarConfig = getCalendarIntegrationConfig();
  const policySummary = summarizePolicies(policies);

  const reminders = policies.map((policy) => buildPolicyReminder(tenant, policy, now, calendarConfig));
  const summaryReminder = buildSummaryReminder(tenant, policySummary, now, calendarConfig);
  if (summaryReminder) {
    reminders.unshift(summaryReminder);
  }

  return {
    generatedAt: new Date().toISOString(),
    calendarConfig: {
      timeZone: calendarConfig.timeZone,
      enabled: calendarConfig.enabled,
      targetUser: calendarConfig.targetUser || "",
      durationMinutes: calendarConfig.durationMinutes
    },
    policySummary,
    reminders
  };
}

function toGraphEventPayload(reminder) {
  return {
    subject: reminder.title,
    body: {
      contentType: "Text",
      content: reminder.description
    },
    start: {
      dateTime: reminder.startDateTime,
      timeZone: reminder.timeZone
    },
    end: {
      dateTime: reminder.endDateTime,
      timeZone: reminder.timeZone
    },
    categories: ["CA Manager", "Automated Reminder"],
    importance: reminder.importance,
    transactionId: reminder.transactionId
  };
}

function emptyCalendarSyncResult(executed, reason) {
  return {
    executed,
    deduplicated: false,
    reason,
    createdCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdEvents: [],
    skippedEvents: [],
    failures: []
  };
}

async function fetchExistingTransactionIds(token, targetUser, graphBaseUrl) {
  const existing = new Set();
  const encodedUser = encodeURIComponent(targetUser);
  let path = `/users/${encodedUser}/events?$select=transactionId&$filter=categories/any(c:c eq 'CA Manager')&$top=100`;
  let pages = 0;
  const maxPages = 10;

  while (path && pages < maxPages) {
    const result = await graphRequest({ baseUrl: graphBaseUrl, token, path });
    if (!result.ok) {
      break;
    }

    const items = result.data && Array.isArray(result.data.value) ? result.data.value : [];
    for (const item of items) {
      if (item.transactionId) {
        existing.add(item.transactionId);
      }
    }

    path = result.data && result.data["@odata.nextLink"] ? result.data["@odata.nextLink"] : null;
    pages += 1;
  }

  return existing;
}

async function syncRemindersToCalendar({ tenant, reminders, graphBaseUrl }) {
  const calendarConfig = getCalendarIntegrationConfig();
  if (!calendarConfig.enabled) {
    return emptyCalendarSyncResult(
      false,
      "Calendar integration is disabled. Set ENABLE_CALENDAR_INTEGRATION=true to enable sync."
    );
  }

  if (tenant.isDemo) {
    return emptyCalendarSyncResult(false, "Calendar sync is skipped for demo tenant mode.");
  }

  if (!calendarConfig.targetUser) {
    return emptyCalendarSyncResult(false, "CALENDAR_TARGET_USER is required to sync reminders.");
  }

  const tokenResult = await getAccessToken(tenant);
  if (!tokenResult.ok) {
    return {
      executed: false,
      deduplicated: false,
      reason: `Unable to acquire Graph token for calendar sync: ${tokenResult.error}`,
      createdCount: 0,
      skippedCount: 0,
      failedCount: reminders.length,
      createdEvents: [],
      skippedEvents: [],
      failures: reminders.map((reminder) => ({
        reminderKey: reminder.reminderKey,
        error: tokenResult.error
      }))
    };
  }

  const existingTransactionIds = await fetchExistingTransactionIds(
    tokenResult.accessToken,
    calendarConfig.targetUser,
    graphBaseUrl
  );

  const createdEvents = [];
  const skippedEvents = [];
  const failures = [];

  for (const reminder of reminders) {
    if (existingTransactionIds.has(reminder.transactionId)) {
      skippedEvents.push({
        reminderKey: reminder.reminderKey,
        transactionId: reminder.transactionId,
        reason: "duplicate"
      });
      continue;
    }

    const result = await graphRequest({
      baseUrl: graphBaseUrl,
      token: tokenResult.accessToken,
      path: `/users/${encodeURIComponent(calendarConfig.targetUser)}/events`,
      method: "POST",
      body: toGraphEventPayload(reminder)
    });

    if (!result.ok) {
      failures.push({
        reminderKey: reminder.reminderKey,
        error: result.error,
        statusCode: result.statusCode || 502
      });
      continue;
    }

    createdEvents.push({
      reminderKey: reminder.reminderKey,
      eventId: result.data && result.data.id ? result.data.id : "",
      subject: reminder.title
    });
  }

  let reason = "All reminders synced to calendar.";
  if (skippedEvents.length > 0 && createdEvents.length === 0 && failures.length === 0) {
    reason = "All reminders already exist in the calendar — nothing to create.";
  } else if (skippedEvents.length > 0 && failures.length > 0) {
    reason = "Completed with skipped duplicates and partial failures.";
  } else if (skippedEvents.length > 0) {
    reason = "Completed. Some reminders were skipped as duplicates.";
  } else if (failures.length > 0) {
    reason = "Completed with partial failures.";
  }

  return {
    executed: true,
    deduplicated: true,
    reason,
    createdCount: createdEvents.length,
    skippedCount: skippedEvents.length,
    failedCount: failures.length,
    createdEvents,
    skippedEvents,
    failures
  };
}

module.exports = {
  buildReminderPlan,
  summarizePolicies,
  syncRemindersToCalendar
};
