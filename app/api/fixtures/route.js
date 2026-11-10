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

function unwrapPage(body) {
  const value = body?.data ?? body;
  if (Array.isArray(value)) {
    return { items: value, pagination: body?.pagination || null };
  }
  return {
    items: value?.fixtures || value?.matches || value?.items || value?.response || [],
    pagination: body?.pagination || value?.pagination || null,
  };
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

  const allMatches = [];
  const limit = 100;
  let offset = 0;
  let hasMore = true;
  const maxPages = 25;

  for (let pageNumber = 0; pageNumber < maxPages && hasMore; pageNumber += 1) {
    const url = new URL(`https://api.goal-api.com/v1/fixtures/date/${encodeURIComponent(date)}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      next: { revalidate: 600 },
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok || body?.success === false) {
      throw new Error(body?.error?.message || body?.message || `GOAL API returned HTTP ${response.status}`);
    }

    const { items, pagination } = unwrapPage(body);
    allMatches.push(...items);

    // Follow the provider's pagination metadata. The length fallback supports
    // responses that omit pagination while still returning a full page.
    hasMore = pagination?.hasMore === true || (!pagination && items.length === limit);
    if (pagination?.hasMore === false || items.length === 0) hasMore = false;

    const nextOffset = Number(pagination?.offset) + Number(pagination?.limit || items.length);
    offset = Number.isFinite(nextOffset) && nextOffset > offset
      ? nextOffset
      : offset + items.length;

    if (items.length < limit && !pagination?.hasMore) hasMore = false;
  }

  return allMatches
    .map(toApiFixture)
    .filter((item) => item.teams.home.name && item.teams.away.name);
}


const API_NINJAS_COMPETITIONS = [
  { code: "epl", name: "Premier League", country: "England" },
  { code: "laliga", name: "La Liga", country: "Spain" },
  { code: "bundesliga", name: "Bundesliga", country: "Germany" },
  { code: "seriea", name: "Serie A", country: "Italy" },
  { code: "ligue1", name: "Ligue 1", country: "France" },
  { code: "ucl", name: "UEFA Champions League", country: "Europe" },
  { code: "uel", name: "UEFA Europa League", country: "Europe" },
  { code: "championship", name: "Championship", country: "England" },
  { code: "leagueone", name: "League One", country: "England" },
  { code: "leaguetwo", name: "League Two", country: "England" },
  { code: "eredivisie", name: "Eredivisie", country: "Netherlands" },
  { code: "primeiraliga", name: "Primeira Liga", country: "Portugal" },
  { code: "mls", name: "MLS", country: "USA/Canada" },
  { code: "scottishpremiership", name: "Scottish Premiership", country: "Scotland" },
  { code: "superlig", name: "Süper Lig", country: "Türkiye" },
  { code: "saudiproleague", name: "Saudi Pro League", country: "Saudi Arabia" },
  { code: "cafcl", name: "CAF Champions League", country: "Africa" },
];

async function getApiNinjasFixtures(date, key) {
  if (!key) throw new Error("API_NINJAS_KEY is not configured.");
  const results = await Promise.allSettled(API_NINJAS_COMPETITIONS.map(async (competition) => {
    const url = new URL("https://api.api-ninjas.com/v1/soccermatches");
    url.searchParams.set("league", competition.code);
    url.searchParams.set("date", date);
    const response = await fetch(url, {
      headers: { "X-Api-Key": key, Accept: "application/json" },
      next: { revalidate: 600 },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof body === "string" ? body : (body?.error || body?.message || JSON.stringify(body));
      throw new Error(`${competition.name}: HTTP ${response.status} ${detail}`);
    }
    if (!Array.isArray(body)) throw new Error(`${competition.name}: unexpected response format`);
    return body.map((match) => {
      const kickoff = match.start_time || (match.date ? `${match.date}T12:00:00Z` : null);
      const statusText = String(match.status || "").toLowerCase();
      const statusMap = {
        final: "FT", scheduled: "NS", in_progress: "LIVE",
        postponed: "PST", canceled: "CANC", suspended: "ABD", delayed: "TBD",
      };
      const home = match.home_team || {};
      const away = match.away_team || {};
      return {
        fixture: {
          id: match.game_id,
          date: kickoff,
          timestamp: kickoff ? Math.floor(Date.parse(kickoff) / 1000) : 0,
          status: { short: statusMap[statusText] || statusText.toUpperCase() || "NS" },
          venue: match.venue?.name ? { name: match.venue.name, city: match.venue.city || null } : null,
        },
        league: {
          id: match.league,
          name: competition.name,
          country: competition.country,
          season: match.season || null,
          logo: null,
          round: match.round || null,
        },
        teams: {
          home: { id: home.team_id, name: home.name, logo: null },
          away: { id: away.team_id, name: away.name, logo: null },
        },
        goals: {
          home: match.home_score === null || match.home_score === undefined ? null : Number(match.home_score),
          away: match.away_score === null || match.away_score === undefined ? null : Number(match.away_score),
        },
      };
    }).filter((fixture) => fixture.teams.home.name && fixture.teams.away.name);
  }));
  const fixtures = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const errors = results.filter((result) => result.status === "rejected")
    .map((result) => result.reason?.message || "request failed");
  const unique = new Map();
  for (const fixture of fixtures) {
    const id = fixture.fixture.id || [
      fixture.fixture.date,
      fixture.teams.home.name,
      fixture.teams.away.name,
    ].join(":");
    unique.set(String(id), fixture);
  }
  if (!unique.size && errors.length === API_NINJAS_COMPETITIONS.length) {
    throw new Error(errors.slice(0, 4).join("; "));
  }
  return { fixtures: [...unique.values()], errors };
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

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json(
      { error: "Date must use YYYY-MM-DD format.", code: "INVALID_DATE" },
      { status: 400 }
    );
  }

  // Fixtures are supplied by GOAL API, Football-Data.org and API Ninjas.\n\n  // A provider error must not blank the entire match centre when another
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

  // API Ninjas is the final current-season fallback. Query the major
  // competitions independently so one unsupported/empty league does not
  // prevent fixtures from the others from appearing.
  let apiNinjasError = null;
  try {
    const apiNinjasResult = await getApiNinjasFixtures(date, process.env.API_NINJAS_KEY);
    if (apiNinjasResult.fixtures.length) {
      return Response.json({
        date,
        timezone: "Africa/Lagos",
        results: apiNinjasResult.fixtures.length,
        fixtures: apiNinjasResult.fixtures,
        source: "API Ninjas",
        fallback: true,
        providers: apiNinjasResult.errors.length ? apiNinjasResult.errors : undefined,
      });
    }
    apiNinjasError = apiNinjasResult.errors.join("; ") || "No fixtures returned for the selected date.";
  } catch (error) {
    apiNinjasError = error?.message || "Request failed";
    console.error("API Ninjas fixtures request failed:", error);
  }

  const diagnostics = [
    `API-Football: ${apiFootballError}`,
    `GOAL API: ${goalResult.status === "rejected" ? goalResult.reason?.message || "request failed" : "No fixtures returned for this date"}`,
    `Football-Data.org: ${footballDataResult.status === "rejected" ? footballDataResult.reason?.message || "request failed" : "No Premier League fixtures returned for this date"}`,
    `API Ninjas: ${apiNinjasError}`,
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
