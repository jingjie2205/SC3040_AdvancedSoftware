-- Training routine, ninth step: a day may hold more than one planned session.
--
-- The first migration (20260930000000_training_routine.sql) made (user_id, date) unique on planned_sessions, so a day
-- could hold one planned session. The app now allows several (a push gym and a light run on the same day, a session the
-- AI chat adds to a busy day), and the live project already has no such constraint (it was dropped by hand and is in no
-- migration). This drops it from the repo's own history so a fresh install matches, and so the write function can't fail
-- with a unique violation where the app expects a session to be accepted.
--
-- Safe to run again. Changes no row, and keeps the plain (user_id, date) index the schedule reads use.

alter table public.planned_sessions
    drop constraint if exists planned_sessions_user_id_date_key;
