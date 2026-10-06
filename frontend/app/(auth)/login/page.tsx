// Dummy login page, replace with actual login page when merging!
"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";

export default function TempLoginPage() {
  const router = useRouter();

  // Initialize the Supabase client for the browser
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  // login using dummy user created in supabase
  const handleForceLogin = async () => {
    const { error } = await supabase.auth.signInWithPassword({
      email: "dummy@gmail.com",
      password: "dummy123",
    });

    if (error) {
      alert("Login failed: " + error.message);
      return;
    }

    // Refresh the router to apply cookies and redirect to settings
    router.push("/dashboard");
    router.refresh();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950">
      <button
        onClick={handleForceLogin}
        className="rounded-lg bg-emerald-600 px-6 py-3 font-bold text-white hover:bg-emerald-500"
      >
        Force Dev Login
      </button>
    </div>
  );
}
