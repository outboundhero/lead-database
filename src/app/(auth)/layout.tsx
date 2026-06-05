export const dynamic = "force-dynamic";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background">
      {/* iOS-style ambient gradient orbs */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -left-32 size-[500px] rounded-full opacity-[0.55] blur-[120px]"
        style={{
          background:
            "radial-gradient(closest-side, oklch(0.586 0.214 263 / 0.8), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -right-32 size-[520px] rounded-full opacity-[0.45] blur-[120px]"
        style={{
          background:
            "radial-gradient(closest-side, oklch(0.52 0.21 290 / 0.7), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/3 right-1/4 size-[280px] rounded-full opacity-[0.3] blur-[100px]"
        style={{
          background:
            "radial-gradient(closest-side, oklch(0.745 0.183 145 / 0.7), transparent 70%)",
        }}
      />
      <div className="relative z-10 w-full max-w-md px-4">{children}</div>
    </div>
  );
}
