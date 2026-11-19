alter table trace_steps add column if not exists phase text;
alter table trace_steps add column if not exists ctx text;
alter table trace_steps drop constraint if exists trace_steps_kind_check;
alter table trace_steps add constraint trace_steps_kind_check check (kind in ('llm','fetch_page','search_news','contact_lookup','gate','score','draft'));
create index if not exists trace_steps_account_idx on trace_steps (account_id, seq);
