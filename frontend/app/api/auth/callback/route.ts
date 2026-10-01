import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const baseUrl = request.nextUrl.origin;

  if (error || !code) {
    return NextResponse.redirect(`${baseUrl}/settings?tab=integrations&error=access_denied`);
  }

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  try {
    const response = await fetch("http://localhost:8000/strava/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      console.error("Token exchange failed:", await response.text());
      return NextResponse.redirect(`${baseUrl}/settings?tab=integrations&error=exchange_failed`);
    }
  } catch (err) {
    console.error("Backend connection error:", err);
    return NextResponse.redirect(`${baseUrl}/settings?tab=integrations&error=server_error`);
  }

  // 3. Return user to Settings page
  return NextResponse.redirect(`${baseUrl}/settings?tab=integrations&connected=true`);
}