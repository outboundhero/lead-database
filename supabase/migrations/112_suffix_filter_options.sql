-- 112: option lists for the "Email Ends With" / "Domain Ends With" dropdowns.
--
-- Client request 2026-09-19: the two suffix chips should be searchable
-- dropdowns of the endings that actually exist (with lead counts), while still
-- accepting anything typed. The lists live in filter_options_cache like every
-- other dropdown (distinct_values / filter_option_counts are generic by key):
--   email_suffix   TLDs ('.com', '.org', '.in' …), the common two-level endings
--                  ('.co.uk', '.com.au' …) and a fixed list of mailbox
--                  providers as '@gmail.com', '@yahoo.com' …
--   domain_suffix  TLDs and two-level endings of the company domain's HOST
-- Endings with fewer than 25 leads are left out of the list (still typeable).
-- Options are ordered by lead count, largest first. Counts cover all leads, as
-- the State/City counts do. The domain host expression is EXACTLY the one
-- fn_lead_filter_conditions uses (111), so a count shown in the dropdown is
-- what an include of that ending matches before the visibility gates.
--
-- PERFORMANCE (measured 2026-09-19): the work is regexes over ~9M rows. As an
-- INSERT … SELECT it ran SERIALLY — 221 s (an INSERT's SELECT cannot use
-- parallel workers). Materialising the aggregate with CREATE TEMP TABLE AS gets
-- a Parallel Seq Scan with 2 workers — 63 s. Hence the temp table. One scan
-- feeds both lists.
--
-- Its own function, called by scripts/refresh-filter-cache.mjs in its OWN
-- transaction with its own age gate, after the main cache refresh — so a slow
-- or failed scan can neither roll back the main cache nor make it look stale,
-- and the 178-line fn_refresh_filter_cache is not rebuilt for this.

CREATE OR REPLACE FUNCTION public.fn_refresh_suffix_options()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  DROP TABLE IF EXISTS _suffix_counts;
  CREATE TEMP TABLE _suffix_counts ON COMMIT DROP AS
  SELECT x.target, x.s, count(*) AS n
    FROM leads l,
         LATERAL (SELECT lower(l.email) AS em,
                         rtrim(regexp_replace(regexp_replace(lower(btrim(COALESCE(NULLIF(btrim(l.domain), ''), split_part(l.email, '@', 2)))), '^[a-z][a-z0-9+.-]*://', ''), '[/?#:[:space:]].*$', ''), '.') AS host) b,
         LATERAL (VALUES
           ('email_suffix',  substring(b.em from '\.[a-z0-9-]+$')),
           ('email_suffix',  substring(b.em from '\.(?:co|com|org|net|gov|ac|edu)\.[a-z]{2}$')),
           ('email_suffix',  CASE WHEN split_part(b.em, '@', 2) = ANY (ARRAY[
                               'gmail.com','yahoo.com','aol.com','hotmail.com','outlook.com','msn.com','live.com',
                               'icloud.com','me.com','mac.com','comcast.net','bellsouth.net','att.net','sbcglobal.net',
                               'verizon.net','cox.net','charter.net','earthlink.net','ymail.com','rocketmail.com',
                               'protonmail.com','proton.me','mail.com','gmx.com','zoho.com','yandex.com','qq.com'])
                                  THEN '@' || split_part(b.em, '@', 2) END),
           ('domain_suffix', substring(b.host from '\.[a-z0-9-]+$')),
           ('domain_suffix', substring(b.host from '\.(?:co|com|org|net|gov|ac|edu)\.[a-z]{2}$'))
         ) AS x(target, s)
   WHERE x.s IS NOT NULL
   GROUP BY x.target, x.s
  HAVING count(*) >= 25;

  INSERT INTO filter_options_cache (col_name, options, option_counts, updated_at)
  SELECT target, array_agg(s ORDER BY n DESC, s), jsonb_object_agg(s, n), now()
    FROM _suffix_counts
   GROUP BY target
  ON CONFLICT (col_name)
  DO UPDATE SET options = EXCLUDED.options, option_counts = EXCLUDED.option_counts, updated_at = EXCLUDED.updated_at;

  DROP TABLE _suffix_counts;
END;
$function$;

-- Seed once so the dropdowns are populated before the next daily refresh.
BEGIN;
SET LOCAL statement_timeout = '600s';
SELECT fn_refresh_suffix_options();
COMMIT;

NOTIFY pgrst, 'reload schema';
