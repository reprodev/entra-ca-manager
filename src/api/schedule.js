const scheduledChanges = [];

function listScheduledChanges() {
  return [...scheduledChanges];
}

function addScheduledChange(change) {
  const entry = {
    id: change.id,
    tenantId: change.tenantId,
    policyId: change.policyId,
    action: change.action,
    runAt: change.runAt,
    recurrence: change.recurrence || null,
    status: change.status || "pending"
  };

  scheduledChanges.push(entry);
  return entry;
}

module.exports = {
  listScheduledChanges,
  addScheduledChange
};
