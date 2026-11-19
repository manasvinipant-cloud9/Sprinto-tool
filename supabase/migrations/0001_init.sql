-- Outreach workspace schema. Applied to Supabase project zmdbzdozisuuburmoldl (outreach-workspace, ap-south-1).
-- Server code uses the service role; browsers (if ever used) go through RLS below.
-- There is deliberately no table or column for "sent": the app never sends email.

create extension if not exists pgcrypto;

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create or replace function is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members m where m.workspace_id = ws and m.user_id = auth.uid());
$$;

create table profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9-]+$'),
  version int not null default 1,
  name text not null,
  yaml text not null,
  spec jsonb not null,
  hash text not null,
  cloned_from uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slug, version)
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  profile_id uuid not null references profiles(id),
  profile_hash text not null,
  comparison_group uuid,
  status text not null default 'queued' check (status in ('queued','running','paused','finished','failed')),
  caps jsonb not null,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  loop_steps int not null default 0,
  est_cost_usd numeric(10,4) not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  started_at timestamptz,
  finished_at timestamptz
);

create table run_accounts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  domain text not null,
  position int not null,
  stage text not null default 'queued' check (stage in
    ('queued','researching','gate_evaluation','contact_lookup','drafting','ready_for_review','disqualified','capped','error')),
  qualification text check (qualification in ('qualified','disqualified','capped')),
  score int,
  result jsonb,
  reason text,
  loop_steps int not null default 0,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (run_id, domain)
);
create index on run_accounts (run_id, position);

create table trace_steps (
  id bigint generated always as identity primary key,
  account_id uuid not null references run_accounts(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  seq int not null,
  kind text not null check (kind in ('llm','fetch_page','search_news','contact_lookup','gate','score','draft')),
  label text,
  input jsonb,
  output jsonb,
  status text,
  ms int,
  tokens_in int,
  tokens_out int,
  created_at timestamptz not null default now(),
  unique (account_id, seq)
);

create table drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references run_accounts(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  version int not null default 1,
  subject text not null,
  body text not null,
  notes text,
  instruction text,
  lint jsonb not null default '[]',
  lint_overridden boolean not null default false,
  review_status text not null default 'pending_review' check (review_status in ('pending_review','approved','rejected')),
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  unique (account_id, version)
);

-- Per-workspace page cache: lets re-runs and profile comparisons reuse one fetch.
create table page_cache (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  url text not null,
  domain text not null,
  status text not null,
  text text not null default '',
  words int not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (workspace_id, url)
);

-- Row level security: members see only their workspaces' rows.
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table profiles enable row level security;
alter table runs enable row level security;
alter table run_accounts enable row level security;
alter table trace_steps enable row level security;
alter table drafts enable row level security;
alter table page_cache enable row level security;

create policy ws_read on workspaces for select using (is_member(id));
create policy mem_read on workspace_members for select using (user_id = auth.uid() or is_member(workspace_id));
create policy profiles_rw on profiles for all using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy runs_rw on runs for all using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy accounts_rw on run_accounts for all using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy trace_read on trace_steps for select using (is_member(workspace_id));
create policy drafts_rw on drafts for all using (is_member(workspace_id)) with check (is_member(workspace_id));
create policy cache_read on page_cache for select using (is_member(workspace_id));
