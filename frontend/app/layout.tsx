import type { Metadata } from "next";
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
      </body>
    </html>
  );
}
