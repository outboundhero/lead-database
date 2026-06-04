-- Renaissance Database: Indexes
-- Critical for sub-1-second filtering at 10M+ rows

-- Enable pg_trgm for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- High-frequency filter fields (B-tree)
CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_source ON leads(source);
CREATE INDEX idx_leads_job_title_normalized ON leads(job_title_normalized);
CREATE INDEX idx_leads_seniority ON leads(seniority);
CREATE INDEX idx_leads_general_industry ON leads(general_industry);
CREATE INDEX idx_leads_specific_industry ON leads(specific_industry);
CREATE INDEX idx_leads_company_size ON leads(company_size);
CREATE INDEX idx_leads_annual_revenue ON leads(annual_revenue);
CREATE INDEX idx_leads_esp ON leads(esp);
CREATE INDEX idx_leads_country ON leads(country);
CREATE INDEX idx_leads_state ON leads(state);
CREATE INDEX idx_leads_city ON leads(city);
CREATE INDEX idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX idx_leads_company_name ON leads(company_name);

-- Compound indexes for common filter combinations
CREATE INDEX idx_leads_industry_size ON leads(general_industry, company_size);
CREATE INDEX idx_leads_title_industry ON leads(job_title_normalized, general_industry);
CREATE INDEX idx_leads_source_title ON leads(source, job_title_normalized);
CREATE INDEX idx_leads_seniority_industry ON leads(seniority, general_industry);

-- Full-text search (GIN)
CREATE INDEX idx_leads_company_fts ON leads USING gin(to_tsvector('english', coalesce(company_name, '')));
CREATE INDEX idx_leads_fullname_fts ON leads USING gin(to_tsvector('english', coalesce(first_name, '') || ' ' || coalesce(last_name, '')));
CREATE INDEX idx_leads_job_title_trgm ON leads USING gin(job_title_normalized gin_trgm_ops);
CREATE INDEX idx_leads_company_name_trgm ON leads USING gin(company_name gin_trgm_ops);

-- Technologies array (GIN for @> contains queries)
CREATE INDEX idx_leads_technologies ON leads USING gin(technologies);

-- Companies table indexes
CREATE INDEX idx_companies_name ON companies(name);
CREATE INDEX idx_companies_general_industry ON companies(general_industry);
