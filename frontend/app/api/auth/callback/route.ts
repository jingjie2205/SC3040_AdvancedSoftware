import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Where Strava sends the athlete after they allow or refuse access. It swaps the one-time code for tokens
 * through the backend, which stores them on the signed-in user, then sends the athlete back to the page they
 * started from: the Training page's Strava tab when the link carried `state=training`, otherwise Settings.
 */
type Outcome = "connected" | "access_denied" | "exchange_failed" | "server_error";

function backTo(origin: string, state: string | null, outcome: Outcome) {
  // Only this one value is understood. Anything else, or nothing, means Settings, as it always has.
  if (state === "training") {
    const query = outcome === "connected" ? "strava=connected" : `strava=error&reason=${outcome}`;
    return NextResponse.redirect(`${origin}/dashboard/training?${query}`);
  }
  const query = outcome === "connected" ? "tab=integrations&connected=true" : `tab=integrations&error=${outcome}`;
  return NextResponse.redirect(`${origin}/dashboard/settings?${query}`);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const baseUrl = request.nextUrl.origin;
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

  if (searchParams.get("error") || !code) {
    return backTo(baseUrl, state, "access_denied");
  }

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  try {
    const response = await fetch(`${backendUrl}/strava/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      console.error("Token exchange failed:", await response.text());
      return backTo(baseUrl, state, "exchange_failed");
    }
  } catch (err) {
    console.error("Backend connection error:", err);
    return backTo(baseUrl, state, "server_error");
  }

  return backTo(baseUrl, state, "connected");
}
