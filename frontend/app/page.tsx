import Link from "next/link";
import {
  Activity,
  Zap,
  Cpu,
  ShieldCheck,
  ArrowRight,
  LineChart,
  HeartHandshake,
  Layers,
} from "lucide-react";

export default function HomePage() {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#060913]">
      {/* Glow ambient background */}
      <div className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-emerald-500/10 blur-[130px] rounded-full" />
      <div className="pointer-events-none absolute top-96 -left-20 w-[500px] h-[350px] bg-cyan-500/10 blur-[120px] rounded-full" />

      {/* Navigation */}
      <nav className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-6 py-6 border-b border-slate-800/60 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 text-black shadow-lg shadow-emerald-500/20">
            <Activity className="h-5 w-5 stroke-[2.5]" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white">
            FITRA<span className="text-emerald-400"></span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800"
          >
            Sign In
          </Link>
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-black shadow-md shadow-emerald-500/25 transition hover:bg-emerald-400"
          >
            Launch App
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="relative z-10 mx-auto max-w-7xl px-6 pt-20 pb-28 text-center">
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-medium text-emerald-400 backdrop-blur-md">
          <Zap className="h-3.5 w-3.5" />
          Zero-Cost Serverless Endurance Intelligence
        </div>

        <h1 className="mt-8 text-4xl font-extrabold tracking-tight text-white sm:text-6xl md:text-7xl">
          Scientific Training Load & <br />
          <span className="bg-gradient-to-r from-emerald-400 via-teal-300 to-cyan-400 bg-clip-text text-transparent">
            AI-Driven Recovery
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-400 sm:text-xl">
          Automated Strava webhook ingestion, stream-level Banister TRIMP
          calculation, Acute:Chronic Workload Ratio (ACWR) modeling, and Gemini
          2.5 Flash recovery synthesis.
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-6 py-3.5 text-base font-semibold text-black shadow-lg shadow-emerald-500/25 transition hover:opacity-95"
          >
            Explore Live Dashboard
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/login"
            className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/80 px-6 py-3.5 text-base font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            Connect Strava Account
          </Link>
        </div>

        {/* Feature Cards Grid */}
        <div className="mt-24 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-left backdrop-blur-sm transition hover:border-emerald-500/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400">
              <LineChart className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">
              Banister TRIMP Telemetry
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Integrates heart-rate stream data second-by-second using
              gender-weighted exponential impulse formulas to accurately
              quantify internal training stress.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-left backdrop-blur-sm transition hover:border-emerald-500/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400">
              <Layers className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">
              ACWR Sweet Spot (0.8 - 1.3)
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Compares 7-day acute fatigue against 28-day chronic fitness to
              protect athletes from overtraining spikes and reduce injury
              incidence.
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-left backdrop-blur-sm transition hover:border-emerald-500/40">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400">
              <Cpu className="h-6 w-6" />
            </div>
            <h3 className="mt-4 text-lg font-bold text-white">
              Gemini 2.5 Flash Coach
            </h3>
            <p className="mt-2 text-sm text-slate-400 leading-relaxed">
              Generates structured daily readiness diagnostics, recovery status,
              and tailored workout prescriptions formatted directly for optimal
              adaptation.
            </p>
          </div>
        </div>

        {/* Serverless Architecture Overview */}
        <div className="mt-16 rounded-2xl border border-slate-800/80 bg-slate-950/60 p-8 text-left">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-emerald-400">
            <ShieldCheck className="h-4 w-4" />
            Serverless Architecture & Data Pipeline
          </div>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4 text-xs font-mono text-slate-300">
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
              <span className="text-emerald-400 font-bold">
                1. Strava Webhook
              </span>
              <p className="mt-1 text-slate-400 font-sans">
                Receives activity event and fast-acks &lt;500ms.
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
              <span className="text-cyan-400 font-bold">2. Upstash QStash</span>
              <p className="mt-1 text-slate-400 font-sans">
                Asynchronous HTTP push queue with signature verification.
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
              <span className="text-amber-400 font-bold">3. Supabase DB</span>
              <p className="mt-1 text-slate-400 font-sans">
                Token rotation, stream persistence, and load aggregation.
              </p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
              <span className="text-purple-400 font-bold">
                4. Vercel AI SDK
              </span>
              <p className="mt-1 text-slate-400 font-sans">
                Gemini 2.5 Flash structured synthesis and actionable plans.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
