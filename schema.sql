-- =====================================================================================================
-- schema.sql - the CRM database (Supabase / PostgreSQL). Safe to run again and again in the SQL editor:
-- it only creates what is missing and never deletes data.
--
--   profile (1 row)          my company: header of every invoice, default hourly rate
--   clients                  Name, Phone, Email, Address, Notes
--     └ projects             job site address + optional Estimate (fixed price OR rate × hours)
--         ├ visits           date, Planned Work, Time Spent, status, photos
--         ├ receipts         amount, store, date, Billable switch, photos; invoice_id = "Invoiced"
--         └ invoices         estimates + invoices (kind), with line items; invoices are Paid / Unpaid
--   team_members             who can sign in: Owner / Manager / Employee (login accounts live in Supabase Auth)
--
-- Photo FILES live in the Storage bucket "crm-photos" (create it in Supabase > Storage, Public = ON);
-- the tables only keep their links (image_urls).
-- =====================================================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------- My Profile: always exactly one row with id = 1 ----------
create table if not exists profile (
  id                  int primary key default 1 check (id = 1),
  company_name        text not null default '',
  phone               text not null default '',
  email               text not null default '',
  business_address    text not null default '',
  payment_details     text not null default '',
  default_hourly_rate numeric(12,2) not null default 0,
  logo_url            text not null default ''
);
insert into profile (id) values (1) on conflict (id) do nothing;

-- ---------- Clients ----------
create table if not exists clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  phone      text not null default '',
  email      text not null default '',
  street     text not null default '',
  city       text not null default '',
  state      text not null default '',
  zip        text not null default '',
  notes      text not null default '',   -- the app also keeps hidden extras here after "<!--HCRM:"
  created_at timestamptz not null default now()
);

-- ---------- Projects (deleting a client deletes its projects) ----------
create table if not exists projects (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references clients(id) on delete cascade,
  name                 text not null default '',
  street               text not null default '',
  city                 text not null default '',
  state                text not null default '',
  zip                  text not null default '',
  estimate_mode        text check (estimate_mode in ('fixed', 'hourly')),   -- NULL = no estimate
  estimate_description text not null default '',
  estimate_fixed       numeric(12,2),
  estimate_rate        numeric(12,2),
  estimate_hours       numeric(10,2),
  created_at           timestamptz not null default now()
);
create index if not exists projects_client_idx on projects (client_id);

-- ---------- Visits ----------
create table if not exists visits (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  visit_date   date not null default current_date,
  planned_work text not null default '',
  time_spent   numeric(10,2) not null default 0,
  status       text not null default 'Scheduled'
               check (status in ('Scheduled', 'In Progress', 'Completed', 'Canceled')),
  image_urls   text[],
  created_at   timestamptz not null default now()
);
create index if not exists visits_project_idx on visits (project_id);

-- ---------- Invoices (always created from one visit) ----------
create table if not exists invoices (
  id               uuid primary key default gen_random_uuid(),
  visit_id         uuid not null references visits(id) on delete cascade,
  project_id       uuid not null references projects(id) on delete cascade,
  client_id        uuid not null references clients(id) on delete cascade,
  invoice_number   text not null default '',
  invoice_date     date not null default current_date,
  status           text not null default 'Unpaid' check (status in ('Unpaid', 'Paid')),
  paid_date        date,
  description      text not null default '',
  hours            numeric(10,2) not null default 0,
  hourly_rate      numeric(12,2) not null default 0,
  labor_amount     numeric(12,2) not null default 0,
  materials_amount numeric(12,2) not null default 0,
  total            numeric(12,2) not null default 0,
  estimate_amount  numeric(12,2),   -- the project's estimate when the invoice was made (NULL = none)
  created_at       timestamptz not null default now()
);
create index if not exists invoices_project_idx on invoices (project_id);
create index if not exists invoices_client_idx  on invoices (client_id);

-- ---------- Receipts ----------
create table if not exists receipts (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references projects(id) on delete cascade,
  visit_id     uuid references visits(id) on delete set null,
  amount       numeric(12,2) not null default 0,
  store        text not null default '',
  category     text not null default '',
  receipt_date date not null default current_date,
  billable     boolean not null default false,   -- [ + Add to Invoice ]
  invoice_id   uuid references invoices(id) on delete set null,   -- set = "Invoiced", can't be billed twice
  image_urls   text[],
  created_at   timestamptz not null default now()
);
create index if not exists receipts_project_idx on receipts (project_id);
create index if not exists receipts_invoice_idx on receipts (invoice_id);

-- =====================================================================================================
-- VERSION 2: logins, team, line items (added Nov 2026). Everything below is also safe to re-run.
-- =====================================================================================================

