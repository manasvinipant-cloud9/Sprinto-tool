-- Deleting a person's account should keep the records they made (runs, profiles, drafts) and just clear who made them.
alter table workspaces drop constraint if exists workspaces_created_by_fkey;
alter table workspaces add constraint workspaces_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table profiles drop constraint if exists profiles_created_by_fkey;
alter table profiles add constraint profiles_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table runs drop constraint if exists runs_created_by_fkey;
alter table runs add constraint runs_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table drafts drop constraint if exists drafts_approved_by_fkey;
alter table drafts add constraint drafts_approved_by_fkey foreign key (approved_by) references auth.users(id) on delete set null;
