/* Plans are declarative previews while execution details stay in a private
   registry. This keeps credentials and callbacks out of immutable JSON plans
   while allowing the compatibility installer API to share the same pipeline. */
const executions = new WeakMap();

function registerPlan(plan, execute, prepare, state) {
  executions.set(plan, { execute, prepare, state });
  return plan;
}

function applyChangePlan(plan, adapters = {}) {
  if (!plan || !Array.isArray(plan.operations)) throw new TypeError("invalid change plan");
  const applied = [];
  const rolledBack = [];
  const manualRemediation = [];
  const inverses = [];
  const commits = [];
  try {
    for (const operation of plan.operations) {
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
      if (result && typeof result.inverse === "function") inverses.push({ operation, inverse: result.inverse });
    }
    for (const entry of commits) {
      try { entry.commit(); }
      catch { manualRemediation.push(entry.operation); }
    }
    return { applied, rolledBack, manualRemediation, installedClients: plan.clients ? [...plan.clients] : [], credentialRef: executions.get(plan)?.state?.credentialRef, credentialOwned: executions.get(plan)?.state?.credentialOwned, credentialOwnershipCleared: executions.get(plan)?.state?.credentialOwnershipCleared === true };
  } catch (error) {
    for (let index = inverses.length - 1; index >= 0; index -= 1) {
      const entry = inverses[index];
      try { entry.inverse(); rolledBack.push(entry.operation); }
      catch { manualRemediation.push(entry.operation); }
    }
    if (adapters.rollback) {
      for (let index = applied.length - 1; index >= 0; index -= 1) {
        if (rolledBack.includes(applied[index])) continue;
        try { adapters.rollback(applied[index], plan); rolledBack.push(applied[index]); }
        catch { manualRemediation.push(applied[index]); }
      }
    }
    return { applied, rolledBack, manualRemediation, error, installedClients: plan.clients ? [...plan.clients] : [] };
  }
}

function defaultAdapters() { return {}; }

module.exports = { registerPlan, applyChangePlan, defaultAdapters };
