-- 062: per-side match modes (Contains/Exact) for filter fields + the
-- "Commercial cleaning client" toggle.
--
-- JSON contract additions (all optional, backward compatible):
--   <field>.includeMode / <field>.excludeMode : 'exact' | 'contains'
--     defaults preserve old behavior: category/subcategory/additionalCategory/
--     company/state/jobTitle = exact; city/tags/customTags/website/keyword/
--     categorySearch/emailContains = contains (keyword+categorySearch still
--     honor legacy matchMode as fallback).
--   commercialCleaning : boolean -> excludes leads whose title matches any
--     term in commercial_cleaning_excluded_titles (whole-word, plural-
--     tolerant; leads without a title are kept).

-- Escapes regex metacharacters in a user-supplied term.
CREATE OR REPLACE FUNCTION public.fn_regex_escape(p_term text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $fn$
BEGIN
  RETURN regexp_replace(TRIM(p_term), '([.+*?^$()[\]{}|\\])', '\\\1', 'g');
END;
$fn$;

-- Whole-term regex: word-boundaried on BOTH sides (unlike fn_exact_term_regex,
-- whose single-word form is word-start anchored — "it" must not match
-- "Italian" here). Plural-tolerant; internal whitespace flexible.
CREATE OR REPLACE FUNCTION public.fn_whole_term_regex(p_term text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $fn$
DECLARE
  esc text;
BEGIN
  esc := fn_regex_escape(p_term);
  esc := regexp_replace(esc, '\s+', '\\s+', 'g');
  RETURN '\m' || esc || 's?\M';
END;
$fn$;

-- One column vs a value list under a match mode, optionally negated.
-- exact    -> case-insensitive equality (ANY / NULL-tolerant <> ALL)
-- contains -> ILIKE %v% OR-chain / NULL-tolerant NOT ILIKE AND-chain
CREATE OR REPLACE FUNCTION public.fn_sided_match(p_col text, p_vals text[], p_mode text, p_negate boolean)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $fn$
DECLARE
  parts text[] := '{}';
  v text;
BEGIN
  IF p_vals IS NULL OR array_length(p_vals, 1) IS NULL THEN RETURN 'true'; END IF;
  IF p_mode = 'contains' THEN
    IF p_negate THEN
      FOREACH v IN ARRAY p_vals LOOP
        parts := array_append(parts, format('%s NOT ILIKE %L', p_col, '%' || v || '%'));
      END LOOP;
      RETURN format('(%s IS NULL OR (%s))', p_col, array_to_string(parts, ' AND '));
    ELSE
      FOREACH v IN ARRAY p_vals LOOP
        parts := array_append(parts, format('%s ILIKE %L', p_col, '%' || v || '%'));
      END LOOP;
      RETURN '(' || array_to_string(parts, ' OR ') || ')';
    END IF;
  ELSE
    IF p_negate THEN
      RETURN format('(%s IS NULL OR LOWER(%s) <> ALL(%L::text[]))', p_col, p_col,
        (SELECT array_agg(LOWER(x)) FROM unnest(p_vals) x));
    ELSE
      RETURN format('LOWER(%s) = ANY(%L::text[])', p_col,
        (SELECT array_agg(LOWER(x)) FROM unnest(p_vals) x));
    END IF;
  END IF;
END;
$fn$;

-- Default job-title exclusions for the Commercial Cleaning Client toggle.
-- Editable at runtime (add/remove rows) — no deploy needed.
CREATE TABLE IF NOT EXISTS commercial_cleaning_excluded_titles (
  term text PRIMARY KEY
);
ALTER TABLE commercial_cleaning_excluded_titles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read cc titles" ON commercial_cleaning_excluded_titles;
CREATE POLICY "Anyone can read cc titles" ON commercial_cleaning_excluded_titles FOR SELECT USING (true);

INSERT INTO commercial_cleaning_excluded_titles (term) VALUES
  ('junior'),
  ('intern'),
  ('internship'),
  ('student'),
  ('trainee'),
  ('apprentice'),
  ('retired'),
  ('engineer'),
  ('engineering'),
  ('developer'),
  ('software developer'),
  ('application developer'),
  ('systems developer'),
  ('information technology'),
  ('information systems'),
  ('it'),
  ('its'),
  ('it specialist'),
  ('it support'),
  ('it technician'),
  ('network'),
  ('network administrator'),
  ('network engineer'),
  ('systems'),
  ('systems administrator'),
  ('systems engineer'),
  ('database'),
  ('database administrator'),
  ('database engineer'),
  ('server'),
  ('server administrator'),
  ('erp'),
  ('erp administrator'),
  ('hris'),
  ('hris administrator'),
  ('information specialist'),
  ('information'),
  ('technical support'),
  ('technical'),
  ('cybersecurity'),
  ('cyber security'),
  ('software'),
  ('technology'),
  ('data'),
  ('data analyst'),
  ('data scientist'),
  ('business intelligence'),
  ('product'),
  ('product manager'),
  ('product specialist'),
  ('product developer'),
  ('product engineer'),
  ('attorney'),
  ('lawyer'),
  ('law'),
  ('law firm'),
  ('legal counsel'),
  ('general counsel'),
  ('paralegal'),
  ('legal assistant'),
  ('law clerk'),
  ('ethics'),
  ('ethics officer'),
  ('complaints'),
  ('complaints specialist'),
  ('council'),
  ('academic counselor'),
  ('counselor'),
  ('actuary'),
  ('actuarial analyst'),
  ('realtor'),
  ('real estate agent'),
  ('leasing agent'),
  ('representative'),
  ('rep'),
  ('sales'),
  ('sales representative'),
  ('sales rep'),
  ('account executive'),
  ('account representative'),
  ('account manager'),
  ('service consultant'),
  ('business development representative'),
  ('sales development representative'),
  ('customer service'),
  ('customer service representative'),
  ('customer support'),
  ('support'),
  ('support specialist'),
  ('call center'),
  ('virtual'),
  ('virtual assistant'),
  ('trainer'),
  ('training specialist'),
  ('recruiter'),
  ('recruitment'),
  ('talent'),
  ('talent acquisition'),
  ('staffing'),
  ('staffing specialist'),
  ('human resources recruiter'),
  ('benefits'),
  ('benefits specialist'),
  ('compensation'),
  ('compensation specialist'),
  ('payroll specialist'),
  ('accounts payable'),
  ('accounts receivable'),
  ('accountant'),
  ('accounting'),
  ('accounting specialist'),
  ('accounting clerk'),
  ('controller'),
  ('billing'),
  ('billing specialist'),
  ('analyst'),
  ('financial analyst'),
  ('inventory'),
  ('inventory specialist'),
  ('inventory clerk'),
  ('supply chain'),
  ('supply chain analyst'),
  ('logistics'),
  ('logistics coordinator'),
  ('logistics specialist'),
  ('dispatcher'),
  ('driver'),
  ('delivery driver'),
  ('fueler'),
  ('aircraft'),
  ('aircraft fueler'),
  ('mechanic'),
  ('automotive technician'),
  ('technician'),
  ('service technician'),
  ('field technician'),
  ('maintenance technician'),
  ('repair technician'),
  ('nurse'),
  ('nursing'),
  ('medical assistant'),
  ('photographer'),
  ('photography'),
  ('content'),
  ('content creator'),
  ('content specialist'),
  ('social media'),
  ('social media specialist'),
  ('digital'),
  ('digital marketing'),
  ('marketing coordinator'),
  ('retail'),
  ('retail associate'),
  ('retail sales associate'),
  ('store'),
  ('store associate'),
  ('shop'),
  ('shop assistant'),
  ('research assistant'),
  ('teaching assistant'),
  ('professor'),
  ('instructor'),
  ('educator'),
  ('librarian'),
  ('administrative assistant'),
  ('executive assistant'),
  ('personal assistant'),
  ('data entry clerk'),
  ('records clerk'),
  ('file clerk'),
  ('claims representative'),
  ('claims adjuster'),
  ('insurance agent'),
  ('insurance producer'),
  ('underwriter'),
  ('loan officer'),
  ('mortgage broker'),
  ('teller'),
  ('banker'),
  ('procurement analyst'),
  ('purchasing assistant'),
  ('buyer assistant'),
  ('warehouse associate'),
  ('warehouse worker'),
  ('material handler'),
  ('forklift operator'),
  ('shipping clerk'),
  ('receiving clerk'),
  ('production worker'),
  ('machine operator'),
  ('assembler'),
  ('quality assurance analyst'),
  ('quality control technician'),
  ('laboratory technician'),
  ('lab technician'),
  ('lab assistant'),
  ('chemist'),
  ('scientist'),
  ('programmer'),
  ('web developer'),
  ('graphic designer'),
  ('videographer'),
  ('copywriter'),
  ('journalist'),
  ('editor'),
  ('public relations specialist'),
  ('communications specialist'),
  ('brand ambassador'),
  ('merchandiser'),
  ('cashier'),
  ('bartender'),
  ('cook'),
  ('chef'),
  ('host'),
  ('hostess'),
  ('food runner'),
  ('dishwasher'),
  ('janitor'),
  ('custodian'),
  ('cleaner'),
  ('housekeeper'),
  ('porter'),
  ('groundskeeper'),
  ('security'),
  ('security guard'),
  ('police officer'),
  ('firefighter'),
  ('military'),
  ('volunteer'),
  ('application')
ON CONFLICT (term) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_lead_filter_conditions(p_filters jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  conditions TEXT[] := '{}';
  v TEXT;
  vals TEXT[];
BEGIN
  DECLARE su BOOLEAN := COALESCE((p_filters->'jobTitle'->>'selectUnknown')::boolean, false);
          m_jt TEXT := COALESCE(p_filters->'jobTitle'->>'includeMode', 'exact');
          jt_cond TEXT; BEGIN
    IF p_filters ? 'jobTitle' AND jsonb_array_length(COALESCE(p_filters->'jobTitle'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'jobTitle'->'include') x;
      IF m_jt = 'contains' THEN
        jt_cond := format('l.id IN (SELECT lead_id FROM lead_job_titles WHERE title ILIKE ANY(%L::text[]))', (SELECT array_agg('%' || u || '%') FROM unnest(vals) u));
      ELSE
        jt_cond := format('l.id IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[]))', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u));
      END IF;
      IF su THEN
        conditions := array_append(conditions, '(' || jt_cond || ' OR l.title IS NULL OR TRIM(l.title) = '''')');
      ELSE
        conditions := array_append(conditions, jt_cond);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.title IS NULL OR TRIM(l.title) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'generalIndustry'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'generalIndustry' AND jsonb_array_length(COALESCE(p_filters->'generalIndustry'->'include', '[]'::jsonb)) > 0 THEN
      DECLARE gi TEXT[] := '{}'; BEGIN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'generalIndustry'->'include') LOOP
          gi := array_append(gi, format('LOWER(l.general_industry) = LOWER(%L)', v));
        END LOOP;
        IF su THEN
          conditions := array_append(conditions, '(' || array_to_string(gi, ' OR ') || ' OR l.general_industry IS NULL OR TRIM(l.general_industry) = '''')');
        ELSE
          conditions := array_append(conditions, '(' || array_to_string(gi, ' OR ') || ')');
        END IF;
      END;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.general_industry IS NULL OR TRIM(l.general_industry) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'specificIndustry'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'specificIndustry' AND jsonb_array_length(COALESCE(p_filters->'specificIndustry'->'include', '[]'::jsonb)) > 0 THEN
      DECLARE si TEXT[] := '{}'; BEGIN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'specificIndustry'->'include') LOOP
          si := array_append(si, format('LOWER(l.specific_industry) = LOWER(%L)', v));
        END LOOP;
        IF su THEN
          conditions := array_append(conditions, '(' || array_to_string(si, ' OR ') || ' OR l.specific_industry IS NULL OR TRIM(l.specific_industry) = '''')');
        ELSE
          conditions := array_append(conditions, '(' || array_to_string(si, ' OR ') || ')');
        END IF;
      END;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.specific_industry IS NULL OR TRIM(l.specific_industry) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'source'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'source' AND jsonb_array_length(COALESCE(p_filters->'source'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'source'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.source = ANY(%L::text[]) OR l.source IS NULL OR TRIM(l.source) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.source = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.source IS NULL OR TRIM(l.source) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'company'->>'selectUnknown')::boolean, false);
          m_company TEXT := COALESCE(p_filters->'company'->>'includeMode', 'exact');
          mc_company TEXT; BEGIN
    IF p_filters ? 'company' AND jsonb_array_length(COALESCE(p_filters->'company'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'company'->'include') x;
      mc_company := fn_sided_match('l.company', vals, m_company, false);
      IF su THEN
        conditions := array_append(conditions, '(' || mc_company || ' OR l.company IS NULL OR TRIM(l.company) = '''')');
      ELSE
        conditions := array_append(conditions, mc_company);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.company IS NULL OR TRIM(l.company) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'seniority'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'seniority' AND jsonb_array_length(COALESCE(p_filters->'seniority'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'seniority'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.seniority = ANY(%L::text[]) OR l.seniority IS NULL OR TRIM(l.seniority) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.seniority = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.seniority IS NULL OR TRIM(l.seniority) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'esp'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'esp' AND jsonb_array_length(COALESCE(p_filters->'esp'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'esp'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.esp = ANY(%L::text[]) OR l.esp IS NULL OR TRIM(l.esp) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.esp = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.esp IS NULL OR TRIM(l.esp) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'category'->>'selectUnknown')::boolean, false);
          m_category TEXT := COALESCE(p_filters->'category'->>'includeMode', 'exact');
          mc_category TEXT; BEGIN
    IF p_filters ? 'category' AND jsonb_array_length(COALESCE(p_filters->'category'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'category'->'include') x;
      mc_category := fn_sided_match('l.category', vals, m_category, false);
      IF su THEN
        conditions := array_append(conditions, '(' || mc_category || ' OR l.category IS NULL OR TRIM(l.category) = '''')');
      ELSE
        conditions := array_append(conditions, mc_category);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.category IS NULL OR TRIM(l.category) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'subcategory'->>'selectUnknown')::boolean, false);
          m_subcategory TEXT := COALESCE(p_filters->'subcategory'->>'includeMode', 'exact');
          mc_subcategory TEXT; BEGIN
    IF p_filters ? 'subcategory' AND jsonb_array_length(COALESCE(p_filters->'subcategory'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'subcategory'->'include') x;
      mc_subcategory := fn_sided_match('l.subcategory', vals, m_subcategory, false);
      IF su THEN
        conditions := array_append(conditions, '(' || mc_subcategory || ' OR l.subcategory IS NULL OR TRIM(l.subcategory) = '''')');
      ELSE
        conditions := array_append(conditions, mc_subcategory);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.subcategory IS NULL OR TRIM(l.subcategory) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'additionalCategory'->>'selectUnknown')::boolean, false);
          m_additionalCategory TEXT := COALESCE(p_filters->'additionalCategory'->>'includeMode', 'exact');
          mc_additionalCategory TEXT; BEGIN
    IF p_filters ? 'additionalCategory' AND jsonb_array_length(COALESCE(p_filters->'additionalCategory'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'additionalCategory'->'include') x;
      mc_additionalCategory := fn_sided_match('l.additional_category', vals, m_additionalCategory, false);
      IF su THEN
        conditions := array_append(conditions, '(' || mc_additionalCategory || ' OR l.additional_category IS NULL OR TRIM(l.additional_category) = '''')');
      ELSE
        conditions := array_append(conditions, mc_additionalCategory);
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.additional_category IS NULL OR TRIM(l.additional_category) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'location'->'country'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND jsonb_array_length(COALESCE(p_filters->'location'->'country'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'country'->'include') x;
      IF su THEN
        conditions := array_append(conditions, format('(l.country = ANY(%L::text[]) OR l.country IS NULL OR TRIM(l.country) = '''')', vals));
      ELSE
        conditions := array_append(conditions, format('l.country = ANY(%L::text[])', vals));
      END IF;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.country IS NULL OR TRIM(l.country) = '''')');
    END IF;
  END;

  DECLARE su BOOLEAN := COALESCE((p_filters->'location'->'state'->>'selectUnknown')::boolean, false); BEGIN
    IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND jsonb_array_length(COALESCE(p_filters->'location'->'state'->'include', '[]'::jsonb)) > 0 THEN
      SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'state'->'include') x;
      DECLARE mst TEXT := CASE WHEN COALESCE(p_filters->'location'->'state'->>'includeMode', 'exact') = 'exact'
                          THEN fn_state_match(vals, false)
                          ELSE fn_sided_match('l.state', vals, 'contains', false) END; BEGIN
      IF su THEN
        conditions := array_append(conditions, '(' || mst || ' OR l.state IS NULL OR TRIM(l.state) = '''')');
      ELSE
        conditions := array_append(conditions, mst);
      END IF;
      END;
    ELSIF su THEN
      conditions := array_append(conditions, '(l.state IS NULL OR TRIM(l.state) = '''')');
    END IF;
  END;

  -- City: new shape {include[],exclude[]}; legacy plain string still accepted.
  IF p_filters ? 'location' AND p_filters->'location' ? 'city' THEN
    IF jsonb_typeof(p_filters->'location'->'city') = 'string' THEN
      IF (p_filters->'location'->>'city') <> '' THEN
        conditions := array_append(conditions, format('l.city ILIKE %L', '%' || (p_filters->'location'->>'city') || '%'));
      END IF;
    ELSIF jsonb_typeof(p_filters->'location'->'city') = 'object' THEN
      BEGIN
        IF jsonb_array_length(COALESCE(p_filters->'location'->'city'->'include', '[]'::jsonb)) > 0 THEN
          SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'city'->'include') x;
          conditions := array_append(conditions, fn_sided_match('l.city', vals, COALESCE(p_filters->'location'->'city'->>'includeMode', 'contains'), false));
        END IF;
        IF jsonb_array_length(COALESCE(p_filters->'location'->'city'->'exclude', '[]'::jsonb)) > 0 THEN
          SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'city'->'exclude') x;
          conditions := array_append(conditions, fn_sided_match('l.city', vals, COALESCE(p_filters->'location'->'city'->>'excludeMode', 'contains'), true));
        END IF;
      END;
    END IF;
  END IF;

  IF p_filters ? 'companyName' AND (p_filters->>'companyName') <> '' THEN
    conditions := array_append(conditions, format('l.company ILIKE %L', '%' || (p_filters->>'companyName') || '%'));
  END IF;

  IF p_filters ? 'fullName' AND (p_filters->>'fullName') <> '' THEN
    conditions := array_append(conditions, format('(l.first_name ILIKE %L OR l.last_name ILIKE %L)',
      '%' || (p_filters->>'fullName') || '%', '%' || (p_filters->>'fullName') || '%'));
  END IF;

  IF p_filters ? 'jobTitle' AND jsonb_array_length(COALESCE(p_filters->'jobTitle'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'jobTitle'->'exclude') x;
    IF COALESCE(p_filters->'jobTitle'->>'excludeMode', 'exact') = 'contains' THEN
      conditions := array_append(conditions, format('l.id NOT IN (SELECT lead_id FROM lead_job_titles WHERE title ILIKE ANY(%L::text[]))', (SELECT array_agg('%' || u || '%') FROM unnest(vals) u)));
    ELSE
      conditions := array_append(conditions, format('l.id NOT IN (SELECT lead_id FROM lead_job_titles WHERE LOWER(title) = ANY(%L::text[]))', (SELECT array_agg(LOWER(u)) FROM unnest(vals) u)));
    END IF;
  END IF;
  IF p_filters ? 'generalIndustry' AND jsonb_array_length(COALESCE(p_filters->'generalIndustry'->'exclude', '[]'::jsonb)) > 0 THEN
    FOR v IN SELECT jsonb_array_elements_text(p_filters->'generalIndustry'->'exclude') LOOP
      conditions := array_append(conditions, format('(l.general_industry IS NULL OR LOWER(l.general_industry) <> LOWER(%L))', v));
    END LOOP;
  END IF;
  IF p_filters ? 'specificIndustry' AND jsonb_array_length(COALESCE(p_filters->'specificIndustry'->'exclude', '[]'::jsonb)) > 0 THEN
    FOR v IN SELECT jsonb_array_elements_text(p_filters->'specificIndustry'->'exclude') LOOP
      conditions := array_append(conditions, format('(l.specific_industry IS NULL OR LOWER(l.specific_industry) <> LOWER(%L))', v));
    END LOOP;
  END IF;
  IF p_filters ? 'source' AND jsonb_array_length(COALESCE(p_filters->'source'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'source'->'exclude') x;
    conditions := array_append(conditions, format('(l.source IS NULL OR l.source <> ALL(%L::text[]))', vals));
  END IF;

  IF p_filters ? 'company' AND jsonb_array_length(COALESCE(p_filters->'company'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'company'->'exclude') x;
    conditions := array_append(conditions, fn_sided_match('l.company', vals, COALESCE(p_filters->'company'->>'excludeMode', 'exact'), true));
  END IF;
  IF p_filters ? 'seniority' AND jsonb_array_length(COALESCE(p_filters->'seniority'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'seniority'->'exclude') x;
    conditions := array_append(conditions, format('(l.seniority IS NULL OR l.seniority <> ALL(%L::text[]))', vals));
  END IF;
  IF p_filters ? 'esp' AND jsonb_array_length(COALESCE(p_filters->'esp'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'esp'->'exclude') x;
    conditions := array_append(conditions, format('(l.esp IS NULL OR l.esp <> ALL(%L::text[]))', vals));
  END IF;

  IF p_filters ? 'category' AND jsonb_array_length(COALESCE(p_filters->'category'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'category'->'exclude') x;
    conditions := array_append(conditions, fn_sided_match('l.category', vals, COALESCE(p_filters->'category'->>'excludeMode', 'exact'), true));
  END IF;

  IF p_filters ? 'subcategory' AND jsonb_array_length(COALESCE(p_filters->'subcategory'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'subcategory'->'exclude') x;
    conditions := array_append(conditions, fn_sided_match('l.subcategory', vals, COALESCE(p_filters->'subcategory'->>'excludeMode', 'exact'), true));
  END IF;
  IF p_filters ? 'additionalCategory' AND jsonb_array_length(COALESCE(p_filters->'additionalCategory'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'additionalCategory'->'exclude') x;
    conditions := array_append(conditions, fn_sided_match('l.additional_category', vals, COALESCE(p_filters->'additionalCategory'->>'excludeMode', 'exact'), true));
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND jsonb_array_length(COALESCE(p_filters->'location'->'country'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'country'->'exclude') x;
    conditions := array_append(conditions, format('(l.country IS NULL OR l.country <> ALL(%L::text[]))', vals));
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND jsonb_array_length(COALESCE(p_filters->'location'->'state'->'exclude', '[]'::jsonb)) > 0 THEN
    SELECT array_agg(x) INTO vals FROM jsonb_array_elements_text(p_filters->'location'->'state'->'exclude') x;
    IF COALESCE(p_filters->'location'->'state'->>'excludeMode', 'exact') = 'exact' THEN
      conditions := array_append(conditions, fn_state_match(vals, true));
    ELSE
      conditions := array_append(conditions, fn_sided_match('l.state', vals, 'contains', true));
    END IF;
  END IF;

  IF p_filters ? 'jobTitle' AND COALESCE((p_filters->'jobTitle'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.title IS NOT NULL AND TRIM(l.title) <> '''')');
  END IF;
  IF p_filters ? 'generalIndustry' AND COALESCE((p_filters->'generalIndustry'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.general_industry IS NOT NULL AND TRIM(l.general_industry) <> '''')');
  END IF;
  IF p_filters ? 'specificIndustry' AND COALESCE((p_filters->'specificIndustry'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.specific_industry IS NOT NULL AND TRIM(l.specific_industry) <> '''')');
  END IF;
  IF p_filters ? 'source' AND COALESCE((p_filters->'source'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.source IS NOT NULL AND TRIM(l.source) <> '''')');
  END IF;

  IF p_filters ? 'company' AND COALESCE((p_filters->'company'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.company IS NOT NULL AND TRIM(l.company) <> '''')');
  END IF;
  IF p_filters ? 'seniority' AND COALESCE((p_filters->'seniority'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.seniority IS NOT NULL AND TRIM(l.seniority) <> '''')');
  END IF;
  IF p_filters ? 'esp' AND COALESCE((p_filters->'esp'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.esp IS NOT NULL AND TRIM(l.esp) <> '''')');
  END IF;

  IF p_filters ? 'category' AND COALESCE((p_filters->'category'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.category IS NOT NULL AND TRIM(l.category) <> '''')');
  END IF;

  IF p_filters ? 'subcategory' AND COALESCE((p_filters->'subcategory'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.subcategory IS NOT NULL AND TRIM(l.subcategory) <> '''')');
  END IF;
  IF p_filters ? 'additionalCategory' AND COALESCE((p_filters->'additionalCategory'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.additional_category IS NOT NULL AND TRIM(l.additional_category) <> '''')');
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'country' AND COALESCE((p_filters->'location'->'country'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.country IS NOT NULL AND TRIM(l.country) <> '''')');
  END IF;
  IF p_filters ? 'location' AND p_filters->'location' ? 'state' AND COALESCE((p_filters->'location'->'state'->>'includeUnknown')::boolean, false) THEN
    conditions := array_append(conditions, '(l.state IS NOT NULL AND TRIM(l.state) <> '''')');
  END IF;

  IF (p_filters->>'excludeEmptyName')::boolean IS TRUE THEN
    conditions := array_append(conditions, '(l.first_name IS NOT NULL AND l.first_name <> '''' OR l.last_name IS NOT NULL AND l.last_name <> '''')');
  END IF;
  IF (p_filters->>'excludeEmptyCompany')::boolean IS TRUE THEN
    conditions := array_append(conditions, '(l.company IS NOT NULL AND l.company <> '''')');
  END IF;

  IF p_filters ? 'companySize' THEN
    DECLARE cs_cond TEXT; BEGIN
      cs_cond := fn_handle_company_size(p_filters);
      IF cs_cond IS NOT NULL THEN
        conditions := array_append(conditions, cs_cond);
      END IF;
    END;
  END IF;

  IF p_filters ? 'revenue' THEN
    DECLARE
      rb JSONB := COALESCE(p_filters->'revenue'->'buckets', '[]'::jsonb);
      iu BOOLEAN := COALESCE((p_filters->'revenue'->>'includeUnknown')::boolean, false);
      rc TEXT[] := '{}'; b TEXT;
    BEGIN
      IF jsonb_array_length(rb) > 0 THEN
        FOR b IN SELECT jsonb_array_elements_text(rb) LOOP
          CASE b
            WHEN '<$1M' THEN rc := array_append(rc, '(l.annual_revenue >= 0 AND l.annual_revenue < 1000000)');
            WHEN '$1M-$10M' THEN rc := array_append(rc, '(l.annual_revenue >= 1000000 AND l.annual_revenue < 10000000)');
            WHEN '$10M-$50M' THEN rc := array_append(rc, '(l.annual_revenue >= 10000000 AND l.annual_revenue < 50000000)');
            WHEN '$50M-$100M' THEN rc := array_append(rc, '(l.annual_revenue >= 50000000 AND l.annual_revenue < 100000000)');
            WHEN '$100M-$500M' THEN rc := array_append(rc, '(l.annual_revenue >= 100000000 AND l.annual_revenue < 500000000)');
            WHEN '$500M+' THEN rc := array_append(rc, '(l.annual_revenue >= 500000000)');
            ELSE NULL;
          END CASE;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(rc, ' OR ') || ')');
      ELSIF iu THEN
        conditions := array_append(conditions, 'l.annual_revenue IS NOT NULL');
      END IF;
    END;
  END IF;

  -- KEYWORD — two modes:
  --   contains (default): substring across company/industries/overview.
  --   exact: whole-term matching across company, domain, category, subcategory,
  --     additional_category. Multi-word terms match as a word-boundaried phrase
  --     (plural-tolerant: "dry cleaner" also hits "dry cleaners" but NEVER bare
  --     "cleaner"); single words are word-START anchored so "house" catches
  --     "housecleaning" while "cleaner" does not catch "drycleaner".
  IF p_filters ? 'keyword' THEN
    DECLARE
      kw_inc_exact BOOLEAN := COALESCE(p_filters->'keyword'->>'includeMode', p_filters->'keyword'->>'matchMode', 'contains') = 'exact';
      kw_exc_exact BOOLEAN := COALESCE(p_filters->'keyword'->>'excludeMode', p_filters->'keyword'->>'matchMode', 'contains') = 'exact';
      kw_rx TEXT;
    BEGIN
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'include', '[]'::jsonb)) > 0 THEN
      IF kw_inc_exact THEN
        DECLARE kw_any TEXT[] := '{}'; BEGIN
          FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'include') LOOP
            kw_rx := fn_exact_term_regex(v);
            kw_any := array_append(kw_any, format(
              '(l.company ~* %L OR l.domain ~* %L OR l.category ~* %L OR l.subcategory ~* %L OR l.additional_category ~* %L)',
              kw_rx, kw_rx, kw_rx, kw_rx, kw_rx));
          END LOOP;
          conditions := array_append(conditions, '(' || array_to_string(kw_any, ' OR ') || ')');
        END;
      ELSE
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'include') LOOP
          conditions := array_append(conditions, format(
            '(l.company ILIKE %L OR l.general_industry ILIKE %L OR l.specific_industry ILIKE %L OR l.company_overview ILIKE %L)',
            '%' || v || '%', '%' || v || '%', '%' || v || '%', '%' || v || '%'));
        END LOOP;
      END IF;
    END IF;
    IF jsonb_array_length(COALESCE(p_filters->'keyword'->'exclude', '[]'::jsonb)) > 0 THEN
      FOR v IN SELECT jsonb_array_elements_text(p_filters->'keyword'->'exclude') LOOP
        IF kw_exc_exact THEN
          kw_rx := fn_exact_term_regex(v);
          conditions := array_append(conditions, format(
            '(COALESCE(l.company, '''') !~* %L AND COALESCE(l.domain, '''') !~* %L AND COALESCE(l.category, '''') !~* %L AND COALESCE(l.subcategory, '''') !~* %L AND COALESCE(l.additional_category, '''') !~* %L)',
            kw_rx, kw_rx, kw_rx, kw_rx, kw_rx));
        ELSE
          conditions := array_append(conditions, format(
            '(COALESCE(l.company, '''') NOT ILIKE %L AND COALESCE(l.general_industry, '''') NOT ILIKE %L AND COALESCE(l.specific_industry, '''') NOT ILIKE %L AND COALESCE(l.company_overview, '''') NOT ILIKE %L)',
            '%' || v || '%', '%' || v || '%', '%' || v || '%', '%' || v || '%'));
        END IF;
      END LOOP;
    END IF;
    END;
  END IF;

  -- CATEGORY SEARCH: contains-match terms across category / subcategory /
  -- additional_category. Type "dry" -> matches "Dry cleaner", "Dry cleaning
  -- service", etc. Include = OR of the terms; exclude removes any match.
  IF p_filters ? 'categorySearch' THEN
    DECLARE
      cs TEXT[] := '{}';
      cs_inc_exact BOOLEAN := COALESCE(p_filters->'categorySearch'->>'includeMode', p_filters->'categorySearch'->>'matchMode', 'contains') = 'exact';
      cs_exc_exact BOOLEAN := COALESCE(p_filters->'categorySearch'->>'excludeMode', p_filters->'categorySearch'->>'matchMode', 'contains') = 'exact';
      cs_rx TEXT;
    BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'categorySearch'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'categorySearch'->'include') LOOP
          IF cs_inc_exact THEN
            cs_rx := fn_exact_term_regex(v);
            cs := array_append(cs, format(
              '(l.category ~* %L OR l.subcategory ~* %L OR l.additional_category ~* %L)',
              cs_rx, cs_rx, cs_rx));
          ELSE
            cs := array_append(cs, format(
              '(l.category ILIKE %L OR l.subcategory ILIKE %L OR l.additional_category ILIKE %L)',
              '%' || v || '%', '%' || v || '%', '%' || v || '%'));
          END IF;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(cs, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'categorySearch'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'categorySearch'->'exclude') LOOP
          IF cs_exc_exact THEN
            cs_rx := fn_exact_term_regex(v);
            conditions := array_append(conditions, format(
              '(COALESCE(l.category, '''') !~* %L AND COALESCE(l.subcategory, '''') !~* %L AND COALESCE(l.additional_category, '''') !~* %L)',
              cs_rx, cs_rx, cs_rx));
          ELSE
            conditions := array_append(conditions, format(
              '(COALESCE(l.category, '''') NOT ILIKE %L AND COALESCE(l.subcategory, '''') NOT ILIKE %L AND COALESCE(l.additional_category, '''') NOT ILIKE %L)',
              '%' || v || '%', '%' || v || '%', '%' || v || '%'));
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- CUSTOM TAGS: free-text substring match on leads.tags (any tag, not just
  -- client tags). Separate from the 'tags' (Client Tags) filter.
  IF p_filters ? 'customTags' THEN
    DECLARE ctg TEXT[] := '{}';
            ct_mi TEXT := COALESCE(p_filters->'customTags'->>'includeMode', 'contains');
            ct_me TEXT := COALESCE(p_filters->'customTags'->>'excludeMode', 'contains'); BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'customTags'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'customTags'->'include') LOOP
          IF ct_mi = 'exact' THEN
            ctg := array_append(ctg, format('l.tags ~* %L', '(^|,)\s*' || fn_regex_escape(v) || '\s*(,|$)'));
          ELSE
            ctg := array_append(ctg, format('l.tags ILIKE %L', '%' || v || '%'));
          END IF;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(ctg, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'customTags'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'customTags'->'exclude') LOOP
          IF ct_me = 'exact' THEN
            conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags !~* %L)', '(^|,)\s*' || fn_regex_escape(v) || '\s*(,|$)'));
          ELSE
            conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags NOT ILIKE %L)', '%' || v || '%'));
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- WEBSITE / DOMAIN search: matches the website column, the domain column, OR
  -- the domain derived from the email (so it works even where domain is unset).
  IF p_filters ? 'website' THEN
    DECLARE wq TEXT[] := '{}'; dom TEXT := 'COALESCE(l.domain, split_part(lower(l.email), ''@'', 2))';
            wb_mi TEXT := COALESCE(p_filters->'website'->>'includeMode', 'contains');
            wb_me TEXT := COALESCE(p_filters->'website'->>'excludeMode', 'contains'); BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'website'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'website'->'include') LOOP
          IF wb_mi = 'exact' THEN
            wq := array_append(wq, format('(LOWER(COALESCE(l.website, '''')) = LOWER(%L) OR ' || dom || ' = LOWER(%L))', v, v));
          ELSE
            wq := array_append(wq, format('(COALESCE(l.website, '''') ILIKE %L OR ' || dom || ' ILIKE %L)', '%' || v || '%', '%' || v || '%'));
          END IF;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(wq, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'website'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'website'->'exclude') LOOP
          IF wb_me = 'exact' THEN
            conditions := array_append(conditions, format('(LOWER(COALESCE(l.website, '''')) <> LOWER(%L) AND ' || dom || ' <> LOWER(%L))', v, v));
          ELSE
            conditions := array_append(conditions, format('(COALESCE(l.website, '''') NOT ILIKE %L AND ' || dom || ' NOT ILIKE %L)', '%' || v || '%', '%' || v || '%'));
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- EMAIL CONTAINS (weebly.com / .gov / walmart.com purge-style searches)
  IF p_filters ? 'emailContains' THEN
    DECLARE ec TEXT[] := '{}'; BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'emailContains'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'emailContains'->'include') LOOP
          ec := array_append(ec, format('l.email ILIKE %L', '%' || v || '%'));
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(ec, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'emailContains'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'emailContains'->'exclude') LOOP
          conditions := array_append(conditions, format('l.email NOT ILIKE %L', '%' || v || '%'));
        END LOOP;
      END IF;
    END;
  END IF;

  -- TAGS (Bison comma-separated tags: client tags, ESP tags, ...)
  IF p_filters ? 'tags' THEN
    DECLARE tg TEXT[] := '{}';
            tg_mi TEXT := COALESCE(p_filters->'tags'->>'includeMode', 'contains');
            tg_me TEXT := COALESCE(p_filters->'tags'->>'excludeMode', 'contains'); BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'tags'->'include', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'tags'->'include') LOOP
          IF tg_mi = 'exact' THEN
            tg := array_append(tg, format('l.tags ~* %L', '(^|,)\s*' || fn_regex_escape(v) || '\s*(,|$)'));
          ELSE
            tg := array_append(tg, format('l.tags ILIKE %L', '%' || v || '%'));
          END IF;
        END LOOP;
        conditions := array_append(conditions, '(' || array_to_string(tg, ' OR ') || ')');
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'tags'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR v IN SELECT jsonb_array_elements_text(p_filters->'tags'->'exclude') LOOP
          IF tg_me = 'exact' THEN
            conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags !~* %L)', '(^|,)\s*' || fn_regex_escape(v) || '\s*(,|$)'));
          ELSE
            conditions := array_append(conditions, format('(l.tags IS NULL OR l.tags NOT ILIKE %L)', '%' || v || '%'));
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- GLOBAL SEARCH: comma-separated terms OR'd across email/company/name/domain/categories
  IF p_filters ? 'globalSearch' AND TRIM(COALESCE(p_filters->>'globalSearch', '')) <> '' THEN
    DECLARE gs TEXT[] := '{}'; term TEXT; BEGIN
      FOREACH term IN ARRAY string_to_array(p_filters->>'globalSearch', ',') LOOP
        term := TRIM(term);
        IF term <> '' THEN
          gs := array_append(gs, format(
            '(l.email ILIKE %L OR l.company ILIKE %L OR l.first_name ILIKE %L OR l.last_name ILIKE %L OR l.domain ILIKE %L OR l.category ILIKE %L OR l.subcategory ILIKE %L)',
            '%' || term || '%', '%' || term || '%', '%' || term || '%', '%' || term || '%', '%' || term || '%', '%' || term || '%', '%' || term || '%'));
        END IF;
      END LOOP;
      IF array_length(gs, 1) > 0 THEN
        conditions := array_append(conditions, '(' || array_to_string(gs, ' OR ') || ')');
      END IF;
    END;
  END IF;

  -- EMAIL SIDE (send-to-Bison split): 'b2c' = freemail domain, 'b2b' = business
  IF COALESCE(p_filters->>'emailSide', '') = 'b2c' THEN
    conditions := array_append(conditions, 'split_part(lower(l.email), ''@'', 2) IN (SELECT domain FROM freemail_domains)');
  ELSIF COALESCE(p_filters->>'emailSide', '') = 'b2b' THEN
    conditions := array_append(conditions, 'split_part(lower(l.email), ''@'', 2) NOT IN (SELECT domain FROM freemail_domains)');
  END IF;

  -- EMAIL TYPE (same logic as fn_filter_leads_v2)
  IF p_filters ? 'emailType' THEN
    DECLARE
      want_personal BOOLEAN := COALESCE((p_filters->'emailType'->>'personal')::boolean, true);
      want_general  BOOLEAN := COALESCE((p_filters->'emailType'->>'general')::boolean, true);
    BEGIN
      IF want_personal AND NOT want_general THEN
        conditions := array_append(conditions, 'l.email_type = ''personal''');
      ELSIF want_general AND NOT want_personal THEN
        conditions := array_append(conditions, 'l.email_type = ''general''');
      ELSIF NOT want_personal AND NOT want_general THEN
        conditions := array_append(conditions, 'false');
      END IF;
    END;
  END IF;

  -- COMMERCIAL CLEANING CLIENT: exclude leads whose title matches the default
  -- exclusion list (whole-word, plural-tolerant). Leads without a title stay.
  IF COALESCE((p_filters->>'commercialCleaning')::boolean, false) THEN
    DECLARE cc_rx TEXT; BEGIN
      SELECT string_agg('(' || fn_whole_term_regex(term) || ')', '|') INTO cc_rx
      FROM commercial_cleaning_excluded_titles;
      IF cc_rx IS NOT NULL THEN
        conditions := array_append(conditions, format('(l.title IS NULL OR TRIM(l.title) = '''' OR l.title !~* %L)', cc_rx));
      END IF;
    END;
  END IF;

  -- LOCATION TARGETS: entity-based hierarchy targeting (migration 066).
  -- {include:[{country,state,city}], exclude:[...]} — exact normalized
  -- matching, exclusions override inclusions.
  IF p_filters ? 'locationTargets' THEN
    DECLARE lt_inc TEXT[] := '{}'; lt_c TEXT; lt_e JSONB; BEGIN
      IF jsonb_array_length(COALESCE(p_filters->'locationTargets'->'include', '[]'::jsonb)) > 0 THEN
        FOR lt_e IN SELECT jsonb_array_elements(p_filters->'locationTargets'->'include') LOOP
          lt_c := fn_location_entry_condition(lt_e, false);
          IF lt_c IS NOT NULL THEN lt_inc := array_append(lt_inc, lt_c); END IF;
        END LOOP;
        IF array_length(lt_inc, 1) > 0 THEN
          conditions := array_append(conditions, '(' || array_to_string(lt_inc, ' OR ') || ')');
        END IF;
      END IF;
      IF jsonb_array_length(COALESCE(p_filters->'locationTargets'->'exclude', '[]'::jsonb)) > 0 THEN
        FOR lt_e IN SELECT jsonb_array_elements(p_filters->'locationTargets'->'exclude') LOOP
          lt_c := fn_location_entry_condition(lt_e, true);
          IF lt_c IS NOT NULL THEN conditions := array_append(conditions, lt_c); END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- CLIENT TARGETING: full per-client rule set (send-preview / push-worker)
  IF COALESCE(p_filters->>'applyClientTargeting', '') <> '' THEN
    conditions := conditions || fn_client_eligibility_conditions(p_filters->>'applyClientTargeting');
  END IF;

  -- SILENT GATES: leads confidently outside supported countries, and leads in
  -- the unresolved-location review queue, are hidden from search + campaigns
  -- unless explicitly overridden.
  IF NOT COALESCE((p_filters->>'includeUnsupported')::boolean, false) THEN
    conditions := array_append(conditions, '(l.location_status IS DISTINCT FROM ''unsupported'')');
  END IF;
  IF NOT COALESCE((p_filters->>'includeUnresolved')::boolean, false) THEN
    conditions := array_append(conditions, '(l.location_status IS DISTINCT FROM ''unresolved'')');
  END IF;

  RETURN conditions;
END;
$function$
