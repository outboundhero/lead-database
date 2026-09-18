-- 109: fn_merge_tags — union of two comma-separated tag lists.
--
-- leads.tags mirrors Email Bison's tag list ('Outlook,JPC'): the ESP tag Bison
-- adds itself plus the custom client tags attached on push. A CSV upload can now
-- stamp a client tag on every row (client decision 2026-09-18: the file name
-- says who the list was sourced for — JPDET, CCGHTX, …). For an existing lead
-- that means ADDING the tag, never replacing what Bison wrote, so the import
-- uses this instead of the fill-blanks / overwrite rules:
--   fn_merge_tags('Outlook,JPC', 'JPDET')  -> 'Outlook,JPC,JPDET'
--   fn_merge_tags('Outlook,JPDET', 'jpdet') -> 'Outlook,JPDET'   (case-insensitive, first spelling kept)
--   fn_merge_tags(NULL, ' JPDET ')          -> 'JPDET'
--   fn_merge_tags('Google', NULL)           -> 'Google'
-- Order is preserved (existing first), blanks dropped, NULL when nothing remains.

CREATE OR REPLACE FUNCTION public.fn_merge_tags(a text, b text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT NULLIF(string_agg(t, ',' ORDER BY ord), '')
    FROM (
      SELECT min(u.ord) AS ord, (array_agg(btrim(u.t0) ORDER BY u.ord))[1] AS t
        FROM unnest(string_to_array(coalesce(a, '') || ',' || coalesce(b, ''), ',')) WITH ORDINALITY AS u(t0, ord)
       WHERE btrim(u.t0) <> ''
       GROUP BY lower(btrim(u.t0))
    ) s;
$function$;
