-- OutboundHero Database: Upload batches
-- Tracks every CSV upload with progress and results

CREATE TABLE upload_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by UUID REFERENCES auth.users(id),
  filename TEXT,
  total_rows INT,
  processed_rows INT DEFAULT 0,
  inserted_rows INT DEFAULT 0,
  skipped_rows INT DEFAULT 0,
  merged_rows INT DEFAULT 0,
  replaced_rows INT DEFAULT 0,
  error_rows INT DEFAULT 0,
  duplicate_strategy TEXT DEFAULT 'skip',    -- 'skip' | 'merge' | 'replace'
  field_mapping JSONB,                       -- { csv_column: db_column }
  source_label TEXT,                         -- e.g. "LinkedIn Q1 2026"
  status TEXT DEFAULT 'pending',             -- 'pending' | 'processing' | 'complete' | 'error'
  error_log JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
