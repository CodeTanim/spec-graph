-- SpecGraph accesses Postgres only from trusted server-side routes and workflows.
-- Keep every application table inaccessible through Supabase's public Data API.
DO $migration$
DECLARE
  target_table text;
  target_role text;
  application_tables text[] := ARRAY[
    'users',
    'workspaces',
    'workspace_members',
    'provider_connection_sessions',
    'confluence_connections',
    'github_installations',
    'sources',
    'source_groups',
    'source_group_members',
    'source_associations',
    'artifacts',
    'artifact_versions',
    'artifact_analysis_cursors',
    'graph_nodes',
    'relationships',
    'change_events',
    'analysis_runs',
    'run_attempts',
    'semantic_analysis_attempts',
    'findings',
    'finding_evidence',
    'finding_actions',
    'webhook_deliveries'
  ];
BEGIN
  FOREACH target_table IN ARRAY application_tables LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      target_table
    );
  END LOOP;

  -- Supabase defines these Data API roles; generic Postgres test environments may not.
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = target_role
    ) THEN
      FOREACH target_table IN ARRAY application_tables LOOP
        EXECUTE format(
          'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',
          target_table,
          target_role
        );
      END LOOP;

      -- New objects stay private unless a later migration explicitly exposes them.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
        target_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
        target_role
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I',
        target_role
      );
    END IF;
  END LOOP;

  EXECUTE
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
END
$migration$;
