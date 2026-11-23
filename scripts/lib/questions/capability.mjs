// The word the enrich-worker's heartbeat lists when it runs question jobs
// (139, scripts/lib/questions/jobs.mjs). The web app starts no question job
// while the worker running lacks it. Its own module, with no imports, so the
// routes read it without loading the writer.
export const QUESTION_JOBS_CAPABILITY = "question_jobs";
