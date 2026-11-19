-- Phase 6: workspace isolation for signed-in users, owner-managed membership, audit trail, per-workspace secrets.

create or replace function is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'owner');
$$;
revoke execute on function is_owner(uuid) from public, anon;
grant execute on function is_owner(uuid) to authenticated;

-- Signed-in members need to write what the app writes on their behalf (still limited to their own workspaces).
create policy trace_write on trace_steps for all using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy cache_write on page_cache for all using (is_member(workspace_id)) with check (is_member(workspace_id));

-- Owners manage membership and the workspace name.
create policy mem_insert on workspace_members for insert with check (is_owner(workspace_id));
create policy mem_delete on workspace_members for delete using (is_owner(workspace_id));
create policy ws_update on workspaces for update using (is_owner(id)) with check (is_owner(id));

-- Only an existing owner can start another workspace (an agency adding a client). Open sign-ups get nothing.
create or replace function create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from workspace_members where user_id = auth.uid() and role = 'owner') then raise exception 'only a workspace owner can create a workspace'; end if;
  if p_name is null or length(btrim(p_name)) = 0 or length(p_name) > 80 then raise exception 'workspace name must be 1 to 80 characters'; end if;
  insert into workspaces (name, created_by) values (btrim(p_name), auth.uid()) returning id into ws;
  insert into workspace_members (workspace_id, user_id, role) values (ws, auth.uid(), 'owner');
  return ws;
end;
$$;
revoke execute on function create_workspace(text) from public, anon;
grant execute on function create_workspace(text) to authenticated;

-- Email to user id, for adding a member. Callable only by the server's service role.
create or replace function find_user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = public, auth as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;
revoke execute on function find_user_id_by_email(text) from public, anon, authenticated;
grant execute on function find_user_id_by_email(text) to service_role;

-- Append-only audit trail. Members can read their workspace's events and add their own; nobody can edit or delete.
create table audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  actor text not null default '',
  action text not null,
  entity_type text,
  entity_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_ws_idx on audit_log (workspace_id, created_at desc);
alter table audit_log enable row level security;
create policy audit_read on audit_log for select using (is_member(workspace_id));
create policy audit_insert on audit_log for insert with check (is_member(workspace_id) and user_id = auth.uid());
revoke update, delete, truncate on audit_log from anon, authenticated;

-- Per-workspace API keys, encrypted by the server. No policies: only the service role can touch this table.
create table workspace_secrets (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (name in ('gemini', 'anthropic', 'hunter')),
  ciphertext text not null,
  key_hint text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, name)
);
alter table workspace_secrets enable row level security;
revoke all on workspace_secrets from anon, authenticated;

alter table drafts add column if not exists reviewed_by uuid references auth.users(id) on delete set null;
