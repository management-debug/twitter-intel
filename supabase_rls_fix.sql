-- Security fix for TwitterIntel Supabase project (ttdsvkpqobfutsahblos)
-- Enables Row-Level Security on all public tables.
-- With RLS on and no policies, anon-key requests are denied on all rows.
-- The server uses the service_role key which bypasses RLS, so the app keeps
-- working untouched.

ALTER TABLE public.accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scrape_jobs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlist    ENABLE ROW LEVEL SECURITY;

-- Verify: every row should show rowsecurity = true
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
