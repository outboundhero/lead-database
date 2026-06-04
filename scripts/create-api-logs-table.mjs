import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, serviceRoleKey);

// Test if table already exists by trying to select from it
const { error: testError } = await supabase.from("api_logs").select("id").limit(1);

if (!testError) {
  console.log("api_logs table already exists!");
  process.exit(0);
}

if (testError && !testError.message.includes("does not exist") && !testError.message.includes("api_logs")) {
  console.log("Table might exist but got error:", testError.message);
}

// Create the table via the SQL editor endpoint
// Since we can't run DDL via REST, we'll use the management API
// First, let's try inserting with all columns to auto-create via Supabase dashboard
console.log("Table api_logs does not exist yet.");
console.log("");
console.log("Please create it in the Supabase SQL Editor with this SQL:");
console.log("");
console.log(`
CREATE TABLE IF NOT EXISTS public.api_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id uuid REFERENCES public.api_tokens(id) ON DELETE SET NULL,
  token_name text,
  method text NOT NULL,
  endpoint text NOT NULL,
  status_code integer NOT NULL,
  response_count integer,
  ip_address text,
  duration_ms integer,
  error text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access" ON public.api_logs
  FOR ALL USING (true);

-- Index for fast lookups
CREATE INDEX idx_api_logs_created_at ON public.api_logs(created_at DESC);
CREATE INDEX idx_api_logs_token_id ON public.api_logs(token_id);
`);
