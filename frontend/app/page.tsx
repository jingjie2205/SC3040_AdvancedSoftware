import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Flame,
  Salad,
  Sparkles,
  Swords,
  Trophy,
  Users,
  Gauge,
} from "lucide-react";

const friends = [
  { name: "Aisha", score: "12,480", rank: 1 },
  { name: "You", score: "11,920", rank: 2 },
  { name: "Daniel", score: "10,305", rank: 3 },
];

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
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight text-white">
              FITRA -
            </span>
            <span className="text-xl font-bold tracking-tight text-emerald-400">
              Fitness & Nutrition Tracker
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/login"
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400"
          >
            Sign In
          </Link>
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-black shadow-md shadow-emerald-500/25 transition hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            Launch App
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </nav>

      <main className="relative z-10 mx-auto max-w-7xl px-6 pt-8 pb-28">
        {/* Feature bento grid */}
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-6">
          {/* Training: the headline feature */}
          <article className="group relative overflow-hidden rounded-3xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/15 via-slate-900/60 to-slate-900/40 p-8 lg:col-span-4">
            <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-emerald-400/20 blur-[90px]" />
            <div className="relative flex h-full flex-col justify-between gap-10 sm:flex-row sm:items-end">
              <div className="max-w-md text-left">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-400 text-black shadow-lg shadow-emerald-500/30">
                  <Swords className="h-6 w-6" />
                </div>
                <h3 className="mt-6 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
                  Train meaningfully.
                </h3>
                <p className="mt-3 text-base leading-relaxed text-slate-300">
                  Log every rep, set and session. Plan your next battle before
                  this one cools down, and watch your strength climb week after
                  week.
                </p>
              </div>

              {/* Progress bars: one week of sessions */}
              <div className="flex h-32 items-end gap-2" aria-hidden="true">
                {[40, 65, 50, 85, 70, 100, 90].map((h, i) => (
                  <div
                    key={i}
                    style={{ height: `${h}%` }}
                    className="w-4 rounded-t-md bg-gradient-to-t from-emerald-600 to-emerald-300 sm:w-5"
                  />
                ))}
              </div>
            </div>
          </article>

          {/* Dashboard */}
          <article className="rounded-3xl border border-slate-800 bg-slate-900/50 p-7 text-left lg:col-span-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-300">
              <Gauge className="h-5 w-5" />
            </div>
            <h3 className="mt-5 text-xl font-bold text-white">Dashboard</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Your data, nutritional stats, training progress all in one glance
            </p>
          </article>

          {/* Nutrition */}
          <article className="rounded-3xl border border-slate-800 bg-slate-900/50 p-7 text-left lg:col-span-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-300">
              <Salad className="h-5 w-5" />
            </div>
            <h3 className="mt-5 text-xl font-bold text-white">Nutrition</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Work out your daily calories, log what you eat, and plan your
              meals for the week.
            </p>
            <div className="mt-5 flex items-center gap-2 text-sm text-amber-300">
              <Flame className="h-4 w-4" />
              <span className="font-semibold">1,840</span>
              <span className="text-slate-500">of 2,200 kcal today</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full w-[84%] rounded-full bg-amber-400" />
            </div>
          </article>

          {/* AI Assistance */}
          <article className="relative overflow-hidden rounded-3xl border border-purple-500/30 bg-gradient-to-b from-purple-500/10 to-slate-900/40 p-7 text-left lg:col-span-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-purple-500/15 text-purple-300">
              <Sparkles className="h-5 w-5" />
            </div>
            <h3 className="mt-5 text-xl font-bold text-white">AI Assistance</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Get meal recommendations that fit your goals, and a training
              schedule that adapts to your week.
            </p>
            <p className="mt-5 rounded-xl rounded-bl-sm bg-purple-500/10 px-3 py-2 text-sm text-purple-100">
              Rest day tomorrow. Add 30 g of protein to dinner tonight.
            </p>
          </article>

          {/* Leaderboard & Friends */}
          <article className="rounded-3xl border border-slate-800 bg-slate-900/50 p-7 text-left lg:col-span-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-rose-500/10 text-rose-300">
              <Users className="h-5 w-5" />
            </div>
            <h3 className="mt-5 text-xl font-bold text-white">
              Leaderboard &amp; Friends
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Train together. Add friends, compare workout stats and climb the
              ranks.
            </p>
            <ul className="mt-5 space-y-1.5">
              {friends.map((f) => (
                <li
                  key={f.name}
                  className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${
                    f.name === "You"
                      ? "bg-rose-500/15 text-rose-100"
                      : "bg-slate-800/50 text-slate-300"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {f.rank === 1 ? (
                      <Trophy className="h-3.5 w-3.5 text-amber-300" />
                    ) : (
                      <span className="w-3.5 text-center text-xs text-slate-500">
                        {f.rank}
                      </span>
                    )}
                    {f.name}
                  </span>
                  <span className="font-semibold">{f.score}</span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </main>
    </div>
  );
}
