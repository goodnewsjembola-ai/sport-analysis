import { NextResponse } from "next/server";

export const revalidate = 3600;

async function fetchFixtures(url, apiKey) {
  const response = await fetch(url, {
    headers: { "x-apisports-key": apiKey },
    next: { revalidate: 3600 },
  });
  const data = await response.json();

  if (!response.ok || (data.errors && Object.keys(data.errors).length > 0)) {
    throw new Error("The football data provider could not return recent results.");
  }

  return data.response ?? [];
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

  try {
    const [homeRecent, awayRecent, headToHead] = await Promise.all([
      fetchFixtures(homeUrl, apiKey),
      fetchFixtures(awayUrl, apiKey),
      fetchFixtures(h2hUrl, apiKey),
    ]);

    return NextResponse.json({
      homeRecent,
      awayRecent,
      headToHead,
      timezone: "Africa/Lagos",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Unable to load recent team results." },
      { status: 502 }
    );
  }
}
