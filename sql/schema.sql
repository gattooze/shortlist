-- Shortlist: run once in Supabase > SQL Editor.
-- 1. one doc table, 2. a members allowlist, 3. row-level security so only members read/write, 4. realtime, 5. a public photo bucket.

create table if not exists public.docs (
  coll text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (coll, id)
);

create table if not exists public.members (
  email text primary key,
  role text not null default 'editor' check (role in ('owner','editor','viewer'))
);

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

create or replace function public.can_edit() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', '')) and m.role in ('owner','editor'));
$$;

alter table public.docs enable row level security;
alter table public.members enable row level security;

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated using (public.is_member());
drop policy if exists docs_write on public.docs;
create policy docs_write on public.docs for insert to authenticated with check (public.can_edit());
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated using (public.can_edit()) with check (public.can_edit());
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (public.can_edit());

-- members: a person can see their own row; only the dashboard (service role) edits the list.
drop policy if exists members_self on public.members;
create policy members_self on public.members for select to authenticated using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

alter publication supabase_realtime add table public.docs;
alter table public.docs replica identity full;

-- public bucket for sprite sheets and thumbnails (names are not secret; the content is thumbnails only)
insert into storage.buckets (id, name, public) values ('sheets', 'sheets', true) on conflict (id) do nothing;

-- ADD PEOPLE HERE (replace with real emails), then run:
-- insert into public.members (email, role) values ('you@example.com', 'owner'), ('partner@example.com', 'editor');
