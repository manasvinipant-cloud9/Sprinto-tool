create table contact_overrides (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  domain text not null,
  name text not null,
  email text not null,
  title text not null default '',
  linkedin text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, domain)
);
alter table contact_overrides enable row level security;
create policy contact_overrides_rw on contact_overrides for all using (is_member(workspace_id)) with check (is_member(workspace_id));
