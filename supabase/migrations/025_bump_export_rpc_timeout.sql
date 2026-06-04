-- Bump fn_export_leads statement_timeout from 300s → 600s.
--
-- A single batch RPC for deep cursor positions on heavy filters (e.g. job
-- title 'ceo' which alias-expands across 15+ junction-table values, returning
-- ~915K leads) was hitting the 300s timeout, causing exports to error mid-stream.
--
-- Pairs with the route-level maxDuration bump from 300s → 600s. Together they
-- let exports of ~500K-1M rows complete in one stream.

ALTER FUNCTION fn_export_leads(JSONB, TEXT, INT, INT) SET statement_timeout = '600s';
