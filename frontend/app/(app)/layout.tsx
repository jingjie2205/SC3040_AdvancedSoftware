"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Home,
  Dumbbell,
  Apple,
  Sparkles,
  Trophy,
  User,
  Settings,
  Users,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type HeaderUser = {
  name: string;
  email: string;
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [user, setUser] = useState<HeaderUser | null>(null);
  const router = useRouter();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    // Get the currently logged-in user.
    const getCurrentUser = async () => {
      const { data, error } = await supabase.auth.getUser();

      if (error || !data.user) {
        setUser(null);
        return;
      }

      const currentUser = data.user;

      setUser({
        name:
          currentUser.user_metadata?.name ||
          currentUser.email?.split("@")[0] ||
          "User",
        email: currentUser.email || "",
      });
    };

    getCurrentUser();

    // Keep the header updated when the authentication state changes.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const currentUser = session?.user;

      if (!currentUser) {
        setUser(null);
        return;
      }

      setUser({
        name:
          currentUser.user_metadata?.name ||
          currentUser.email?.split("@")[0] ||
          "User",
        email: currentUser.email || "",
      });
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const handleLogout = async () => {
    const supabase = createClient();

    const { error } = await supabase.auth.signOut();

    if (error) {
      console.error("Logout failed:", error.message);
      return;
    }

    setIsMenuOpen(false);
    router.replace("/login");
    router.refresh();
  };

  const navItems = [
    { name: "Home", href: "/dashboard", icon: Home },
    { name: "Training", href: "/dashboard/training", icon: Dumbbell },
    { name: "Nutrition", href: "/dashboard/nutrition", icon: Apple },
    { name: "AI Assistance", href: "/dashboard/ai", icon: Sparkles },
    { name: "Leaderboard", href: "/dashboard/leaderboard", icon: Trophy },
    { name: "Friends", href: "/dashboard/friends", icon: Users },
    { name: "Settings", href: "/dashboard/settings", icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-[#060913] text-slate-100 flex flex-col">
      {/* Top Navigation Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#060913]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8 h-16">
          {/* Left: logo + nav */}
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 text-black shadow-md shadow-emerald-500/20">
                <Activity className="h-5 w-5 stroke-[2.5]" />
              </div>
              <span className="text-lg font-bold tracking-tight text-white">
                FITRA<span className="text-emerald-400"></span>
              </span>
            </Link>

            {/* Navigation links */}
            <nav className="hidden md:flex items-center gap-1.5 rounded-xl border border-slate-800/80 bg-slate-900/40 p-1.5 text-xs">
              {navItems.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/dashboard" &&
                    pathname.startsWith(`${item.href}/`));

                const Icon = item.icon;

                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 font-medium transition-colors ${
                      isActive
                        ? "bg-slate-800 text-emerald-400 shadow-sm"
                        : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{item.name}</span>
                  </Link>
                );
              })}
            </nav>
          </div>

          {/* Right: user menu */}
          <div className="relative flex items-center">
            {user && (
              <>
                <button
                  type="button"
                  onClick={() => setIsMenuOpen((open) => !open)}
                  aria-expanded={isMenuOpen}
                  aria-haspopup="menu"
                  className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-slate-800/60"
                >
                  <p className="hidden sm:block text-sm text-slate-200">
                    Welcome back,{" "}
                    <span className="font-semibold text-white">
                      {user.name}
                    </span>
                  </p>

                  <div
                    className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-slate-700 bg-slate-800 text-emerald-400"
                    title={user.email}
                  >
                    <User className="h-4 w-4" />
                  </div>
                </button>

                {isMenuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-slate-700 bg-slate-900 p-2 shadow-xl"
                  >
                    <div className="border-b border-slate-700 px-3 py-2">
                      <p className="text-sm font-semibold text-white">
                        {user.name}
                      </p>
                      <p className="truncate text-xs text-slate-400">
                        {user.email}
                      </p>
                    </div>

                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleLogout}
                      className="mt-1 flex w-full items-center rounded-lg px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
                    >
                      Logout
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
