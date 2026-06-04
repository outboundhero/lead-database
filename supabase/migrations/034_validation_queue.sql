-- OutboundHero Database: validation_jobs table
-- Tracks the pre-export validation pass so the UI can show real-time progress
-- ("Validating 3,420 of 12,000 emails… 3,420 credits used").
-- One validation_job per export job.

CREATE TABLE IF NOT EXISTS validation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  export_job_id UUID REFERENCES export_jobs(id) ON DELETE CASCADE,
  total INT NOT NULL DEFAULT 0,
  completed INT NOT NULL DEFAULT 0,
  credits_used INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'error', 'cancelled')),
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_jobs_export_job_id ON validation_jobs (export_job_id);
CREATE INDEX IF NOT EXISTS idx_validation_jobs_status ON validation_jobs (status);
