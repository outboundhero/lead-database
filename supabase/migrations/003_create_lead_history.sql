-- OutboundHero Database: Lead history (audit log)
-- Tracks every change, scrape, upload, and export event per lead

CREATE TABLE lead_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,           -- 'created' | 'updated' | 'scraped' | 'exported'
  changed_fields JSONB,               -- { field: { old: x, new: y } }
  performed_by UUID REFERENCES auth.users(id),
  performed_by_name TEXT,             -- denormalized for display
  notes TEXT,                         -- e.g. "Scraped by Noah Smith on 29/05/25 at 11:01am EST"
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lead_history_lead_id ON lead_history (lead_id, created_at DESC);