-- ---------- Team: who can sign in, and with which role ----------
-- user_id = the login account in Supabase > Authentication > Users. The app creates both together.
create table if not exists team_members (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid unique,
  name       text not null default '',
  email      text not null default '',
  phone      text not null default '',
  specialty  text not null default '',
  role       text not null default 'Employee' check (role in ('Owner', 'Manager', 'Employee')),
  active     boolean not null default true,   -- deactivated people can't sign in; their history stays
  created_at timestamptz not null default now()
);

-- what one hour of this person costs you (wages etc.); only the Owner sees it. Used for job profit in Reports.
alter table team_members add column if not exists hourly_cost numeric(12,2) not null default 0;

-- ---------- Owner settings ----------
alter table profile add column if not exists expense_threshold  numeric(12,2) not null default 150;
alter table profile add column if not exists approvals_required boolean      not null default true;

-- ---------- Who does a task, who entered a receipt ----------
alter table visits   add column if not exists assigned_to uuid references team_members(id) on delete set null;
alter table receipts add column if not exists created_by  uuid references team_members(id) on delete set null;
create index if not exists visits_assigned_idx  on visits (assigned_to);
create index if not exists receipts_creator_idx on receipts (created_by);

-- ---------- Estimates and invoices are ONE kind of document with line items ----------
alter table invoices add column if not exists kind        text   not null default 'invoice';
alter table invoices add column if not exists line_items  jsonb;                          -- [{description, qty, rate, amount, type}]
alter table invoices add column if not exists visit_ids   uuid[] not null default '{}';   -- tasks this invoice bills
alter table invoices add column if not exists estimate_id uuid references invoices(id) on delete set null;  -- made from this estimate
alter table invoices alter column visit_id drop not null;   -- estimates and project invoices need no single visit
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_kind_check') then
    alter table invoices add constraint invoices_kind_check check (kind in ('invoice', 'estimate'));
  end if;
end $$;
update invoices set visit_ids = array[visit_id] where visit_id is not null and visit_ids = '{}';

-- ---------- One-time move: old project estimates (Fixed / Hourly) become estimate documents ----------
-- Runs only for projects that have an old estimate and no estimate document yet.
with base as (
  select coalesce(max(nullif(regexp_replace(invoice_number, '\D', '', 'g'), '')::int), 0) as n
  from invoices where kind = 'estimate'
), todo as (
  select p.*, row_number() over (order by p.created_at) as rn,
         nullif(trim(split_part(p.estimate_description, E'\n<!--HCRM:', 1)), '') as scope
  from projects p
  where p.estimate_mode in ('fixed', 'hourly')
    and not exists (select 1 from invoices i where i.kind = 'estimate' and i.project_id = p.id)
)
insert into invoices (kind, project_id, client_id, invoice_number, invoice_date, status, description,
                      line_items, labor_amount, total)
select 'estimate', t.id, t.client_id, 'EST-' || lpad((base.n + t.rn)::text, 4, '0'), t.created_at::date, 'Unpaid', '',
       jsonb_build_array(jsonb_build_object(
         'description', coalesce(t.scope, t.name),
         'qty',  case when t.estimate_mode = 'fixed' then 1 else coalesce(t.estimate_hours, 0) end,
         'rate', case when t.estimate_mode = 'fixed' then coalesce(t.estimate_fixed, 0)
                      else coalesce(t.estimate_rate, (select default_hourly_rate from profile where id = 1), 0) end,
         'type', 'labor')),
       amt.v, amt.v
from todo t cross join base
cross join lateral (select round(case when t.estimate_mode = 'fixed' then coalesce(t.estimate_fixed, 0)
        else coalesce(t.estimate_hours, 0) * coalesce(t.estimate_rate, (select default_hourly_rate from profile where id = 1), 0)
        end, 2) as v) amt;

-- ---------- Invoice numbers must be unique (protects against two clicks at the same moment) ----------
do $$
begin
  drop index if exists invoices_number_key;   -- v1 index; numbers are now unique per kind (INV-/EST-)
  create unique index if not exists invoices_kind_number_key on invoices (kind, invoice_number) where invoice_number <> '';
exception when unique_violation then
  raise notice 'Duplicate invoice numbers exist - fix them, then run this script again.';
end $$;

-- ---------- Old tables from the first version of the app (nothing uses them any more) ----------
-- Look at them first; when you are sure you don't need the data, remove the two dashes and run:
-- drop table if exists pending_changes;
-- drop table if exists chat_messages;
-- drop table if exists payments;
-- drop table if exists transactions;
-- drop function if exists assign_invoice_number(uuid);
-- drop sequence if exists invoice_number_seq;

notify pgrst, 'reload schema';   -- Supabase's API sees changes immediately
