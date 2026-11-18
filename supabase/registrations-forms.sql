-- =====================================================================================================
-- Career Gyan · registration forms with their own prices (2026-11-18)
-- Run ONCE in Supabase > SQL Editor, top to bottom, BEFORE deploying the updated Edge Functions.
-- Safe to run even if you already ran the earlier form_name SQL.
--
-- One table for all registrations (public.registrations, unchanged except a form_name column)
-- + one small table of forms (public.forms) holding each form's price, seats and event details.
-- =====================================================================================================


-- 1. FORMS: one row per registration form on the website ----------------------------------------------
create table if not exists public.forms (
  form_name    text primary key,              -- must match the form_name the web page sends, exactly
  category     text not null,
  price_paise  integer not null,              -- ₹1,449 = 144900 · ₹100 = 10000 · ₹50 = 5000
  seat_limit   integer,                       -- null = no limit
  is_open      boolean not null default true, -- false = registrations closed
  event_date   text,                          -- shown in the confirmation email
  event_time   text,
  venue        text
);

alter table public.forms drop constraint if exists forms_category_check;
alter table public.forms add constraint forms_category_check
  check (category in ('Webinar', 'Workshop', 'Spot Admission', 'Education Fair'));
alter table public.forms drop constraint if exists forms_price_check;
alter table public.forms add constraint forms_price_check check (price_paise > 0);
alter table public.forms drop constraint if exists forms_seat_check;
alter table public.forms add constraint forms_seat_check check (seat_limit is null or seat_limit > 0);

-- (if the table already existed from the earlier SQL, make sure the new columns exist)
alter table public.forms add column if not exists event_date text;
alter table public.forms add column if not exists event_time text;
alter table public.forms add column if not exists venue text;

-- Only the Edge Functions (server key) read this table; browsers never do.
alter table public.forms enable row level security;

insert into public.forms (form_name, category, price_paise, seat_limit, is_open, event_date, event_time, venue) values
  ('Study in Europe Workshop', 'Workshop',       144900, null, false, 'Saturday, 21 November 2026', '11:00 AM – 1:00 PM', null),
  ('Personality Workshop',     'Workshop',       144900, 20,   true,  'Saturday, 5 December 2026',  '11:00 AM – 1:00 PM',
     'Career Gyan Jayanagar Office, 41, 7th B Main Rd, 4th Block, Jayanagar, Bengaluru 560011'),
  ('Study in Europe Event',    'Education Fair',  10000, null, true,  'Saturday, 23 January 2027',  '10:00 AM – 5:00 PM',
     'Hyatt Centric, MG Road, Bangalore')
on conflict (form_name) do update set
  category = excluded.category, price_paise = excluded.price_paise, seat_limit = excluded.seat_limit,
  is_open = excluded.is_open, event_date = excluded.event_date, event_time = excluded.event_time, venue = excluded.venue;


-- 2. REGISTRATIONS: which form each registration came from -------------------------------------------
-- (amount, currency, payment_status etc. already exist in your table and are used as they are)
alter table public.registrations add column if not exists form_name text;

-- Every registration so far came from the old Study in Europe Workshop page.
update public.registrations set form_name = 'Study in Europe Workshop' where form_name is null;

alter table public.registrations drop constraint if exists registrations_form_name_fkey;
alter table public.registrations add constraint registrations_form_name_fkey
  foreign key (form_name) references public.forms (form_name);

create index if not exists registrations_form_name_idx on public.registrations (form_name);


-- 3. DEFAULT PRICE PER TYPE ---------------------------------------------------------------------------
-- New forms need no setup: the first registration on a new page adds its row to public.forms automatically,
-- at its type's price below. Add a row to public.forms yourself only to set seats, a special price, or to close it.
create table if not exists public.form_categories (
  category     text primary key check (category in ('Webinar', 'Workshop', 'Spot Admission', 'Education Fair')),
  price_paise  integer not null check (price_paise > 0)
);
alter table public.form_categories enable row level security;

insert into public.form_categories (category, price_paise) values
  ('Webinar',          5000),   -- ₹50
  ('Workshop',       144900),   -- ₹1,449
  ('Education Fair',  10000)    -- ₹100
on conflict (category) do update set price_paise = excluded.price_paise;
-- Spot Admission: no price yet. When decided:
-- insert into public.form_categories values ('Spot Admission', <paise>) on conflict (category) do update set price_paise = excluded.price_paise;


-- 4. REPORTS -----------------------------------------------------------------------------------------
-- Per form: registrations, paid, seats left, money collected
create or replace view public.form_registration_summary
with (security_invoker = true) as
select f.category,
       f.form_name,
       f.is_open,
       f.price_paise / 100                                           as price_rupees,
       count(r.id)                                                   as registrations,
       count(r.id) filter (where r.payment_status = 'paid')          as paid,
       case when f.seat_limit is null then null
            else f.seat_limit - count(r.id) filter (where r.payment_status = 'paid') end as seats_left,
       coalesce(sum(r.amount) filter (where r.payment_status = 'paid'), 0) / 100 as collected_rupees
from public.forms f
left join public.registrations r on r.form_name = f.form_name
group by f.category, f.form_name, f.is_open, f.price_paise, f.seat_limit
order by f.category, f.form_name;

select * from public.form_registration_summary;


-- =====================================================================================================
-- EVERYDAY USE (Table Editor, or SQL)
--   new form    : nothing to do. It is added to public.forms automatically on its first registration,
--                 at its type's price from public.form_categories.
--   type price  : update public.form_categories set price_paise = 5000 where category = 'Webinar';
--                 (applies to forms added from now on; existing forms keep their own price in public.forms)
--   change price: update public.forms set price_paise = 10000 where form_name = 'Study in Europe Event';
--   close form  : update public.forms set is_open = false where form_name = 'Personality Workshop';
--   one form    : select * from public.registrations where form_name = 'Personality Workshop' order by created_at;
--
-- After the new create-order is live, the REGISTRATION_AMOUNT_PAISE secret is no longer used and can be deleted.
-- =====================================================================================================
