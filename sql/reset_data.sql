-- =====================================================================================================
-- reset_data.sql - DELETES ALL clients, projects, tasks (visits), estimates/invoices and receipts.
-- Keeps: your company profile (Settings), your login and the team.
-- There is NO undo. Run it in Supabase > SQL Editor.
--
-- Photo FILES are not removed by SQL (Supabase protects Storage): open Supabase > Storage > crm-photos,
-- select all folders and delete them.
-- =====================================================================================================

begin;

delete from receipts;   -- point to invoices / tasks, so they go first
delete from invoices;   -- estimates and invoices
delete from visits;     -- tasks
delete from projects;
delete from clients;

-- Optional: also remove the test team members created by seed_test_data.sql (they have no login).
-- Remove the two dashes to run it:
-- delete from team_members where user_id is null;

commit;

-- check: all five numbers should be 0
select (select count(*) from clients)  as clients,
       (select count(*) from projects) as projects,
       (select count(*) from visits)   as tasks,
       (select count(*) from invoices) as documents,
       (select count(*) from receipts) as receipts;
