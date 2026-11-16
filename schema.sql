-- schema.sql : idempotent, safe to re-run in the Supabase SQL editor.
-- Creates missing tables, adds missing columns, converts money to numeric(12,2),
-- and migrates legacy projects.actual_amount into the new payments table (once).

create extension if not exists pgcrypto;

-- ───────────── clients ─────────────
create table if not exists clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  comment    text,
  created_at timestamptz not null default now()
);

-- ───────────── projects ─────────────
create table if not exists projects (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,
  name              text not null,
  address           text,
  scope_description text,
  estimated_amount  numeric(12,2) not null default 0,
  actual_amount     numeric(12,2) not null default 0,   -- LEGACY: no longer used, see payments
  payment_status    text not null default 'paid',        -- LEGACY: now derived in backend
  work_plan         jsonb not null default '[]'::jsonb,
  estimate_items    jsonb not null default '[]'::jsonb,
  invoice_data      jsonb not null default '{}'::jsonb,
  invoice_number    text,
  invoice_total     numeric(12,2) not null default 0,    -- kept in sync by the backend from invoice_data
  archived          boolean not null default false,
  created_at        timestamptz not null default now()
);

alter table projects add column if not exists scope_description text;
alter table projects add column if not exists estimated_amount  numeric(12,2) not null default 0;
alter table projects add column if not exists actual_amount     numeric(12,2) not null default 0;
alter table projects add column if not exists payment_status    text not null default 'paid';
alter table projects add column if not exists work_plan         jsonb not null default '[]'::jsonb;
alter table projects add column if not exists estimate_items    jsonb not null default '[]'::jsonb;
alter table projects add column if not exists invoice_data      jsonb not null default '{}'::jsonb;
alter table projects add column if not exists invoice_number    text;
alter table projects add column if not exists invoice_total     numeric(12,2) not null default 0;
alter table projects add column if not exists archived          boolean not null default false;

update projects set estimated_amount = 0 where estimated_amount is null;
update projects set actual_amount    = 0 where actual_amount is null;
alter table projects alter column estimated_amount type numeric(12,2) using round(estimated_amount::numeric, 2);
alter table projects alter column actual_amount    type numeric(12,2) using round(actual_amount::numeric, 2);

create unique index if not exists projects_invoice_number_key
  on projects (invoice_number) where invoice_number is not null;
create index if not exists projects_client_idx on projects (client_id);

-- ───────────── transactions (receipts / expenses / income) ─────────────
create table if not exists transactions (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid references clients(id) on delete cascade,
  project_id     uuid references projects(id) on delete cascade,
  vendor         text,
  date_purchased date,
  category       text,
  amount         numeric(12,2) not null default 0,
  description    text,
  items          jsonb not null default '[]'::jsonb,
  kind           text not null default 'expense',
  created_at     timestamptz not null default now()
);

alter table transactions add column if not exists kind text not null default 'expense';
update transactions set amount = 0 where amount is null;
alter table transactions alter column amount type numeric(12,2) using round(amount::numeric, 2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_kind_check') then
    alter table transactions
      add constraint transactions_kind_check check (kind in ('expense','income'));
  end if;
end $$;

-- rows the AI previously saved with category 'income'
update transactions set kind = 'income' where lower(category) = 'income' and kind = 'expense';

create index if not exists transactions_project_idx on transactions (project_id);

-- ───────────── chat_messages ─────────────
create table if not exists chat_messages (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  role       text not null,
  content    text not null,
  raw_json   text,                      -- backend stores json.dumps(...) as a string
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_project_idx on chat_messages (project_id, created_at);

-- ───────────── payments (source of truth for "paid") ─────────────
create table if not exists payments (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  amount     numeric(12,2) not null check (amount > 0),
  method     text,
  paid_at    timestamptz not null default now(),
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists payments_project_idx on payments (project_id);

-- ───────────── pending_changes (used by the AI confirm flow, a later step) ─────────────
create table if not exists pending_changes (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  changes    jsonb not null,
  status     text not null default 'pending',
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pending_changes_status_check') then
    alter table pending_changes
      add constraint pending_changes_status_check
      check (status in ('pending','applied','rejected'));
  end if;
end $$;
create index if not exists pending_changes_project_idx on pending_changes (project_id, status);

-- ───────────── one-time migration: legacy actual_amount -> payments ─────────────
-- Copies each project's old "Actual Paid" into a single payment, then zeroes the
-- legacy column so re-running this script never duplicates it.
do $$
begin
  insert into payments (project_id, amount, method, paid_at, note)
  select p.id, p.actual_amount, 'migrated', p.created_at, 'Migrated from projects.actual_amount'
  from projects p
  where p.actual_amount > 0
    and not exists (select 1 from payments x where x.project_id = p.id);

  update projects
     set actual_amount = 0
   where actual_amount > 0
     and exists (select 1 from payments x where x.project_id = projects.id and x.method = 'migrated');
end $$;

-- ───────────── sequential invoice numbers (INV-0001, INV-0002, ...) ─────────────
create sequence if not exists invoice_number_seq;

-- Idempotent: returns the project's existing number, or assigns the next one.
create or replace function assign_invoice_number(p_project_id uuid) returns text
language plpgsql as $$
declare
  v text;
begin
  select invoice_number into v from projects where id = p_project_id for update;
  if not found then
    raise exception 'project % not found', p_project_id;
  end if;
  if v is null then
    v := 'INV-' || lpad(nextval('invoice_number_seq')::text, 4, '0');
    update projects set invoice_number = v where id = p_project_id;
  end if;
  return v;
end $$;

-- ───────────── one-time backfill of projects.invoice_total from invoice_data ─────────────
do $$
begin
  update projects p set invoice_total = coalesce((
    select round(sum(
      (case when coalesce((it->>'qty')::numeric, 0) = 0 then 1 else (it->>'qty')::numeric end)
      * coalesce((it->>'price')::numeric, 0)
    ), 2)
    from jsonb_array_elements(
      case when jsonb_typeof(p.invoice_data->'items') = 'array' then p.invoice_data->'items' else '[]'::jsonb end
    ) it
  ), 0);
exception when others then
  raise notice 'invoice_total backfill skipped: %', sqlerrm;
end $$;

-- make Supabase's API pick up the new column and function immediately
notify pgrst, 'reload schema';
