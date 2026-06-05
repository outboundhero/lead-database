"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, ArrowLeft } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetMode, setResetMode] = useState(false);
  const supabase = createClient();
  const router = useRouter();

  // Handle invite/recovery tokens or errors in URL hash
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;

    const params = new URLSearchParams(hash.substring(1));

    const hashError = params.get("error_description");
    if (hashError) {
      setError(hashError.replace(/\+/g, " "));
      window.location.hash = "";
      return;
    }

    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const type = params.get("type");

    if (accessToken && refreshToken) {
      supabase.auth
        .setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        .then(() => {
          if (type === "invite" || type === "recovery") {
            window.location.href = "/accept-invite";
          } else {
            window.location.href = "/leads";
          }
        });
    }
  }, [supabase.auth, router]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    window.location.href = "/leads";
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    const siteUrl = window.location.origin;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteUrl}/auth/callback?type=recovery`,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess("Password reset link sent to your email.");
    setLoading(false);
  }

  return (
    <div className="ios-frost-strong shadow-ios-lg rounded-3xl p-8 sm:p-10">
      <div className="mb-7 flex flex-col items-center text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
          <Sparkles className="size-7" strokeWidth={2.2} />
        </div>
        <h1 className="text-[28px] font-semibold tracking-tight">OutboundHero</h1>
        <p className="mt-1 text-[15px] text-muted-foreground">
          {resetMode ? "Reset your password" : "Sign in to your account"}
        </p>
      </div>

      {resetMode ? (
        <form onSubmit={handleResetPassword} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="px-1 text-[13px] font-medium text-muted-foreground">
              Email
            </label>
            <Input
              id="email"
              type="email"
              placeholder="you@outboundhero.io"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] font-medium text-destructive">
              {error}
            </p>
          )}
          {success && (
            <p className="rounded-lg bg-[var(--success)]/10 px-3 py-2 text-[13px] font-medium text-[var(--success)]">
              {success}
            </p>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={loading}>
            {loading ? "Sending…" : "Send reset link"}
          </Button>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1.5 text-[14px] font-medium text-primary hover:opacity-80"
            onClick={() => {
              setResetMode(false);
              setError(null);
              setSuccess(null);
            }}
          >
            <ArrowLeft className="size-3.5" />
            Back to sign in
          </button>
        </form>
      ) : (
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="email" className="px-1 text-[13px] font-medium text-muted-foreground">
              Email
            </label>
            <Input
              id="email"
              type="email"
              placeholder="you@outboundhero.io"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="px-1 text-[13px] font-medium text-muted-foreground">
              Password
            </label>
            <Input
              id="password"
              type="password"
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-[13px] font-medium text-destructive">
              {error}
            </p>
          )}
          {success && (
            <p className="rounded-lg bg-[var(--success)]/10 px-3 py-2 text-[13px] font-medium text-[var(--success)]">
              {success}
            </p>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={loading}>
            {loading ? "Signing in…" : "Sign in"}
          </Button>
          <button
            type="button"
            className="w-full text-center text-[14px] font-medium text-primary hover:opacity-80"
            onClick={() => {
              setResetMode(true);
              setError(null);
              setSuccess(null);
            }}
          >
            Forgot password?
          </button>
        </form>
      )}
    </div>
  );
}
