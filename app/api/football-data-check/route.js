import { NextResponse } from "next/server";

export const revalidate = 3600;

export async function GET() {
  const token = process.env.FOOTBALL_DATA_TOKEN;

  if (!token) {
    return NextResponse.json(
      { status: "not_configured", message: "Football-Data.org token is missing on the server." },
      { status: 503 }
    );
  }

  try {
    const response = await fetch("https://api.football-data.org/v4/competitions", {
      headers: { "X-Auth-Token": token },
      next: { revalidate: 3600 },
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Football-Data.org competitions check failed:", {
        status: response.status,
        message: data?.message || "Unknown provider error",
      });

      return NextResponse.json(
        {
          status: "provider_error",
          message: data?.message || `Football-Data.org returned HTTP ${response.status}.`,
        },
        { status: response.status === 429 ? 429 : 502 }
      );
    }

    const competitions = Array.isArray(data.competitions)
      ? data.competitions.map((competition) => ({
          id: competition.id,
          name: competition.name,
          code: competition.code,
          area: competition.area?.name || null,
        }))
      : [];

    return NextResponse.json({
      status: "ok",
      provider: "Football-Data.org",
      competitionCount: competitions.length,
      competitions,
    });
  } catch (error) {
    console.error("Football-Data.org connection check failed:", error);
    return NextResponse.json(
      { status: "connection_error", message: "Could not connect to Football-Data.org." },
      { status: 502 }
    );
  }
}
