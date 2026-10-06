import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { 
  Activity, 
  Link2, 
  CheckCircle2, 
  User, 
  ArrowRight,
  Unplug
} from "lucide-react";
import ProfileForm from "./ProfileForm";
import { disconnectStrava } from "./actions";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Await searchParams (required in Next.js 15) to determine the active tab
  const resolvedSearchParams = await searchParams;
  const activeTab = resolvedSearchParams.tab || "profile";

  // Secure Authentication Check
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  
  if (!session) {
    redirect("/login");
  }

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
  const profileRes = await fetch(`${backendUrl}/users/me`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    next: { tags: ['user-profile'] }
  });
  
  const userProfile = profileRes.ok ? await profileRes.json() : null;

  const isStravaConnected = !!userProfile?.isStravaConnected;

  const clientId = process.env.NEXT_PUBLIC_STRAVA_CLIENT_ID; 
  const redirectUri = process.env.NEXT_PUBLIC_STRAVA_REDIRECT_URI;

  const authUrl = clientId && redirectUri
    ? `https://www.strava.com/oauth/authorize?${new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, approval_prompt: "force", scope: "activity:read_all,profile:read_all" })}`
    : null;

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight text-white">Settings</h1>
        <p className="mt-2 text-slate-400 text-sm">
          Manage your profile metrics, integrations, and account security.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Sidebar Navigation */}
        <div className="space-y-1">
          <Link 
            href="/dashboard/settings?tab=profile"
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-medium text-sm transition-colors ${
              activeTab === "profile" 
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                : "text-slate-400 hover:bg-slate-900/60 hover:text-slate-200 border border-transparent"
            }`}
          >
            <User className="h-4 w-4" />
            Profile & Metrics
          </Link>
          <Link 
            href="/dashboard/settings?tab=integrations"
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-medium text-sm transition-colors ${
              activeTab === "integrations" 
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                : "text-slate-400 hover:bg-slate-900/60 hover:text-slate-200 border border-transparent"
            }`}
          >
            <Link2 className="h-4 w-4" />
            Integrations
          </Link>
        </div>

        {/* Settings Content Area */}
        <div className="md:col-span-2 space-y-6">
          
          {/* pass user data for rendering */}
          {activeTab === "profile" && <ProfileForm initialData={userProfile} />}
          
          {/* Strava Integration Card */}
          {activeTab === "integrations" && (
            <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 backdrop-blur-sm relative overflow-hidden">
              <div className="absolute -top-12 -right-12 w-32 h-32 bg-[#FC4C02]/10 blur-[50px] rounded-full pointer-events-none" />
              
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#FC4C02]/10 border border-[#FC4C02]/20 text-[#FC4C02]">
                    <Activity className="h-6 w-6" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white flex items-center gap-2">
                      Strava
                      {isStravaConnected && (
                        <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">
                          <CheckCircle2 className="h-3 w-3" />
                          Connected
                        </span>
                      )}
                    </h3>
                    <p className="mt-1 text-xs text-slate-400">
                      Sync activities, telemetry streams, and gear wear automatically.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6 border-t border-slate-800/60 pt-6">
                {isStravaConnected ? (
                  <div className="flex items-center justify-between flex-wrap gap-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/10 border border-emerald-500/20">
                        <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-200">Account Linked</p>
                        <p className="text-xs text-slate-500">Telemetry sync is active</p>
                      </div>
                    </div>

                    {/* Native Server Action form - no extra components or toast logic needed */}
                    <form action={disconnectStrava}>
                      <button
                        type="submit"
                        className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/50 px-4 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-red-400 hover:border-red-900/50"
                      >
                        <Unplug className="h-3.5 w-3.5" />
                        Disconnect
                      </button>
                    </form>
                  </div>
                ) : (
                  <div className="flex items-center justify-between flex-wrap gap-4">
                    <p className="text-sm text-slate-400 max-w-sm">
                      Connect your account to enable TRIMP tracking, ACWR modeling, and AI coach analysis.
                    </p>
                    {authUrl ? <Link
                      href={authUrl}
                      className="flex items-center gap-2 rounded-lg bg-[#FC4C02] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[#FC4C02]/20 transition hover:bg-[#E34402]"
                    >
                      Connect Strava
                      <ArrowRight className="h-4 w-4" />
                    </Link> : <p className="text-sm text-slate-400">Strava connection is not configured yet.</p>}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
