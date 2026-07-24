-- Migration 059: the People-file Clay mapping puts Company Short/SEO Descriptions
-- into subcategory/additional_category, which can be paragraph-length and overflow
-- the btree index limit (2704 bytes), failing writes. Replace the plain btree with
-- a trigram GIN (handles any length + accelerates the Category Search ILIKE).
DROP INDEX IF EXISTS idx_leads_subcategory;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_subcategory_trgm ON leads USING gin (subcategory gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_additional_category_trgm ON leads USING gin (additional_category gin_trgm_ops);
