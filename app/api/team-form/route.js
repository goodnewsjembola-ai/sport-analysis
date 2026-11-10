import { NextResponse } from "next/server";

export const revalidate = 3600;

async function fetchFixtures(url, apiKey, label) {
  try {
    const response = await fetch(url, {
      headers: { "x-apisports-key": apiKey },
      next: { revalidate: 3600 },
    });

    let data;
    try {
      data = await response.json();
    } catch {
      return { fixtures: [], error: `${label}: provider returned an unreadable response (HTTP ${response.status}).` };
    }

    const providerErrors = data.errors && Object.keys(data.errors).length > 0
      ? Object.values(data.errors).map((value) => String(value)).join("; ")
      : "";

    if (!response.ok || providerErrors) {
      console.error("API-Football team-form request failed:", {
        label,
        status: response.status,
        errors: data.errors,
      });
      return {
        fixtures: [],
        error: `${label}: ${providerErrors || `HTTP ${response.status}`}`,
      };
    }

    return { fixtures: data.response ?? [], error: null };
  } catch (error) {
    console.error("API-Football team-form network error:", label, error);
    return { fixtures: [], error: `${label}: provider connection failed.` };
  }
}

export async function GET(request) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Football data is not configured." }, { status: 503 });
  }

  const params = new URL(request.url).searchParams;
  const home = params.get("home");
  const away = params.get("away");
  const season = params.get("season");

  if (!/^\d+$/.test(home || "") || !/^\d+$/.test(away || "") || home === away) {
    return NextResponse.json({ error: "Valid home and away team IDs are required." }, { status: 400 });
  }

  if (season && !/^\d{4}$/.test(season)) {
    return NextResponse.json({ error: "Season must be a four-digit year." }, { status: 400 });
  }

  const base = "https://v3.football.api-sports.io/fixtures";
  const homeUrl = new URL(base);
  homeUrl.searchParams.set("team", home);
  homeUrl.searchParams.set("last", "5");
  homeUrl.searchParams.set("timezone", "Africa/Lagos");
  if (season) homeUrl.searchParams.set("season", season);

  const awayUrl = new URL(base);
  awayUrl.searchParams.set("team", away);
  awayUrl.searchParams.set("last", "5");
  awayUrl.searchParams.set("timezone", "Africa/Lagos");
  if (season) awayUrl.searchParams.set("season", season);

  const h2hUrl = new URL(`${base}/headtohead`);
  h2hUrl.searchParams.set("h2h", `${home}-${away}`);
  h2hUrl.searchParams.set("last", "5");
  h2hUrl.searchParams.set("timezone", "Africa/Lagos");

  const [homeResult, awayResult, h2hResult] = await Promise.all([
    fetchFixtures(homeUrl, apiKey, "Home recent form"),
    fetchFixtures(awayUrl, apiKey, "Away recent form"),
    fetchFixtures(h2hUrl, apiKey, "Head-to-head history"),
  ]);

  const errors = [homeResult.error, awayResult.error, h2hResult.error].filter(Boolean);
  const hasAnyData = homeResult.fixtures.length || awayResult.fixtures.length || h2hResult.fixtures.length;

  if (!hasAnyData && errors.length) {
    return NextResponse.json(
      {
        error: "API-Football could not provide recent results for this match.",
        details: errors,
        code: "RECENT_FORM_UNAVAILABLE",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    homeRecent: homeResult.fixtures,
    awayRecent: awayResult.fixtures,
    headToHead: h2hResult.fixtures,
    warnings: errors,
    timezone: "Africa/Lagos",
  });
}
