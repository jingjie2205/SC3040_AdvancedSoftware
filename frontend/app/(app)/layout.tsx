"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Home,
  Dumbbell,
  Apple,
  Sparkles,
  Trophy,
  User,
  Settings,
} from "lucide-react";

// Mock data for now
const mockUser: { name: string; email: string; image: string | null } = {
  name: "John Doe",
  email: "john.doe@example.com",
  image: "https://i.pravatar.cc/200?img=13", // set to null to test the default icon, using pravatar for mock avatars. /200 = resolution?img=number
  //image: null, // set to null to test the default icon
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const user = mockUser;

  const navItems = [
    { name: "Home", href: "/dashboard", icon: Home },
    { name: "Training", href: "/dashboard/training", icon: Dumbbell },
    { name: "Nutrition", href: "/dashboard/nutrition", icon: Apple },
    { name: "AI Assistance", href: "/dashboard/ai", icon: Sparkles },
    { name: "Leaderboard", href: "/dashboard/leaderboard", icon: Trophy },
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

            {/* Navigation links container */}
            <nav className="hidden md:flex items-center gap-1.5 rounded-xl border border-slate-800/80 bg-slate-900/40 p-1.5 text-xs">
              {navItems.map((item) => {
                const isActive = pathname === item.href;
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

          {/* Right: welcome message + user icon */}
          <div className="flex items-center gap-3">
            <p className="hidden sm:block text-sm text-slate-200">
              Welcome back,{" "}
              <span className="font-semibold text-white">{user.name}</span>
            </p>
            <div
              className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-slate-700 bg-slate-800 text-emerald-400"
              title={user.email}
            >
              {user.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.image}
                  alt={user.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <User className="h-4 w-4" />
              )}
            </div>
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
