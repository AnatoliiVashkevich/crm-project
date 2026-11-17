-- =====================================================================================================
-- seed_test_data.sql - fills the CRM with FICTIONAL test data (no real people):
--   4 team members · 20 clients · 50 projects · ~125 tasks · ~33 receipts · 10 estimates · ~12 invoices
-- Names are invented, emails end in @example.com, phones are 555 numbers, addresses are made up.
-- Dates are spread around TODAY (past = completed work, future = scheduled), so the app looks alive.
--
-- Run AFTER schema.sql (needs the team_members table). Run in Supabase > SQL Editor.
-- Running it twice adds a second set of clients/projects (team members are not duplicated).
--
-- The 4 test team members have NO login (they are only names for assigning tasks). To test the
-- Employee view, add a real person in the app: + New > Team member, with a second email of yours.
-- =====================================================================================================

do $$
declare
  first_names text[] := array['Avery','Blake','Casey','Dana','Elliot','Finley','Gray','Harper','Indigo','Jordan',
                              'Kendall','Logan','Morgan','Noel','Oakley','Parker','Quinn','Reese','Sawyer','Taylor'];
  last_names  text[] := array['Brookfield','Castellano','Delacroix','Ellsworth','Fairbanks','Galloway','Hartwell','Iverson',
                              'Jennings','Kowalczyk','Lindqvist','Montague','Northcott','Okonkwo','Pemberton','Quintero',
                              'Rosewood','Sterling','Thornbury','Vanderhoff'];
  companies   text[] := array['Brookfield Rentals LLC','Galloway Dental Group','Lindqvist Property Mgmt','Pemberton Cafe','Vanderhoff Realty'];
  streets     text[] := array['Palm Grove Dr','Seabreeze Ln','Coral Ridge Ave','Mangrove Way','Pelican Ct',
                              'Harbor View Rd','Sunset Ter','Magnolia Blvd','Cypress Bend','Banyan Cir'];
  cities      text[] := array['Boca Raton','Delray Beach','Boynton Beach','Deerfield Beach','Lake Worth','Coral Springs'];
  zips        text[] := array['33432','33444','33435','33441','33460','33065'];
  client_notes text[] := array['Call before arriving.','Prefers text messages.','Has a friendly dog - keep the gate closed.',
                               'Pays by Zelle.','Parking in the driveway is OK.'];

  -- 25 kinds of jobs, each with a description
  jobs text[] := array[
    'Kitchen Faucet & Sink','Bathroom Tile Repair','Interior Door Replacement','Ceiling Fan Installation','Drywall Patch & Paint',
    'Water Heater Flush','Garbage Disposal Swap','Fence Gate Repair','Exterior Trim Painting','Closet Shelving',
    'Toilet Rebuild','Shower Caulking','Baseboard Installation','Light Fixture Upgrade','Smoke Detector Replacement',
    'Cabinet Hinge Repair','Window Screen Repair','Deck Board Replacement','Pressure Washing','TV Wall Mount',
    'Grab Bar Installation','Outlet & Switch Replacement','Gutter Cleaning','Laminate Floor Repair','Hurricane Shutter Check'];
  job_desc text[] := array[
    'Replace the leaking kitchen faucet and reseal the sink basin.','Replace cracked floor tiles near the tub and regrout.',
    'Remove two hollow interior doors and hang new solid-core doors with hardware.','Install a new ceiling fan with light kit in the living room.',
    'Patch three drywall holes, texture to match and paint the wall.','Flush the tank, check the anode rod and pressure relief valve.',
    'Remove the old disposal and install a 3/4 HP unit.','Re-hang the sagging side gate and replace the latch.',
    'Scrape, prime and paint the front fascia and window trim.','Install adjustable wire shelving in the master closet.',
    'Replace fill valve, flapper and wax ring on the guest toilet.','Remove old caulk and re-caulk the shower and tub surround.',
    'Install new MDF baseboards in two bedrooms and paint.','Replace three dated fixtures with LED fixtures.',
    'Replace all smoke detectors and test the system.','Adjust and replace worn cabinet hinges in the kitchen.',
    'Re-screen four windows and the patio door.','Replace rotten deck boards and seal the deck.',
    'Pressure wash the driveway, walkway and pool deck.','Mount a 65" TV on drywall and hide the cables.',
    'Install two grab bars in the bathroom into studs.','Replace yellowed outlets and switches with white decora style.',
    'Clean gutters and downspouts, check for leaks.','Replace water-damaged laminate planks in the hallway.',
    'Inspect hurricane shutters, lubricate tracks and replace missing hardware.'];
  stores    text[] := array['Home Depot','Lowe''s','Ace Hardware','Floor & Decor','Ferguson Supply'];
  times     text[] := array['08:00 AM','09:30 AM','11:00 AM','01:00 PM','03:00 PM'];
  prios     text[] := array['High','Medium','Low'];

  team uuid[];
  client_ids uuid[] := '{}';
  c record;
  p_id uuid; c_id uuid; v_id uuid; first_v uuid;
  rate numeric;
  i int; j int; k int; n_tasks int;
  title text; v_date date; v_status text; planned numeric; spent numeric;
  est_n int; inv_n int;
  lines jsonb; v_ids uuid[]; total numeric; hours numeric;
