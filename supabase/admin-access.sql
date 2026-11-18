-- =====================================================================================================
-- Career Gyan · read-only leads dashboard (careergyan.co/admin) · 2026-11-18
-- Run ONCE in Supabase > SQL Editor, after registrations-forms.sql.
--
-- Who can see leads: only signed-in users listed in public.admin_users.
-- What they can do: READ ONLY (select). They cannot insert, change or delete anything.
-- The website forms and Edge Functions keep working exactly as before.
-- =====================================================================================================


-- 1. The list of people allowed into the dashboard ---------------------------------------------------
create table if not exists public.admin_users (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  email     text,
  added_at  timestamptz not null default now()
);
alter table public.admin_users enable row level security;
revoke all on public.admin_users from anon, authenticated;

-- true when the signed-in user is on the list (used by every policy below and by the dashboard)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admin_users where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;


-- 2. Read-only access for those people ----------------------------------------------------------------
-- Row Level Security on every lead table (the Edge Functions use the secret key, which is not affected).
alter table public.registrations           enable row level security;
alter table public.forms                   enable row level security;
alter table public.form_categories         enable row level security;
alter table public.enquiries               enable row level security;
alter table public.eligibility_submissions enable row level security;

-- Signed-in users get SELECT only (no insert / update / delete).
revoke insert, update, delete, truncate on
  public.registrations, public.forms, public.form_categories, public.enquiries, public.eligibility_submissions
  from authenticated;
revoke all on public.registrations, public.forms, public.form_categories from anon;   -- visitors never read these
grant select on
  public.registrations, public.forms, public.form_categories, public.enquiries, public.eligibility_submissions,
  public.form_registration_summary
  to authenticated;

-- ...and SELECT returns rows only for people on the admin list.
drop policy if exists "admins read registrations" on public.registrations;
create policy "admins read registrations" on public.registrations
  for select to authenticated using (public.is_admin());

drop policy if exists "admins read forms" on public.forms;
create policy "admins read forms" on public.forms
  for select to authenticated using (public.is_admin());

drop policy if exists "admins read form categories" on public.form_categories;
create policy "admins read form categories" on public.form_categories
  for select to authenticated using (public.is_admin());

drop policy if exists "admins read enquiries" on public.enquiries;
create policy "admins read enquiries" on public.enquiries
  for select to authenticated using (public.is_admin());

drop policy if exists "admins read eligibility" on public.eligibility_submissions;
create policy "admins read eligibility" on public.eligibility_submissions
  for select to authenticated using (public.is_admin());

-- (The website's existing "insert only" policies for enquiries and eligibility_submissions are not touched.)


-- =====================================================================================================
-- 3. ADD A TEAM MEMBER (repeat for each person)
--   a) Supabase > Authentication > Users > "Add user" > "Create new user":
--      enter their email and a password, tick "Auto Confirm User".
--   b) Run (with their email):
--
-- insert into public.admin_users (user_id, email)
-- select id, email from auth.users where email = 'marketing@careergyan.co'
-- on conflict (user_id) do nothing;
--
-- REMOVE ACCESS:
-- delete from public.admin_users where email = 'marketing@careergyan.co';
--
-- RECOMMENDED: Authentication > Sign In / Providers > Email > turn OFF "Allow new users to sign up",
-- so nobody can create their own account. (Even if someone did, they would see no data.)
-- =====================================================================================================
