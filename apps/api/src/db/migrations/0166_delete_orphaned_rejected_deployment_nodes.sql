-- Remove deployment-node placeholders left by provider create rejections that never returned
-- a VM identity. These rows have no runtime to terminate, no hosted environment/workspace,
-- and block staging cleanup accounting as `destroying` nodes.
DELETE FROM nodes
WHERE node_role = 'deployment'
  AND node_class != 'user-owned'
  AND runtime = 'vm'
  AND status IN ('destroying', 'error')
  AND provider_instance_id IS NULL
  AND runtime_termination_confirmed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM deployment_environments WHERE deployment_environments.node_id = nodes.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspaces WHERE workspaces.node_id = nodes.id
  );
