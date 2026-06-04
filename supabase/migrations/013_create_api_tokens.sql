-- API tokens for external API access

CREATE TABLE IF NOT EXISTS api_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own tokens"
  ON api_tokens
  FOR ALL
  USING (auth.uid() = user_id);

-- Allow service role to read all (for token validation in API routes)
CREATE POLICY "Service role can read all tokens"
  ON api_tokens
  FOR SELECT
  USING (true);

-- Trigger to auto-insert 'created' event into lead_history when a lead is inserted
CREATE OR REPLACE FUNCTION fn_lead_history_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO lead_history (lead_id, event_type, notes, created_at)
  VALUES (NEW.id, 'created', 'Lead added to database', now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_lead_history_insert ON leads;
CREATE TRIGGER trg_lead_history_insert
  AFTER INSERT ON leads
  FOR EACH ROW
  EXECUTE FUNCTION fn_lead_history_on_insert();

-- Grant service role access (needed for API token validation via admin client)
GRANT ALL ON api_tokens TO service_role;
