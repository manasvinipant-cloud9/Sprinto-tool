alter table runs add column if not exists note text;
alter table runs add column if not exists fetches int not null default 0;
alter table runs add column if not exists searches int not null default 0;
alter table runs add column if not exists accounts_capped int not null default 0;
alter table run_accounts add column if not exists fetches int not null default 0;
alter table run_accounts add column if not exists searches int not null default 0;
alter table run_accounts add column if not exists est_cost_usd numeric(10,5) not null default 0;
alter table run_accounts add column if not exists attempts int not null default 0;
