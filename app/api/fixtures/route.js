function getLagosDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function unwrapList(body) {
  const value = body?.data ?? body;
  if (Array.isArray(value)) return value;
  return value?.fixtures || value?.matches || value?.items || value?.response || [];
}

function toApiFixture(match) {
  const homeName = match.homeTeamName || match.homeTeam?.name || match.match_hometeam_name || match.home?.name;
  const awayName = match.awayTeamName || match.awayTeam?.name || match.match_awayteam_name || match.away?.name;
  const homeId = match.homeTeamId || match.homeTeam?.id || match.match_hometeam_id || match.home?.id;
  const awayId = match.awayTeamId || match.awayTeam?.id || match.match_awayteam_id || match.away?.id;
  const kickoff = match.kickoffUtc || match.utcDate || match.fixture?.date || match.matchDate || match.match_date || match.date;
  const statusText = String(match.matchStatus || match.status || match.fixture?.status?.short || "").toUpperCase();
  const statusMap = {
    FINISHED: "FT", FULL_TIME: "FT", FT: "FT",
    SCHEDULED: "NS", NOT_STARTED: "NS", TIMED: "NS", NS: "NS",
    LIVE: "LIVE", IN_PLAY: "LIVE", FIRST_HALF: "1H", SECOND_HALF: "2H",
    HALF_TIME: "HT", POSTPONED: "PST", CANCELLED: "CANC", ABANDONED: "ABD",
  };
  const homeScore = match.homeTeamFtScore ?? match.homeTeamScore ?? match.match_hometeam_score ?? match.goals?.home ?? match.score?.fullTime?.home;
  const awayScore = match.awayTeamFtScore ?? match.awayTeamScore ?? match.match_awayteam_score ?? match.goals?.away ?? match.score?.fullTime?.away;
  const league = match.league || match.competition || {};
  const country = match.countryName || match.country || league.country || "";
  return {
    fixture: {
      id: match.apiId || match.fixture?.id || match.id || match.match_id,
      date: kickoff,
      timestamp: kickoff ? Math.floor(Date.parse(kickoff) / 1000) : 0,
      status: { short: statusMap[statusText] || statusText || "NS" },
      venue: match.venue || match.fixture?.venue || null,
    },
    league: {
      id: match.leagueId || league.id || league.apiId,
      name: match.leagueName || league.name || match.competitionName || "Competition",
      country,
      season: match.season || league.season || null,
      logo: match.leagueLogo || league.logo || null,
      round: match.round || league.round || null,
    },
    teams: {
      home: { id: homeId, name: homeName, logo: match.homeTeamLogo || match.homeTeam?.logo || match.home?.logo || null },
      away: { id: awayId, name: awayName, logo: match.awayTeamLogo || match.awayTeam?.logo || match.away?.logo || null },
    },
    goals: {
      home: homeScore === null || homeScore === undefined || homeScore === "" ? null : Number(homeScore),
      away: awayScore === null || awayScore === undefined || awayScore === "" ? null : Number(awayScore),
    },
  };
}

async function getGoalFixtures(date, key) {
  if (!key) throw new Error("GOAL_API_KEY is not configured.");
  const response = await fetch(`https://api.goal-api.com/v1/fixtures/date/${encodeURIComponent(date)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    next: { revalidate: 600 },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error?.message || body?.message || `GOAL API returned HTTP ${response.status}`);
  }
  return unwrapList(body).map(toApiFixture).filter((item) => item.teams.home.name && item.teams.away.name);
}

async function getFootballDataFixtures(date, token) {
  if (!token) throw new Error("FOOTBALL_DATA_TOKEN is not configured.");
  const url = new URL("https://api.football-data.org/v4/competitions/PL/matches");
  url.searchParams.set("dateFrom", date);
  url.searchParams.set("dateTo", date);
  const response = await fetch(url, {
    headers: { "X-Auth-Token": token, Accept: "application/json" },
    next: { revalidate: 600 },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || `Football-Data.org returned HTTP ${response.status}`);
  return (body.matches || []).map(toApiFixture).filter((item) => item.teams.home.name && item.teams.away.name);
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const requestedDate = params.get("date");
  const date = requestedDate || getLagosDate();

  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
    return Response.json(
      { error: "Date must use YYYY-MM-DD format.", code: "INVALID_DATE" },
      { status: 400 }
    );
  }

  const apiKey = process.env.API_FOOTBALL_KEY;
  const apiUrl = new URL("https://v3.football.api-sports.io/fixtures");
  apiUrl.searchParams.set("date", date);
  apiUrl.searchParams.set("timezone", "Africa/Lagos");

  let apiFootballError = null;
  if (apiKey) {
    try {
      const response = await fetch(apiUrl, {
        method: "GET",
        headers: { "x-apisports-key": apiKey },
        next: { revalidate: 600 },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || (data.errors && Object.keys(data.errors).length > 0)) {
        apiFootballError = data?.errors ? JSON.stringify(data.errors) : `HTTP ${response.status}`;
        console.error("API-Football fixtures request failed:", { status: response.status, errors: data.errors });
      } else if (Array.isArray(data.response) && data.response.length > 0) {
        return Response.json({
          date,
          timezone: "Africa/Lagos",
          results: data.results ?? data.response.length,
          fixtures: data.response,
          source: "API-Football",
        });
      } else {
        apiFootballError = "API-Football returned no fixtures for the selected date.";
      }
    } catch (error) {
      apiFootballError = error?.message || "Request failed";
      console.error("API-Football fixtures request failed:", error);
    }
  } else {
    apiFootballError = "API_FOOTBALL_KEY is missing.";
  }

  // A provider error must not blank the entire match centre when another
  // configured source can supply the selected day's fixtures.
  const [goalResult, footballDataResult] = await Promise.allSettled([
    getGoalFixtures(date, process.env.GOAL_API_KEY),
    getFootballDataFixtures(date, process.env.FOOTBALL_DATA_TOKEN),
  ]);

  if (goalResult.status === "fulfilled" && goalResult.value.length) {
    return Response.json({
      date,
      timezone: "Africa/Lagos",
      results: goalResult.value.length,
      fixtures: goalResult.value,
      source: "GOAL API",
      fallback: true,
    });
  }

  if (footballDataResult.status === "fulfilled" && footballDataResult.value.length) {
    return Response.json({
      date,
      timezone: "Africa/Lagos",
      results: footballDataResult.value.length,
      fixtures: footballDataResult.value,
      source: "Football-Data.org",
      fallback: true,
    });
  }

  const diagnostics = [
    `API-Football: ${apiFootballError}`,
    `GOAL API: ${goalResult.status === "rejected" ? goalResult.reason?.message || "request failed" : "No fixtures returned for this date"}`,
    `Football-Data.org: ${footballDataResult.status === "rejected" ? footballDataResult.reason?.message || "request failed" : "No Premier League fixtures returned for this date"}`,
  ];
  console.error("All fixture providers failed:", diagnostics);

  return Response.json(
    {
      error: "Fixture data is temporarily unavailable from the configured providers.",
      code: "ALL_PROVIDERS_UNAVAILABLE",
      providers: diagnostics,
    },
    { status: 502 }
  );
}
