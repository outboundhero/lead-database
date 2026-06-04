"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Copy, Plus, Trash2, Eye, EyeOff, CheckCircle2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ApiToken, ApiLog } from "@/types/database";
import { useHasPermission } from "@/lib/context/role-context";
import { AccessDenied } from "@/components/layout/access-denied";

function generateToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let rand = "";
  for (let i = 0; i < 40; i++) {
    rand += chars[Math.floor(Math.random() * chars.length)];
  }
  return `rdb_${rand}`;
}

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="relative group">
      <pre className="bg-muted rounded-md p-3 text-xs overflow-x-auto leading-relaxed">
        {children}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded bg-background border text-xs"
      >
        {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function EndpointCard({
  method,
  path,
  description,
  params,
  example,
  response,
}: {
  method: "GET" | "POST";
  path: string;
  description: string;
  params: { name: string; type: string; required: boolean; desc: string }[];
  example: string;
  response: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <Badge
            variant={method === "GET" ? "secondary" : "default"}
            className="font-mono text-xs px-2"
          >
            {method}
          </Badge>
          <code className="text-sm font-mono font-medium">{path}</code>
        </div>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {params.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">Parameters</p>
            <div className="rounded-md border divide-y">
              {params.map((p) => (
                <div key={p.name} className="flex items-start gap-3 px-3 py-2 text-xs">
                  <code className="font-mono text-primary shrink-0">{p.name}</code>
                  <span className="text-muted-foreground shrink-0">{p.type}</span>
                  {p.required && <Badge variant="outline" className="text-[10px] px-1 h-4 shrink-0">required</Badge>}
                  <span className="text-muted-foreground">{p.desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">Example Request</p>
          <CodeBlock>{example}</CodeBlock>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground mb-2">Example Response</p>
          <CodeBlock>{response}</CodeBlock>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ApiKeysPage() {
  const canView = useHasPermission("admin");
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [showTokens, setShowTokens] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<ApiLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("api_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (data) setLogs(data as ApiLog[]);
    setLogsLoading(false);
  }, []);

  const loadTokens = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("api_tokens")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setTokens(data as ApiToken[]);
  }, []);

  useEffect(() => {
    loadTokens();
    loadLogs();
  }, [loadTokens, loadLogs]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    const token = generateToken();
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("api_tokens").insert({
      name: newName.trim(),
      token,
      user_id: user?.id ?? null,
      is_active: true,
    });
    if (error) {
      toast.error(error.message);
    } else {
      setNewToken(token);
      setNewName("");
      loadTokens();
    }
    setCreating(false);
  }

  async function handleRevoke(id: string) {
    const supabase = createClient();
    await supabase.from("api_tokens").update({ is_active: false }).eq("id", id);
    loadTokens();
    toast.success("Token revoked");
  }

  function copyToken(token: string) {
    navigator.clipboard.writeText(token);
    toast.success("Token copied to clipboard");
  }

  if (!canView) return <AccessDenied />;

  const baseUrl = typeof window !== "undefined" ? window.location.origin : "https://your-app.com";

  return (
    <div className="space-y-6 p-4 max-w-5xl">
      <h1 className="text-lg font-semibold">API Keys & Documentation</h1>

      <Tabs defaultValue="keys">
        <TabsList>
          <TabsTrigger value="keys">API Keys</TabsTrigger>
          <TabsTrigger value="docs">Documentation</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        {/* ── API Keys Tab ── */}
        <TabsContent value="keys" className="space-y-4 mt-4">

          {/* New token revealed */}
          {newToken && (
            <Card className="border-green-500/50 bg-green-500/5">
              <CardContent className="pt-4 space-y-2">
                <p className="text-sm font-medium text-green-700 dark:text-green-400">
                  Token created — copy it now. It won&apos;t be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs bg-muted rounded px-3 py-2 font-mono break-all">
                    {newToken}
                  </code>
                  <Button size="sm" variant="outline" onClick={() => copyToken(newToken)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setNewToken(null)}>
                  Dismiss
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Create new */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Generate New Token</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  placeholder="Token name (e.g. Production, Zapier)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  className="max-w-sm"
                />
                <Button onClick={handleCreate} disabled={creating || !newName.trim()}>
                  <Plus className="h-4 w-4 mr-1" />
                  Generate
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Token list */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Active Tokens</CardTitle>
            </CardHeader>
            <CardContent>
              {tokens.length === 0 ? (
                <p className="text-sm text-muted-foreground">No API tokens yet.</p>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Name</TableHead>
                        <TableHead className="text-xs">Token</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs">Last Used</TableHead>
                        <TableHead className="text-xs">Created</TableHead>
                        <TableHead className="text-xs"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tokens.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell className="text-xs font-medium">{t.name}</TableCell>
                          <TableCell className="text-xs font-mono">
                            <div className="flex items-center gap-1">
                              <span>
                                {showTokens[t.id]
                                  ? t.token
                                  : `${t.token.slice(0, 10)}${"•".repeat(20)}`}
                              </span>
                              <button
                                onClick={() =>
                                  setShowTokens((p) => ({ ...p, [t.id]: !p[t.id] }))
                                }
                                className="text-muted-foreground hover:text-foreground"
                              >
                                {showTokens[t.id] ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <button
                                onClick={() => copyToken(t.token)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={t.is_active ? "default" : "destructive"}
                              className="text-xs"
                            >
                              {t.is_active ? "Active" : "Revoked"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {t.last_used_at
                              ? new Date(t.last_used_at).toLocaleString()
                              : "Never"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {new Date(t.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            {t.is_active && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-destructive hover:text-destructive"
                                onClick={() => handleRevoke(t.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Documentation Tab ── */}
        <TabsContent value="docs" className="space-y-6 mt-4">

          {/* Auth */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Authentication</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                All API requests must include your API token in the <code className="text-xs bg-muted px-1 rounded">Authorization</code> header.
              </p>
              <CodeBlock>{`Authorization: Bearer rdb_your_token_here`}</CodeBlock>
              <p className="text-xs text-muted-foreground">
                Requests without a valid token return <code className="bg-muted px-1 rounded">401 Unauthorized</code>.
              </p>
            </CardContent>
          </Card>

          {/* Endpoints */}
          <EndpointCard
            method="POST"
            path="/api/enrich_email"
            description="Find email addresses for contacts at a given company website. Returns first_name, last_name, and email for all matching leads."
            params={[
              { name: "website", type: "string", required: true, desc: "The website URL to search for. Matches any lead where the stored website contains this value (case-insensitive substring match)." },
            ]}
            example={`curl -X POST ${baseUrl}/api/enrich_email \\
  -H "Authorization: Bearer rdb_your_token" \\
  -H "Content-Type: application/json" \\
  -d '{"website": "acme.com"}'`}
            response={`{
  "results": [
    {
      "email": "john.doe@acme.com",
      "first_name": "John",
      "last_name": "Doe",
      "full_name": "John Doe"
    }
  ],
  "count": 1
}`}
          />

          <EndpointCard
            method="GET"
            path="/api/leads/first5"
            description="Returns the 5 most recently added leads. Useful for testing your integration."
            params={[]}
            example={`curl -X GET ${baseUrl}/api/leads/first5 \\
  -H "Authorization: Bearer rdb_your_token"`}
            response={`{
  "results": [
    {
      "id": "uuid",
      "email": "jane@corp.com",
      "first_name": "Jane",
      "last_name": "Smith",
      "job_title": "CEO",
      "company_name_raw": "Corp Inc",
      "phone": "+1 555 0100",
      "website": "corp.com",
      "source": "Apollo",
      "country": "US",
      "city": "New York",
      "state": "NY",
      "seniority": "C-Level",
      "general_industry": "Technology",
      "created_at": "2024-01-15T10:00:00Z"
    }
  ],
  "count": 5
}`}
          />

          <EndpointCard
            method="POST"
            path="/api/leads/search/company_name_raw"
            description="Search leads by company website URL and/or company name. Both parameters are optional but at least one must be provided. When both are given, results match either condition (OR)."
            params={[
              { name: "website", type: "string", required: false, desc: "Company website URL. Substring match against stored website values (e.g. 'acme.com' matches 'https://www.acme.com')." },
              { name: "company", type: "string", required: false, desc: "Company name. Substring match against company_name_raw field (case-insensitive)." },
            ]}
            example={`curl -X POST ${baseUrl}/api/leads/search/company_name_raw \\
  -H "Authorization: Bearer rdb_your_token" \\
  -H "Content-Type: application/json" \\
  -d '{"website": "acme.com", "company": "Acme"}'`}
            response={`{
  "results": [
    {
      "id": "uuid",
      "email": "john@acme.com",
      "first_name": "John",
      "last_name": "Doe",
      "job_title": "VP Sales",
      "company_name_raw": "Acme Corporation",
      "website": "https://acme.com",
      "annual_revenue": "$10M-$50M",
      "company_size": "51-200",
      "country": "US",
      "created_at": "2024-01-15T10:00:00Z"
    }
  ],
  "count": 1
}`}
          />

          {/* Rate limits / notes */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>• All endpoints return a maximum of <strong>100 results</strong> per request.</p>
              <p>• String matching is case-insensitive and uses substring matching (ILIKE).</p>
              <p>• All responses are JSON with <code className="text-xs bg-muted px-1 rounded">Content-Type: application/json</code>.</p>
              <p>• Revoked tokens return <code className="text-xs bg-muted px-1 rounded">401</code> immediately.</p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Logs Tab ── */}
        <TabsContent value="logs" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">API Request History</CardTitle>
              <Button size="sm" variant="outline" onClick={loadLogs} disabled={logsLoading}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1 ${logsLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              {logs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No API requests logged yet.</p>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Time</TableHead>
                        <TableHead className="text-xs">Method</TableHead>
                        <TableHead className="text-xs">Endpoint</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs">Results</TableHead>
                        <TableHead className="text-xs">Duration</TableHead>
                        <TableHead className="text-xs">Token</TableHead>
                        <TableHead className="text-xs">Error</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {logs.map((log) => (
                        <TableRow key={log.id}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(log.created_at).toLocaleString()}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={log.method === "GET" ? "secondary" : "default"}
                              className="font-mono text-[10px] px-1.5"
                            >
                              {log.method}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs font-mono">{log.endpoint}</TableCell>
                          <TableCell>
                            <Badge
                              variant={log.status_code >= 400 ? "destructive" : "outline"}
                              className="text-[10px] px-1.5"
                            >
                              {log.status_code}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {log.response_count ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {log.duration_ms != null ? `${log.duration_ms}ms` : "—"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {log.token_name ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs text-destructive max-w-[200px] truncate">
                            {log.error ?? ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
