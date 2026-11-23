-- Candidate index for provider-existence reconciliation of running deployment nodes
-- (services/deployment-node-provider-existence.ts; columns added in 0267). Partial: only running
-- managed deployment VMs, so each selection reads live deployment nodes rather than every node
-- row ever created. Additive.
CREATE INDEX IF NOT EXISTS idx_nodes_deployment_existence_due
  ON nodes (provider_existence_checked_at)
  WHERE node_role = 'deployment' AND node_class = 'managed' AND runtime = 'vm'
    AND status = 'running' AND provider_instance_id IS NOT NULL;
