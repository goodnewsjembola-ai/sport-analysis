import { NextResponse } from "next/server";

export const revalidate = 3600;

const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "AWD", "WO"]);

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function recentFinishedFixtures(fixtures, limit = 5) {
  return (Array.isArray(fixtures) ? fixtures : [])
    .filter((item) => FINISHED_STATUSES.has(item?.fixture?.status?.short))
    .sort((a, b) => {
      const aTime = Number(a?.fixture?.timestamp) || Date.parse(a?.fixture?.date) || 0;
      const bTime = Number(b?.fixture?.timestamp) || Date.parse(b?.fixture?.date) || 0;
      return bTime - aTime;
    })
    .slice(0, limit);
}

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

    return { fixtures: recentFinishedFixtures(data.response), error: null };
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
  const homeRaw = (params.get("home") || "").trim();
  const awayRaw = (params.get("away") || "").trim();
  const home = Number(homeRaw);
  const away = Number(awayRaw);
  const season = (params.get("season") || "").trim();

  if (
    !homeRaw ||
    !awayRaw ||
    !Number.isSafeInteger(home) ||
    !Number.isSafeInteger(away) ||
    home <= 0 ||
    away <= 0 ||
    home === away
  ) {
    console.error("Invalid team-form IDs received:", {
      homePresent: Boolean(homeRaw),
      awayPresent: Boolean(awayRaw),
      homeIsInteger: Number.isSafeInteger(home),
      awayIsInteger: Number.isSafeInteger(away),
      sameTeam: home === away,
    });
    return NextResponse.json(
      { error: "The match is missing valid team IDs. Please refresh the fixtures and try again.", code: "INVALID_TEAM_IDS" },
      { status: 400 }
    );
  }

  if (season && !/^\\d{4}$/.test(season)) {
    return NextResponse.json({ error: "Season must be a four-digit year." }, { status: 400 });
  }

  // The API-Football Free plan rejects the "last" parameter.
  // Use supported date ranges, then select the five newest completed matches.
  const today = new Date();
  const teamFrom = new Date(today);
  teamFrom.setUTCDate(teamFrom.getUTCDate() - 365);
  const h2hFrom = new Date(today);
  h2hFrom.setUTCFullYear(h2hFrom.getUTCFullYear() - 5);

  const teamFromDate = dateOnly(teamFrom);
  const h2hFromDate = dateOnly(h2hFrom);
  const toDate = dateOnly(today);
  const base = "https://v3.football.api-sports.io/fixtures";

  function makeTeamUrl(teamId) {
    const url = new URL(base);
    url.searchParams.set("team", teamId);
    url.searchParams.set("from", teamFromDate);
    url.searchParams.set("to", toDate);
    url.searchParams.set("timezone", "Africa/Lagos");
    if (season) url.searchParams.set("season", season);
    return url;
  }

  const h2hUrl = new URL(`${base}/headtohead`);
  h2hUrl.searchParams.set("h2h", `${home}-${away}`);
  h2hUrl.searchParams.set("from", h2hFromDate);
  h2hUrl.searchParams.set("to", toDate);
  h2hUrl.searchParams.set("timezone", "Africa/Lagos");

  const [homeResult, awayResult, h2hResult] = await Promise.all([
    fetchFixtures(makeTeamUrl(home), apiKey, "Home recent form"),
    fetchFixtures(makeTeamUrl(away), apiKey, "Away recent form"),
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
    dateRanges: {
      teamFormFrom: teamFromDate,
      headToHeadFrom: h2hFromDate,
      to: toDate,
    },
    timezone: "Africa/Lagos",
  });
}
