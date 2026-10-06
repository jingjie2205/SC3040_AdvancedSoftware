import type { Metadata } from "next";
import {Toaster} from "sonner";
import "./assets/globals.css";

export const metadata: Metadata = {
  title: "FITRA — AI-Driven Endurance & Recovery",
  description:
    "Serverless, zero-cost AI-driven endurance training, Banister TRIMP telemetry, and ACWR recovery optimization.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#060913] text-slate-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-300">
        {children}
        <Toaster
          position="bottom-right"
          duration={3000} // Auto-dismisses in 3 seconds
          toastOptions={{
            unstyled: true,
            classNames: {
              toast:
                "flex items-center gap-3 w-auto max-w-sm px-4 py-3 rounded-xl border backdrop-blur-md shadow-2xl transition-all font-sans pointer-events-none select-none",
              success:
                "bg-slate-900/95 border-emerald-500/40 text-emerald-300 shadow-emerald-950/30",
              error:
                "bg-slate-900/95 border-rose-500/40 text-rose-300 shadow-rose-950/30",
              title: "text-sm font-medium text-slate-200",
            },
          }}
        />
      </body>
    </html>
  );
}
