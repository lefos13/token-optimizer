/* Plans are declarative previews while execution details stay in a private
   registry. This keeps credentials and callbacks out of immutable JSON plans
   while allowing the compatibility installer API to share the same pipeline. */
const executions = new WeakMap();

function registerPlan(plan, execute, prepare, state, executePlan) {
  executions.set(plan, { execute, prepare, state, executePlan });
  return plan;
}

function applyChangePlan(plan, adapters = {}) {
  if (!plan || !Array.isArray(plan.operations)) throw new TypeError("invalid change plan");
  const registered = executions.get(plan);
  if (!adapters.applyOperation && !adapters.apply && registered?.executePlan) {
    return registered.executePlan(adapters);
  }
  const applied = [];
  const rolledBack = [];
  const manualRemediation = [];
  const inverses = [];
  const commits = [];
  const operationResults = [];
  /* Progress is derived only from the already-sanitized declarative plan. This
     keeps callbacks useful for every lifecycle without exposing execution state. */
  const notify = typeof adapters.onProgress === "function" ? adapters.onProgress : () => {};
  const eventFor = (event, operation, sequence, status) => notify({
    schemaVersion: 1,
    event,
    phase: operation?.phase || "apply",
    sequence,
    total: plan.operations.length,
    operationId: operation?.id || operation?.kind,
    kind: operation?.kind,
    client: operation?.client,
    path: operation?.path,
    status,
    message: operation ? `${status}: ${operation.id || operation.kind}` : `${status}: ${plan.action || "change plan"}`,
  });
  try {
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index];
      eventFor("operation-start", operation, index + 1, "running");
      const apply = adapters.applyOperation || adapters.apply;
      const execution = executions.get(plan);
      if (!apply && !execution) throw new Error("change plan is not registered for execution");
      const transaction = apply && adapters.prepareOperation
        ? adapters.prepareOperation(operation, plan)
        : (!apply && execution?.prepare ? execution.prepare(operation) : null);
      if (transaction && typeof transaction.inverse === "function") inverses.push({ operation, inverse: transaction.inverse });
      if (transaction && typeof transaction.commit === "function") commits.push({ operation, commit: transaction.commit });
      const result = apply ? apply(operation, plan) : execution?.execute(operation);
      applied.push(operation);
      if (result && result.details) operationResults.push({ operationId: operation.id, ...result.details });
      if (result && typeof result.inverse === "function") inverses.push({ operation, inverse: result.inverse });
      eventFor("operation-complete", operation, index + 1, "completed");
    }
    for (const entry of commits) {
      try { entry.commit(); }
      catch { manualRemediation.push(entry.operation); }
    }
    eventFor("complete", null, plan.operations.length, "completed");
    return { applied, rolledBack, manualRemediation, operationResults, installedClients: plan.clients ? [...plan.clients] : [], credentialRef: executions.get(plan)?.state?.credentialRef, credentialOwned: executions.get(plan)?.state?.credentialOwned, credentialOwnershipCleared: executions.get(plan)?.state?.credentialOwnershipCleared === true };
  } catch (error) {
    eventFor("rollback-start", applied[applied.length - 1] || plan.operations[applied.length], applied.length, "rolling-back");
    for (let index = inverses.length - 1; index >= 0; index -= 1) {
      const entry = inverses[index];
      try { entry.inverse(); rolledBack.push(entry.operation); eventFor("operation-rolled-back", entry.operation, index + 1, "rolled-back"); }
      catch { manualRemediation.push(entry.operation); }
    }
    if (adapters.rollback) {
      for (let index = applied.length - 1; index >= 0; index -= 1) {
        if (rolledBack.includes(applied[index])) continue;
        try { adapters.rollback(applied[index], plan); rolledBack.push(applied[index]); }
        catch { manualRemediation.push(applied[index]); }
      }
    }
    eventFor("complete", null, applied.length, "failed");
    return { applied, rolledBack, manualRemediation, operationResults, error, installedClients: plan.clients ? [...plan.clients] : [] };
  }
}

function defaultAdapters() { return {}; }

module.exports = { registerPlan, applyChangePlan, defaultAdapters };
