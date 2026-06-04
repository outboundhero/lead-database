-- OutboundHero Database: Export jobs
-- Tracks every export with filters, columns, status, and file path

CREATE TABLE export_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID REFERENCES auth.users(id),
  filters_used JSONB,                -- snapshot of filter state at time of export
  selected_ids UUID[],               -- null = filtered export, array = selected rows export
  column_selection TEXT[],           -- which columns to include
  row_count INT,
  status TEXT DEFAULT 'pending',     -- 'pending' | 'processing' | 'complete' | 'error'
  file_path TEXT,                    -- Supabase Storage path
  file_size_bytes BIGINT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ             -- auto-cleanup after 30 days
);