begin
  select coalesce(nullif(default_hourly_rate, 0), 85) into rate from profile where id = 1;
  rate := coalesce(rate, 85);

  -- ---------- team (names only, no login) ----------
  insert into team_members (name, email, phone, specialty, role)
  select v.* from (values
    ('Riley Demo-Manager', 'riley.manager@example.com', '(561) 555-0101', 'Scheduling & estimates', 'Manager'),
    ('Sam Demo-Tech',      'sam.tech@example.com',      '(561) 555-0102', 'Plumbing',               'Employee'),
    ('Jesse Demo-Tech',    'jesse.tech@example.com',    '(561) 555-0103', 'Carpentry & doors',      'Employee'),
    ('Alex Demo-Tech',     'alex.tech@example.com',     '(561) 555-0104', 'Electrical & painting',  'Employee')
  ) as v(name, email, phone, specialty, role)
  where not exists (select 1 from team_members t where t.email = v.email);
  select array_agg(id order by email) into team from team_members where email like '%@example.com';

  -- ---------- 20 clients ----------
  for i in 1..20 loop
    insert into clients (name, phone, email, street, city, state, zip, notes)
    values (
      first_names[i] || ' ' || last_names[i],
      '(561) 555-' || lpad((200 + i)::text, 4, '0'),
      lower(first_names[i] || '.' || last_names[i]) || '@example.com',
      (100 + i * 37) || ' ' || streets[1 + i % 10],
      cities[1 + i % 6], 'FL', zips[1 + i % 6],
      client_notes[1 + i % 5]
        || case when i % 4 = 0   -- every 4th client is a company (kept in the hidden extras)
                then E'\n<!--HCRM:' || jsonb_build_object('company_name', companies[i / 4],
                       'first_name', first_names[i], 'last_name', last_names[i])::text || '-->'
                else '' end)
    returning id into c_id;
    client_ids := client_ids || c_id;
  end loop;

  select coalesce(max(nullif(regexp_replace(invoice_number, '\D', '', 'g'), '')::int), 0) into est_n
    from invoices where kind = 'estimate';
  select coalesce(max(nullif(regexp_replace(invoice_number, '\D', '', 'g'), '')::int), 0) into inv_n
    from invoices where kind = 'invoice';

  -- ---------- 50 projects, each with 2-3 tasks ----------
  for j in 1..50 loop
    c_id := client_ids[1 + (j - 1) % 20];
    select * into c from clients where id = c_id;

    insert into projects (client_id, name, street, city, state, zip, estimate_description)
    values (
      c_id,
      jobs[1 + (j - 1) % 25],
      case when j % 2 = 0 then c.street else (200 + j * 23) || ' ' || streets[1 + (j + 3) % 10] end,   -- half at another address
      case when j % 2 = 0 then c.city   else cities[1 + (j + 2) % 6] end,
      'FL',
      case when j % 2 = 0 then c.zip    else zips[1 + (j + 2) % 6] end,
      job_desc[1 + (j - 1) % 25] || E'\n<!--HCRM:' ||
        jsonb_build_object('project_status', case when j % 7 = 0 then 'Completed' else 'Active' end)::text || '-->')
    returning id into p_id;

    n_tasks := 2 + j % 2;
    first_v := null;
    for k in 1..n_tasks loop
      title := case k when 1 then 'Inspect & measure'
                      when 2 then 'Do the work: ' || jobs[1 + (j - 1) % 25]
                      else 'Final walkthrough with client' end;
      v_date := current_date + ((j * 3 + k * 4) % 50 - 30);   -- from 30 days ago to 19 days ahead
      planned := 1 + (j + k) % 4;
      v_status := case when (j + k) % 13 = 0 then 'Canceled'
                       when v_date < current_date - 1 then 'Completed'
                       when v_date <= current_date then 'In Progress'
                       else 'Scheduled' end;
      spent := case v_status when 'Completed' then planned + ((j + k) % 3 - 1) * 0.5
                             when 'In Progress' then planned / 2 else 0 end;

      insert into visits (project_id, visit_date, status, time_spent, assigned_to, planned_work)
      values (p_id, v_date, v_status, spent, team[1 + (j + k) % array_length(team, 1)],
        title || E'\n' || job_desc[1 + (j - 1) % 25] || E'\n<!--HCRM:' || jsonb_build_object(
          'title', title, 'description', job_desc[1 + (j - 1) % 25], 'priority', prios[1 + (j + k) % 3],
          'planned_hours', planned, 'scheduled_time', times[1 + (j + k) % 5])::text || '-->')
      returning id into v_id;
      first_v := coalesce(first_v, v_id);
    end loop;

    -- receipt for 2 of every 3 projects (some billable to the client, some internal)
    if j % 3 <> 0 then
      insert into receipts (project_id, visit_id, amount, store, category, receipt_date, billable, created_by)
      values (p_id, first_v, 25 + (j * 17) % 300 + 0.49, stores[1 + j % 5], 'Construction',
              current_date - (j % 30), j % 4 <> 0, team[1 + j % array_length(team, 1)]);
    end if;

    -- estimate for every 5th project: one line per open task (planned hours x rate)
    if j % 5 = 1 then
      select jsonb_agg(jsonb_build_object('description', split_part(planned_work, E'\n', 1), 'qty', 1 + j % 4,
                                          'rate', rate, 'amount', round((1 + j % 4) * rate, 2), 'type', 'labor')),
             sum(round((1 + j % 4) * rate, 2))
        into lines, total
        from visits where project_id = p_id and status <> 'Canceled';
      if lines is not null then
        est_n := est_n + 1;
        insert into invoices (kind, project_id, client_id, invoice_number, invoice_date, status, description,
                              line_items, labor_amount, total, hours, hourly_rate)
        values ('estimate', p_id, c_id, 'EST-' || lpad(est_n::text, 4, '0'), current_date - 35, 'Unpaid', '',
                lines, total, total, 0, rate);
      end if;
    end if;

    -- invoice for every 4th project: its completed tasks (actual hours x rate); half are paid
    if j % 4 = 0 then
      select jsonb_agg(jsonb_build_object('description', split_part(planned_work, E'\n', 1), 'qty', time_spent,
                                          'rate', rate, 'amount', round(time_spent * rate, 2), 'type', 'labor')),
             array_agg(id), sum(round(time_spent * rate, 2)), sum(time_spent)
        into lines, v_ids, total, hours
        from visits where project_id = p_id and status = 'Completed';
      if lines is not null then
        inv_n := inv_n + 1;
        insert into invoices (kind, project_id, client_id, visit_id, visit_ids, invoice_number, invoice_date,
                              status, paid_date, description, line_items, labor_amount, total, hours, hourly_rate)
        values ('invoice', p_id, c_id, v_ids[1], v_ids, 'INV-' || lpad(inv_n::text, 4, '0'), current_date - (j % 20),
                case when j % 8 = 0 then 'Paid' else 'Unpaid' end,
                case when j % 8 = 0 then least(current_date - (j % 20) + 3, current_date) end,   -- never in the future
                '', lines, total, total, hours, rate);
      end if;
    end if;
  end loop;
end $$;

-- what was created
select (select count(*) from team_members) as team,
       (select count(*) from clients)  as clients,
       (select count(*) from projects) as projects,
       (select count(*) from visits)   as tasks,
       (select count(*) from receipts) as receipts,
       (select count(*) from invoices where kind = 'estimate') as estimates,
       (select count(*) from invoices where kind = 'invoice')  as invoices;
