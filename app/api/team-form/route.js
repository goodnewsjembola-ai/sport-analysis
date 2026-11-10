import { NextResponse } from "next/server";

export const revalidate = 1800;

const COMPETITIONS = [
  { code: "PL", names: ["premier league"] },
  { code: "ELC", names: ["championship"] },
  { code: "CL", names: ["uefa champions league", "champions league"] },
  { code: "EC", names: ["european championship", "uefa euro"] },
  { code: "FL1", names: ["ligue 1"] },
  { code: "BL1", names: ["bundesliga"] },
  { code: "SA", names: ["serie a"] },
  { code: "DED", names: ["eredivisie"] },
  { code: "PPL", names: ["primeira liga", "liga portugal"] },
  { code: "CLI", names: ["copa libertadores"] },
  { code: "PD", names: ["primera division", "la liga", "laliga"] },
  { code: "BSA", names: ["campeonato brasileiro", "brasileirao"] },
  { code: "WC", names: ["fifa world cup", "world cup"] },
];

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Normalize common broadcast/provider abbreviations before matching.
    // "Man Utd", "Manchester Utd" and "Manchester United" must resolve
    // to the same club across GOAL, ESPN, API-Football and API Ninjas.
    .replace(/\bman\s*u\b/g, "manchester united")
    .replace(/\bmanu\b/g, "manchester united")
    .replace(/\butd\b/g, "united")
    .replace(/\b(fc|cf|afc|club|football club|town)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}



const API_FOOTBALL_INTERNATIONAL = [
  "nations league", "uefa nations league", "concacaf nations league",
  "africa cup of nations", "afcon", "copa america", "fifa world cup",
  "world cup", "european championship", "uefa euro", "asian cup",
  "afc asian cup", "concacaf gold cup", "gold cup", "oceania nations cup",
  "arab cup", "olympics", "international friendly", "friendlies",
];

async function apiFootball(path, key) {
  const response = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { "x-apisports-key": key },
    next: { revalidate: 1800 },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.errors && Object.keys(body.errors).length)) {
    const detail = body?.errors ? JSON.stringify(body.errors) : `HTTP ${response.status}`;
    throw new Error(`API-Football request failed: ${detail}`);
  }
  return body.response || [];
}

function sortApiFootballRecent(items) {
  return (items || [])
    .filter((match) => match.fixture?.status?.short === "FT"
      && Number.isFinite(Number(match.goals?.home)) && Number.isFinite(Number(match.goals?.away)))
    .sort((a, b) => (b.fixture?.timestamp || 0) - (a.fixture?.timestamp || 0))
    .slice(0, 5);
}

async function findApiFootballTeamId(teamName, key) {
  const query = new URLSearchParams({ search: teamName });
  const teams = await apiFootball(`/teams?${query.toString()}`, key);
  const wanted = normalize(teamName);
  const exact = teams.find((item) => normalize(item.team?.name) === wanted);
  const matches = teams.filter((item) => {
    const candidate = normalize(item.team?.name);
    return candidate.length > 4 && wanted.length > 3
      && (candidate.includes(wanted) || wanted.includes(candidate));
  });
  const selected = exact || matches.sort((a, b) =>
    normalize(a.team?.name).length - normalize(b.team?.name).length
  )[0];
  return selected?.team?.id || null;
}

async function getApiFootballH2H(homeName, awayName) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY is missing from the server environment.");
  const [homeId, awayId] = await Promise.all([
    findApiFootballTeamId(homeName, key),
    findApiFootballTeamId(awayName, key),
  ]);
  if (!homeId || !awayId) throw new Error("API-Football could not resolve both clubs for head-to-head.");
  const meetings = await apiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}`, key);
  return sortApiFootballRecent(meetings);
}

async function getApiFootballForm(homeName, awayName) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY is missing from the server environment.");
  // Resolve IDs in API-Football itself; fixture IDs may belong to GOAL API.
  const [homeId, awayId] = await Promise.all([
    findApiFootballTeamId(homeName, key),
    findApiFootballTeamId(awayName, key),
  ]);
  if (!homeId || !awayId) {
    throw new Error(`API-Football could not resolve its own team IDs. Home: ${homeId || "not found"}; Away: ${awayId || "not found"}.`);
  }

  // API-Football requires season whenever the fixtures request includes team.
  // Check the current and previous season, then keep only matches in the
  // rolling one-year window so old results are never presented as recent form.
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const recentStart = new Date(today);
  recentStart.setUTCDate(recentStart.getUTCDate() - 365);
  const from = recentStart.toISOString().slice(0, 10);
  // The connected API-Football free plan only exposes seasons 2022–2024.
  // Do not request newer seasons: those requests fail and can make both teams look empty.
  const seasons = [2024, 2023, 2022];

  // Fetch each team's form independently so one provider failure does not
  // discard the other team's available results or the H2H response.
  const [homeRequest, awayRequest, h2hRequest] = await Promise.allSettled([
    Promise.all(seasons.map((season) =>
      apiFootball(`/fixtures?team=${homeId}&season=${season}&from=${from}&to=${to}`, key)
    )),
    Promise.all(seasons.map((season) =>
      apiFootball(`/fixtures?team=${awayId}&season=${season}&from=${from}&to=${to}`, key)
    )),
    apiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}`, key),
  ]);

  const homeRecent = homeRequest.status === "fulfilled" ? sortApiFootballRecent(homeRequest.value.flat()) : [];
  const awayRecent = awayRequest.status === "fulfilled" ? sortApiFootballRecent(awayRequest.value.flat()) : [];
  const headToHead = h2hRequest.status === "fulfilled" ? sortApiFootballRecent(h2hRequest.value) : [];
  const warnings = [];
  if (homeRequest.status === "rejected") warnings.push(`API-Football could not retrieve the home team's results: ${homeRequest.reason?.message || "request failed"}`);
  if (awayRequest.status === "rejected") warnings.push(`API-Football could not retrieve the away team's results: ${awayRequest.reason?.message || "request failed"}`);
  if (h2hRequest.status === "rejected") warnings.push(`API-Football head-to-head request failed: ${h2hRequest.reason?.message || "request failed"}`);
  if (!homeRecent.length) warnings.push(`API-Football returned no completed recent fixtures for the home team (ID ${homeId}) in the last 365 days.`);
  if (!awayRecent.length) warnings.push(`API-Football returned no completed recent fixtures for the away team (ID ${awayId}) in the last 365 days.`);

  return {
    homeRecent,
    awayRecent,
    headToHead,
    warnings,
    formNotice: "Recent form uses each team's latest completed matches across competitions from the last 365 days. Head-to-head meetings are listed separately. Availability depends on the competition and API plan.",
    source: "API-Football",
  };
}

const NPFL_ID = "cmr77dxdp00urrx06pmkuqz1e";

async function goalApi(path, key) {
  const response = await fetch(`https://api.goal-api.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    next: { revalidate: 1800 },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `GOAL API returned HTTP ${response.status}`);
  }
  return body?.data ?? body;
}

function findGoalTeam(teams, targetName) {
  const wanted = normalize(targetName);
  const candidates = (teams || []).filter((team) => normalize(team.name));
  const exact = candidates.find((team) => normalize(team.name) === wanted);
  if (exact) return exact;
  // Prefer the shortest senior-club name (e.g. Leeds United) over a
  // similarly named academy or reserve side (e.g. Leeds United U21).
  const matches = candidates.filter((team) => {
    const candidate = normalize(team.name);
    return candidate.length > 4 && wanted.length > 3
      && (candidate.includes(wanted) || wanted.includes(candidate));
  });
  return matches.sort((a, b) => normalize(a.name).length - normalize(b.name).length)[0] || null;
}

function convertGoalResult(match) {
  const homeId = match.homeTeamId;
  const awayId = match.awayTeamId;
  const homeName = match.homeTeamName || match.homeTeam?.name;
  const awayName = match.awayTeamName || match.awayTeam?.name;
  const homeScore = Number(match.homeTeamFtScore ?? match.homeTeamScore);
  const awayScore = Number(match.awayTeamFtScore ?? match.awayTeamScore);
  return {
    fixture: {
      id: match.id || match.apiId,
      date: match.kickoffUtc || match.matchDate,
      timestamp: match.kickoffUtc
        ? Math.floor(Date.parse(match.kickoffUtc) / 1000)
        : Math.floor(Date.parse(`${match.matchDate}T${match.matchTime || "00:00"}:00Z`) / 1000),
      status: { short: "FT" },
    },
    teams: {
      home: { id: homeId, name: homeName },
      away: { id: awayId, name: awayName },
    },
    goals: { home: homeScore, away: awayScore },
  };
}

function convertGoalH2H(match) {
  const homeScore = Number(match.match_hometeam_score);
  const awayScore = Number(match.match_awayteam_score);
  return {
    fixture: {
      id: match.match_id,
      date: match.match_date,
      timestamp: Math.floor(Date.parse(`${match.match_date}T${match.match_time || "00:00"}:00Z`) / 1000),
      status: { short: "FT" },
    },
    teams: {
      home: { id: match.match_hometeam_id, name: match.match_hometeam_name },
      away: { id: match.match_awayteam_id, name: match.match_awayteam_name },
    },
    goals: { home: homeScore, away: awayScore },
  };
}

async function getNpFlForm(homeName, awayName) {
  const key = process.env.GOAL_API_KEY;
  if (!key) throw new Error("GOAL_API_KEY is missing from the server environment.");

  const [teamsBody] = await Promise.all([
    goalApi(`/leagues/${NPFL_ID}/teams`, key),
  ]);
  const teams = Array.isArray(teamsBody) ? teamsBody : teamsBody?.teams || teamsBody?.items || [];
  const homeTeam = findGoalTeam(teams, homeName);
  const awayTeam = findGoalTeam(teams, awayName);

  if (!homeTeam || !awayTeam) {
    return {
      homeRecent: [], awayRecent: [], headToHead: [],
      warnings: [`Could not match both teams in GOAL API's current NPFL team list.`],
      formNotice: "Recent form is shown only when GOAL API has completed match records for both teams. No older-season results are substituted.",
      source: "GOAL API",
    };
  }

  const [homeBody, awayBody, h2hBody] = await Promise.all([
    goalApi(`/teams/${homeTeam.id}/results`, key),
    goalApi(`/teams/${awayTeam.id}/results`, key),
    goalApi(`/h2h/${homeTeam.id}/${awayTeam.id}/direct`, key),
  ]);

  const asArray = (value) => Array.isArray(value) ? value : value?.matches || value?.results || value?.items || value?.data || [];
  const completed = (items) => asArray(items)
    .filter((match) => String(match.matchStatus || "").toUpperCase() === "FINISHED"
      && match.homeTeamFtScore !== null && match.homeTeamFtScore !== undefined
      && match.awayTeamFtScore !== null && match.awayTeamFtScore !== undefined)
    .sort((a, b) => Date.parse(b.kickoffUtc || b.matchDate) - Date.parse(a.kickoffUtc || a.matchDate));

  const homeMatches = completed(homeBody).slice(0, 5);
  const awayMatches = completed(awayBody).slice(0, 5);
  const meetings = asArray(h2hBody)
    .filter((match) => String(match.match_status || "").toLowerCase() === "finished"
      && match.match_hometeam_score !== null && match.match_hometeam_score !== undefined
      && match.match_awayteam_score !== null && match.match_awayteam_score !== undefined)
    .sort((a, b) => Date.parse(b.match_date) - Date.parse(a.match_date))
    .slice(0, 5);

  return {
    homeRecent: homeMatches.map(convertGoalResult),
    awayRecent: awayMatches.map(convertGoalResult),
    headToHead: meetings.map(convertGoalH2H),
    warnings: [],
    formNotice: "Recent form uses each team's latest completed NPFL results supplied by GOAL API. Head-to-head meetings are shown separately and may be from earlier seasons.",
    source: "GOAL API",
    teamsMatched: { home: homeTeam.name, away: awayTeam.name },
  };
}
async function findGoalTeamByName(name, key) {
  // Read the full response envelope so pagination.hasMore is not lost.
  // goalApi() unwraps data for ordinary endpoints, which previously caused
  // this directory scan to stop after its first page and miss major clubs.
  const limit = 100;
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    const response = await fetch(
      `https://api.goal-api.com/v1/teams?limit=${limit}&offset=${offset}`,
      {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        next: { revalidate: 1800 },
      }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      throw new Error(body?.error?.message || body?.message || `GOAL API team directory returned HTTP ${response.status}`);
    }
    const data = body?.data ?? body;
    const nested = data?.data ?? data;
    const teams = Array.isArray(nested) ? nested
      : Array.isArray(nested?.teams) ? nested.teams
      : Array.isArray(nested?.items) ? nested.items
      : Array.isArray(nested?.results) ? nested.results
      : [];
    const match = findGoalTeam(teams, name);
    if (match) return match;

    const pagination = body?.pagination || data?.pagination || nested?.pagination;
    if (pagination && pagination.hasMore === false) break;
    if (pagination && pagination.hasMore === true) {
      const nextOffset = Number(pagination.offset ?? offset) + Number(pagination.limit || teams.length || limit);
      offset = nextOffset > offset ? nextOffset : offset + (teams.length || limit);
    } else {
      if (teams.length < limit) break;
      offset += teams.length;
    }
    if (!teams.length) break;
  }
  return null;
}

function goalFixtureToStandard(match) {
  const homeName = match.homeTeamName || match.homeTeam?.name || match.match_hometeam_name || match.home?.name;
  const awayName = match.awayTeamName || match.awayTeam?.name || match.match_awayteam_name || match.away?.name;
  const homeScore = match.homeTeamFtScore ?? match.homeTeamScore ?? match.match_hometeam_score ?? match.homeScore ?? match.goals?.home ?? match.score?.fullTime?.home;
  const awayScore = match.awayTeamFtScore ?? match.awayTeamScore ?? match.match_awayteam_score ?? match.awayScore ?? match.goals?.away ?? match.score?.fullTime?.away;
  const kickoff = match.kickoffUtc || match.utcDate || match.matchDate || match.match_date || match.date || match.fixture?.date;
  const rawStatus = match.matchStatus || match.match_status || match.status?.short || match.status || match.fixture?.status?.short || "";
  const status = String(typeof rawStatus === "object" ? rawStatus.name || rawStatus.type || "" : rawStatus).toUpperCase();
  const dateText = kickoff ? String(kickoff) : "";
  const timestamp = dateText ? Math.floor(Date.parse(dateText.includes("T") ? dateText : `${dateText}T${match.matchTime || match.match_time || "00:00"}:00Z`) / 1000) : 0;
  return {
    fixture: { id: match.id || match.apiId || match.match_id, date: kickoff, timestamp, status: { short: ["FINISHED", "FT"].includes(status) ? "FT" : status } },
    teams: { home: { id: match.homeTeamId || match.homeTeam?.id || match.match_hometeam_id, name: homeName }, away: { id: match.awayTeamId || match.awayTeam?.id || match.match_awayteam_id, name: awayName } },
    goals: { home: Number(homeScore), away: Number(awayScore) },
  };
}

async function getGoalTeamResults(teamId, key) {
  // GOAL API documents both /teams/:id/results and /results/team/:id.
  // Query both routes independently: coverage can differ between the two
  // feeds, and one empty route must not hide the other route's results.
  const limit = 100;
  const routes = [
    `/teams/${encodeURIComponent(teamId)}/results`,
    `/results/team/${encodeURIComponent(teamId)}`,
  ];

  async function readRoute(route) {
    const rows = [];
    let offset = 0;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`https://api.goal-api.com/v1${route}`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("offset", String(offset));
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        next: { revalidate: 1800 },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.success === false) {
        throw new Error(body?.error?.message || body?.message || `GOAL API ${route} returned HTTP ${response.status}`);
      }
      const data = body?.data ?? body;
      const nested = data?.data ?? data;
      const list = Array.isArray(nested) ? nested
        : Array.isArray(nested?.results) ? nested.results
        : Array.isArray(nested?.matches) ? nested.matches
        : Array.isArray(nested?.items) ? nested.items
        : Array.isArray(nested?.fixtures) ? nested.fixtures
        : Array.isArray(body?.results) ? body.results
        : [];
      rows.push(...list);
      const pagination = body?.pagination || data?.pagination || nested?.pagination;
      const hasMore = pagination?.hasMore === true || (!pagination && list.length === limit);
      if (!hasMore || list.length === 0) break;
      const nextOffset = Number(pagination?.offset) + Number(pagination?.limit || list.length);
      offset = Number.isFinite(nextOffset) && nextOffset > offset ? nextOffset : offset + list.length;
    }
    return rows;
  }

  const responses = await Promise.allSettled(routes.map(readRoute));
  const rows = responses.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!rows.length && responses.every((result) => result.status === "rejected")) {
    throw new Error(responses.map((result) => result.reason?.message || "request failed").join("; "));
  }

  const seen = new Set();
  return rows.filter((match) => {
    const id = match.id || match.apiId || match.match_id || match.fixture?.id;
    const key = id ? `id:${id}` : JSON.stringify([
      match.kickoffUtc || match.matchDate || match.match_date || match.date || match.fixture?.date,
      match.homeTeamId || match.homeTeam?.id || match.match_hometeam_id || match.home?.id,
      match.awayTeamId || match.awayTeam?.id || match.match_awayteam_id || match.away?.id,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function getGoalApiForm(homeName, awayName, homeApiId, awayApiId) {
  const key = process.env.GOAL_API_KEY;
  if (!key) throw new Error("GOAL_API_KEY is missing from the server environment.");
  const [homeTeam, awayTeam] = await Promise.all([findGoalTeamByName(homeName, key), findGoalTeamByName(awayName, key)]);
  if (!homeTeam || !awayTeam) throw new Error(`GOAL API team search could not match both clubs. Home: ${homeTeam?.name || "not found"}; Away: ${awayTeam?.name || "not found"}.`);
  // Keep each provider request independent: a missing/unsupported H2H record
  // must not erase valid recent-form results for either team.
  const [homeRequest, awayRequest, h2hRequest] = await Promise.allSettled([
    getGoalTeamResults(homeTeam.id, key),
    getGoalTeamResults(awayTeam.id, key),
    goalApi(`/h2h/${encodeURIComponent(homeTeam.id)}/${encodeURIComponent(awayTeam.id)}/direct?limit=50`, key),
  ]);
  const homeBody = homeRequest.status === "fulfilled" ? homeRequest.value : [];
  const awayBody = awayRequest.status === "fulfilled" ? awayRequest.value : [];
  const h2hBody = h2hRequest.status === "fulfilled" ? h2hRequest.value : [];
  const requestWarnings = [
    ...(homeRequest.status === "rejected" ? [`GOAL API could not retrieve results for ${homeTeam.name}: ${homeRequest.reason?.message || "request failed"}`] : []),
    ...(awayRequest.status === "rejected" ? [`GOAL API could not retrieve results for ${awayTeam.name}: ${awayRequest.reason?.message || "request failed"}`] : []),
    ...(h2hRequest.status === "rejected" && !String(h2hRequest.reason?.message || "").includes("HTTP 404") ? [`GOAL API head-to-head is unavailable: ${h2hRequest.reason?.message || "request failed"}`] : []),
  ];
  const asArray = (value) => Array.isArray(value) ? value
    : value?.matches || value?.results || value?.items || value?.fixtures || value?.data || [];
  const recentCutoff = Math.floor((Date.now() - 365 * 86400000) / 1000);
  const completed = (items, includeOlderMeetings = false) => asArray(items)
    .filter((match) => {
      const rawStatus = match.matchStatus || match.match_status || match.status?.short || match.status || match.fixture?.status?.short || "";
      const status = String(typeof rawStatus === "object" ? rawStatus.name || rawStatus.type || "" : rawStatus).toUpperCase();
      const homeScore = match.homeTeamFtScore ?? match.homeTeamScore ?? match.match_hometeam_score ?? match.homeScore ?? match.goals?.home ?? match.score?.fullTime?.home;
      const awayScore = match.awayTeamFtScore ?? match.awayTeamScore ?? match.match_awayteam_score ?? match.awayScore ?? match.goals?.away ?? match.score?.fullTime?.away;
      return ["FINISHED", "FT", "FULL_TIME", "STATUS_FINAL"].includes(status)
        && homeScore !== null && homeScore !== undefined
        && awayScore !== null && awayScore !== undefined;
    })
    .map(goalFixtureToStandard)
    .filter((match) => Number.isFinite(match.goals.home) && Number.isFinite(match.goals.away)
      && (includeOlderMeetings || match.fixture.timestamp >= recentCutoff))
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp).slice(0, 5);
  const attachFixtureTeamId = (matches, targetTeam, fixtureTeamId) => matches.map((match) => {
    // Match on GOAL's stable team ID first. Club display names can vary
    // between providers (for example, "Leeds" vs "Leeds United"), and a
    // name-only miss previously made the UI treat the away side as the team.
    if (String(match.teams.home.id || "") === String(targetTeam.id || "")
      || normalize(match.teams.home.name) === normalize(targetTeam.name)) {
      match.teams.home.id = fixtureTeamId;
    } else if (String(match.teams.away.id || "") === String(targetTeam.id || "")
      || normalize(match.teams.away.name) === normalize(targetTeam.name)) {
      match.teams.away.id = fixtureTeamId;
    }
    return match;
  });
  const homeRecent = attachFixtureTeamId(completed(homeBody), homeTeam, homeApiId);
  const awayRecent = attachFixtureTeamId(completed(awayBody), awayTeam, awayApiId);
  const headToHead = completed(h2hBody, true);
  if (!homeRecent.length && !awayRecent.length && !headToHead.length) {
    throw new Error(requestWarnings.join(" ") || "GOAL API returned no completed results for either team.");
  }
  return { homeRecent, awayRecent, headToHead,
    warnings: [...requestWarnings, ...(!homeRecent.length ? [`GOAL API has no completed recent results for ${homeTeam.name}.`] : []), ...(!awayRecent.length ? [`GOAL API has no completed recent results for ${awayTeam.name}.`] : [])],
    formNotice: "Recent form uses the latest completed results supplied by GOAL API. Head-to-head meetings are listed separately.",
    source: "GOAL API", teamsMatched: { home: homeTeam.name, away: awayTeam.name } };
}

function mergeRecentMatches(primary, fallback) {
  const seen = new Set();
  return [...(primary || []), ...(fallback || [])]
    .filter((match) => {
      const fixture = match.fixture || {};
      const home = normalize(match.teams?.home?.name);
      const away = normalize(match.teams?.away?.name);
      const identity = fixture.id
        ? `id:${fixture.id}`
        : `match:${fixture.timestamp || fixture.date || ""}:${home}:${away}:${match.goals?.home}-${match.goals?.away}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .sort((a, b) => (b.fixture?.timestamp || 0) - (a.fixture?.timestamp || 0))
    .slice(0, 5);
}

async function footballData(path, token) {
  const response = await fetch(`https://api.football-data.org/v4${path}`, {
    headers: { "X-Auth-Token": token },
    next: { revalidate: 1800 },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || `Football-Data.org returned HTTP ${response.status}`);
  }
  return data;
}

function findTeam(teams, targetName) {
  const wanted = normalize(targetName);
  if (!wanted) return null;
  // Exact normalized matching avoids accidentally mapping a youth side to
  // its senior club when a provider returns partial-name search results.
  return teams.find((team) => normalize(team.name) === wanted || normalize(team.shortName) === wanted || normalize(team.tla) === wanted)
    || null;
}

function convertMatch(match) {
  const home = match.homeTeam || {};
  const away = match.awayTeam || {};
  const score = match.score?.fullTime || {};
  return {
    fixture: {
      id: match.id,
      date: match.utcDate,
      timestamp: match.utcDate ? Math.floor(Date.parse(match.utcDate) / 1000) : 0,
      status: { short: match.status === "FINISHED" ? "FT" : match.status },
    },
    teams: {
      home: { id: home.id, name: home.name || home.shortName },
      away: { id: away.id, name: away.name || away.shortName },
    },
    goals: { home: score.home, away: score.away },
  };
}


async function getFootballDataForm(homeName, awayName, leagueName) {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) throw new Error("FOOTBALL_DATA_TOKEN is missing from the server environment.");

  // The global /teams endpoint is incomplete on some plans. Search each
  // competition's current team list as well, because cup fixtures can involve
  // clubs from different divisions and the fixture's competition may not
  // contain either club.
  const competitionCodes = [...new Set(COMPETITIONS.map((item) => item.code))];
  const [directoryResult, ...competitionResults] = await Promise.allSettled([
    footballData("/teams", token),
    ...competitionCodes.map((code) => footballData(`/competitions/${code}/teams`, token)),
  ]);
  const directory = directoryResult.status === "fulfilled" ? directoryResult.value : { teams: [] };
  const allTeams = [
    ...(Array.isArray(directory?.teams) ? directory.teams : []),
    ...competitionResults.flatMap((result) =>
      result.status === "fulfilled" && Array.isArray(result.value?.teams) ? result.value.teams : []
    ),
  ];
  const uniqueTeams = [...new Map(allTeams.filter((team) => team?.id)
    .map((team) => [String(team.id), team])).values()];
  const homeTeam = findTeam(uniqueTeams, homeName);
  const awayTeam = findTeam(uniqueTeams, awayName);

  if (!homeTeam || !awayTeam) {
    const searched = competitionCodes.filter((_, index) =>
      competitionResults[index]?.status === "fulfilled"
    );
    throw new Error(
      `Football-Data.org could not identify both clubs after searching its global directory and ${searched.length} competition team lists. Home: ${homeTeam?.name || "not found"}; Away: ${awayTeam?.name || "not found"}.`
    );
  }

  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 365);
  const from = start.toISOString().slice(0, 10);
  const [homeResult, awayResult] = await Promise.allSettled([
    footballData(`/teams/${homeTeam.id}/matches?dateFrom=${from}&dateTo=${to}&status=FINISHED&limit=100`, token),
    footballData(`/teams/${awayTeam.id}/matches?dateFrom=${from}&dateTo=${to}&status=FINISHED&limit=100`, token),
  ]);

  const recent = (data) => (Array.isArray(data?.matches) ? data.matches : [])
    .filter((match) => match.status === "FINISHED"
      && Number.isFinite(Number(match.score?.fullTime?.home))
      && Number.isFinite(Number(match.score?.fullTime?.away)))
    .map(convertMatch)
    .sort((a, b) => (b.fixture.timestamp || 0) - (a.fixture.timestamp || 0))
    .slice(0, 5);

  const homeMatches = homeResult.status === "fulfilled" ? homeResult.value : null;
  const awayMatches = awayResult.status === "fulfilled" ? awayResult.value : null;
  const homeRecent = homeMatches ? recent(homeMatches) : [];
  const awayRecent = awayMatches ? recent(awayMatches) : [];
  const h2hMatches = [
    ...(Array.isArray(homeMatches?.matches) ? homeMatches.matches : []),
    ...(Array.isArray(awayMatches?.matches) ? awayMatches.matches : []),
  ].filter((match) => match.status === "FINISHED"
    && ((normalize(match.homeTeam?.name) === normalize(homeTeam.name)
        && normalize(match.awayTeam?.name) === normalize(awayTeam.name))
      || (normalize(match.homeTeam?.name) === normalize(awayTeam.name)
        && normalize(match.awayTeam?.name) === normalize(homeTeam.name))))
    .map(convertMatch)
    .sort((a, b) => (b.fixture.timestamp || 0) - (a.fixture.timestamp || 0));

  const warnings = [
    ...(homeResult.status === "rejected"
      ? [`Football-Data.org could not retrieve matches for ${homeTeam.name}: ${homeResult.reason?.message || "request failed"}.`]
      : (!homeRecent.length ? [`Football-Data.org returned no completed recent results for ${homeTeam.name}.`] : [])),
    ...(awayResult.status === "rejected"
      ? [`Football-Data.org could not retrieve matches for ${awayTeam.name}: ${awayResult.reason?.message || "request failed"}.`]
      : (!awayRecent.length ? [`Football-Data.org returned no completed recent results for ${awayTeam.name}.`] : [])),
  ];

  return {
    homeRecent,
    awayRecent,
    headToHead: mergeRecentMatches(h2hMatches, []),
    warnings,
    source: "Football-Data.org",
    teamsMatched: { home: homeTeam.name, away: awayTeam.name },
  };
}



// API Ninjas is an independent current-season fallback. Its club IDs are
// stable across competitions, and team-only match queries return that club's
// current-season schedule across available competitions.
async function apiNinjasJson(path, key) {
  const response = await fetch(`https://api.api-ninjas.com/v1${path}`, {
    headers: { "X-Api-Key": key, Accept: "application/json" },
    next: { revalidate: 1800 },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body === "string" ? body : (body?.error || body?.message || JSON.stringify(body));
    throw new Error(`API Ninjas returned HTTP ${response.status}: ${detail}`);
  }
  if (!Array.isArray(body)) throw new Error("API Ninjas returned an unexpected response format.");
  return body;
}

let apiNinjasClubDirectoryPromise;

async function getApiNinjasClubDirectory(key) {
  if (!apiNinjasClubDirectoryPromise) {
    apiNinjasClubDirectoryPromise = apiNinjasJson("/soccerclubs", key).catch((error) => {
      apiNinjasClubDirectoryPromise = null;
      throw error;
    });
  }
  return apiNinjasClubDirectoryPromise;
}

async function findApiNinjasTeam(teamName, key) {
  // Do not send a plain club name as the API's team filter: short names such
  // as "Wigan" can be ambiguous and the provider may return HTTP 400.
  // Load the club directory once, then resolve the exact club locally.
  const clubs = await getApiNinjasClubDirectory(key);
  const wanted = normalize(teamName);
  const exact = clubs.find((club) =>
    normalize(club.name) === wanted
    || normalize(club.short_name) === wanted
    || normalize(club.abbreviation) === wanted
  );
  const candidates = clubs.filter((club) => {
    const name = normalize(club.name);
    const shortName = normalize(club.short_name);
    return wanted.length > 2 && (
      name.startsWith(wanted) || shortName.startsWith(wanted)
      || name.includes(wanted) || shortName.includes(wanted)
    );
  }).sort((a, b) => {
    const aName = normalize(a.name);
    const bName = normalize(b.name);
    const aScore = aName.startsWith(wanted) ? 0 : 1;
    const bScore = bName.startsWith(wanted) ? 0 : 1;
    return aScore - bScore || aName.length - bName.length;
  });
  const team = exact || candidates[0];
  if (!team?.team_id) {
    throw new Error(`API Ninjas could not identify "${teamName}" in its full club directory.`);
  }
  return team;
}

function apiNinjasMatchToStandard(match) {
  const home = match.home_team || {};
  const away = match.away_team || {};
  const timestamp = match.start_time ? Math.floor(Date.parse(match.start_time) / 1000)
    : match.date ? Math.floor(Date.parse(`${match.date}T12:00:00Z`) / 1000) : 0;
  return {
    fixture: {
      id: match.game_id,
      date: match.start_time || match.date,
      timestamp,
      status: { short: "FT" },
    },
    teams: {
      home: { id: home.team_id, name: home.name },
      away: { id: away.team_id, name: away.name },
    },
    goals: { home: Number(match.home_score), away: Number(match.away_score) },
  };
}

async function getApiNinjasForm(homeName, awayName) {
  const key = process.env.API_NINJAS_KEY;
  if (!key) throw new Error("API_NINJAS_KEY is missing from the server environment.");
  const [homeTeam, awayTeam] = await Promise.all([
    findApiNinjasTeam(homeName, key),
    findApiNinjasTeam(awayName, key),
  ]);
  const [homeResponse, awayResponse] = await Promise.allSettled([
    apiNinjasJson(`/soccermatches?team=${encodeURIComponent(homeTeam.team_id)}`, key),
    apiNinjasJson(`/soccermatches?team=${encodeURIComponent(awayTeam.team_id)}`, key),
  ]);
  const recent = (result, team) => result.status === "fulfilled"
    ? result.value
      .filter((match) => ["final", "finished", "ft", "full_time"].includes(String(match.status || "").toLowerCase())
        && match.home_score !== null && match.home_score !== undefined
        && match.away_score !== null && match.away_score !== undefined)
      .map(apiNinjasMatchToStandard)
      .filter((match) => match.fixture.timestamp
        && Number.isFinite(match.goals.home) && Number.isFinite(match.goals.away))
      .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
      .slice(0, 5)
      .map((match) => {
        if (String(match.teams.home.id) === String(team.team_id)) match.teams.home.id = team.team_id;
        if (String(match.teams.away.id) === String(team.team_id)) match.teams.away.id = team.team_id;
        return match;
      })
    : [];
  const homeRecent = recent(homeResponse, homeTeam);
  const awayRecent = recent(awayResponse, awayTeam);
  const warnings = [
    ...(homeResponse.status === "rejected" ? [`API Ninjas could not retrieve ${homeTeam.name}'s matches: ${homeResponse.reason?.message || "request failed"}`] : []),
    ...(awayResponse.status === "rejected" ? [`API Ninjas could not retrieve ${awayTeam.name}'s matches: ${awayResponse.reason?.message || "request failed"}`] : []),
    ...(!homeRecent.length && homeResponse.status === "fulfilled" ? [`API Ninjas returned no completed current-season results for ${homeTeam.name}.`] : []),
    ...(!awayRecent.length && awayResponse.status === "fulfilled" ? [`API Ninjas returned no completed current-season results for ${awayTeam.name}.`] : []),
  ];
  return {
    homeRecent,
    awayRecent,
    headToHead: [],
    warnings,
    source: "API Ninjas",
    teamsMatched: { home: homeTeam.name, away: awayTeam.name },
  };
}

const ESPN_LEAGUES = [
  { slug: "eng.2", names: ["championship", "english championship", "efl championship"] },
  { slug: "eng.1", names: ["premier league", "english premier league"] },
  { slug: "eng.3", names: ["league one", "english league one"] },
  { slug: "eng.4", names: ["league two", "english league two"] },
  { slug: "eng.trophy", names: ["efl trophy", "english football league trophy", "football league trophy", "leasing.com trophy", "pizza cup"] },
  { slug: "esp.1", names: ["la liga", "laliga", "primera division"] },
  { slug: "ita.1", names: ["serie a"] },
  { slug: "ger.1", names: ["bundesliga"] },
  { slug: "fra.1", names: ["ligue 1"] },
  { slug: "ned.1", names: ["eredivisie"] },
  { slug: "por.1", names: ["primeira liga", "liga portugal"] },
  { slug: "usa.1", names: ["mls", "major league soccer"] },
];

async function espnJson(path) {
  const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${path}`, {
    next: { revalidate: 1800 },
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`ESPN soccer API returned HTTP ${response.status}`);
  return response.json();
}

function findEspnTeam(teams, targetName) {
  const wanted = normalize(targetName);
  if (!wanted) return null;
  return teams.find((team) => normalize(team.displayName || team.name || team.shortDisplayName) === wanted)
    || teams.find((team) => {
      const candidate = normalize(team.displayName || team.name || team.shortDisplayName);
      return candidate.length > 4 && wanted.length > 4 && (candidate.includes(wanted) || wanted.includes(candidate));
    })
    || null;
}

function espnEventToMatch(event) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find((item) => item.homeAway === "home") || competitors[0];
  const away = competitors.find((item) => item.homeAway === "away") || competitors[1];
  const completed = event.status?.type?.completed === true
    || ["STATUS_FINAL", "STATUS_FULL_TIME"].includes(event.status?.type?.name);
  if (!completed || !home || !away || home.score == null || away.score == null) return null;
  const timestamp = event.date ? Math.floor(Date.parse(event.date) / 1000) : 0;
  if (!timestamp || timestamp < Math.floor((Date.now() - 365 * 86400000) / 1000)) return null;
  const homeScore = Number(home.score);
  const awayScore = Number(away.score);
  if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return null;
  return {
    fixture: { id: event.id, date: event.date, timestamp, status: { short: "FT" } },
    teams: {
      home: { id: home.team?.id, name: home.team?.displayName || home.team?.name },
      away: { id: away.team?.id, name: away.team?.displayName || away.team?.name },
    },
    goals: { home: homeScore, away: awayScore },
  };
}

async function getEspnForm(homeName, awayName, leagueName) {
  const normalizedLeague = normalize(leagueName);
  const league = ESPN_LEAGUES.find((item) => item.names.some((name) => normalizedLeague.includes(normalize(name))));
  if (!league) throw new Error(`No ESPN competition mapping is configured for "${leagueName}".`);
  const directory = await espnJson(`${league.slug}/teams?limit=1000`);
  const teams = (directory.sports || []).flatMap((sport) =>
    (sport.leagues || []).flatMap((entry) => (entry.teams || []).map((item) => item.team || item))
  );
  const homeTeam = findEspnTeam(teams, homeName);
  const awayTeam = findEspnTeam(teams, awayName);
  if (!homeTeam || !awayTeam) {
    throw new Error(`ESPN ${league.slug} team directory could not match both clubs. Home: ${homeTeam?.displayName || "not found"}; Away: ${awayTeam?.displayName || "not found"}.`);
  }
  const [homeSchedule, awaySchedule] = await Promise.all([
    espnJson(`${league.slug}/teams/${encodeURIComponent(homeTeam.id)}/schedule`),
    espnJson(`${league.slug}/teams/${encodeURIComponent(awayTeam.id)}/schedule`),
  ]);
  const matchesFrom = (body) => (body.events || [])
    .map(espnEventToMatch)
    .filter(Boolean)
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
    .slice(0, 5);
  const homeRecent = matchesFrom(homeSchedule);
  const awayRecent = matchesFrom(awaySchedule);
  const h2h = [...(homeSchedule.events || []), ...(awaySchedule.events || [])]
    .map(espnEventToMatch)
    .filter((match) => match && (
      (normalize(match.teams.home.name) === normalize(homeTeam.displayName || homeTeam.name)
        && normalize(match.teams.away.name) === normalize(awayTeam.displayName || awayTeam.name))
      || (normalize(match.teams.home.name) === normalize(awayTeam.displayName || awayTeam.name)
        && normalize(match.teams.away.name) === normalize(homeTeam.displayName || homeTeam.name))
    ))
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
    .slice(0, 5);
  const warnings = [
    ...(!homeRecent.length ? [`ESPN returned no completed recent results for ${homeName}.`] : []),
    ...(!awayRecent.length ? [`ESPN returned no completed recent results for ${awayName}.`] : []),
  ];
  return { homeRecent, awayRecent, headToHead: h2h, warnings, source: "ESPN", teamsMatched: { home: homeTeam.displayName || homeTeam.name, away: awayTeam.displayName || awayTeam.name } };
}

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const homeName = (params.get("homeName") || "").trim();
  const awayName = (params.get("awayName") || "").trim();
  const leagueName = (params.get("league") || "").trim();
  const homeId = (params.get("homeId") || "").trim();
  const awayId = (params.get("awayId") || "").trim();

  if (!homeName || !awayName || !leagueName) {
    return NextResponse.json({ error: "Team names and competition are required for recent form." }, { status: 400 });
  }

  if (normalize(leagueName).includes("npfl") || normalize(leagueName).includes("nigerianpremier")) {
    try {
      const data = await getNpFlForm(homeName, awayName);
      return NextResponse.json(data);
    } catch (error) {
      console.error("GOAL API NPFL recent-form request failed:", error);
      return NextResponse.json({
        error: "GOAL API could not return recent form for this NPFL match.",
        details: [error.message || "Provider request failed."],
        code: "RECENT_FORM_UNAVAILABLE",
      }, { status: 502 });
    }
  }


  // GOAL API is primary. Top up each team's list independently from
  // API-Football whenever GOAL API supplies fewer than five completed games.
  let goalData;
  let goalError = null;
  try {
    goalData = await getGoalApiForm(homeName, awayName, homeId, awayId);
  } catch (error) {
    goalError = error;
    console.error(`GOAL API recent-form request failed for ${leagueName}:`, error);
    goalData = { homeRecent: [], awayRecent: [], headToHead: [], warnings: [], source: "GOAL API" };
  }

  const needsTopUp = goalData.homeRecent.length < 5 || goalData.awayRecent.length < 5;
  if (needsTopUp) {
    // Try both fallback providers independently. A restriction or outage in
    // one provider must not prevent valid results from the other being used.
    // Start with providers that do not consume the tightly rate-limited
    // API-Football quota. Only call API-Football if these sources still leave
    // either club short of five verified completed matches.
    const [footballDataResult, espnResult, apiNinjasResult] = await Promise.allSettled([
      getFootballDataForm(homeName, awayName, leagueName),
      getEspnForm(homeName, awayName, leagueName),
      getApiNinjasForm(homeName, awayName),
    ]);
    const dataFallback = footballDataResult.status === "fulfilled"
      ? footballDataResult.value
      : { homeRecent: [], awayRecent: [], headToHead: [], warnings: [`Football-Data.org: ${footballDataResult.reason?.message || "request failed"}`] };
    const espnFallback = espnResult.status === "fulfilled"
      ? espnResult.value
      : { homeRecent: [], awayRecent: [], headToHead: [], warnings: [`ESPN: ${espnResult.reason?.message || "request failed"}`] };
    const ninjasFallback = apiNinjasResult.status === "fulfilled"
      ? apiNinjasResult.value
      : { homeRecent: [], awayRecent: [], headToHead: [], warnings: [`API Ninjas: ${apiNinjasResult.reason?.message || "request failed"}`] };

    const preliminaryHome = mergeRecentMatches(
      mergeRecentMatches(goalData.homeRecent, dataFallback.homeRecent),
      mergeRecentMatches(espnFallback.homeRecent, ninjasFallback.homeRecent)
    );
    const preliminaryAway = mergeRecentMatches(
      mergeRecentMatches(goalData.awayRecent, dataFallback.awayRecent),
      mergeRecentMatches(espnFallback.awayRecent, ninjasFallback.awayRecent)
    );
    let apiFallback = { homeRecent: [], awayRecent: [], headToHead: [], warnings: [] };
    if (preliminaryHome.length < 5 || preliminaryAway.length < 5) {
      const apiFootballResult = await Promise.allSettled([
        getApiFootballForm(homeName, awayName),
      ]);
      apiFallback = apiFootballResult[0].status === "fulfilled"
        ? apiFootballResult[0].value
        : { homeRecent: [], awayRecent: [], headToHead: [], warnings: [`API-Football: ${apiFootballResult[0].reason?.message || "request failed"}`] };
    }

    const homeRecent = mergeRecentMatches(
      mergeRecentMatches(
        mergeRecentMatches(
          mergeRecentMatches(goalData.homeRecent, apiFallback.homeRecent),
          dataFallback.homeRecent
        ),
        espnFallback.homeRecent
      ),
      ninjasFallback.homeRecent
    );
    const awayRecent = mergeRecentMatches(
      mergeRecentMatches(
        mergeRecentMatches(
          mergeRecentMatches(goalData.awayRecent, apiFallback.awayRecent),
          dataFallback.awayRecent
        ),
        espnFallback.awayRecent
      ),
      ninjasFallback.awayRecent
    );
    let headToHead = goalData.headToHead.length
      ? goalData.headToHead
      : mergeRecentMatches(
          mergeRecentMatches(apiFallback.headToHead, dataFallback.headToHead),
          espnFallback.headToHead
        );
    if (!headToHead.length) {
      try {
        headToHead = await getApiFootballH2H(homeName, awayName);
      } catch (error) {
        console.error(`API-Football H2H fallback failed for ${homeName} vs ${awayName}:`, error);
      }
    }
    const warnings = [
      ...(goalError ? [`GOAL API: ${goalError.message || "No recent results returned."}`] : (goalData.warnings || [])),
      ...(apiFallback.warnings || []),
      ...(dataFallback.warnings || []),
      ...(espnFallback.warnings || []),
      ...(ninjasFallback.warnings || []),
      ...(homeRecent.length < 5 ? [`Only ${homeRecent.length} completed recent matches could be retrieved for ${homeName} from the available providers.`] : []),
      ...(awayRecent.length < 5 ? [`Only ${awayRecent.length} completed recent matches could be retrieved for ${awayName} from the available providers.`] : []),
    ];
    const sources = ["GOAL API"];
    if (apiFallback.homeRecent.length || apiFallback.awayRecent.length) sources.push("API-Football");
    if (dataFallback.homeRecent.length || dataFallback.awayRecent.length) sources.push("Football-Data.org");
    if (espnFallback.homeRecent.length || espnFallback.awayRecent.length) sources.push("ESPN");
    if (ninjasFallback.homeRecent.length || ninjasFallback.awayRecent.length) sources.push("API Ninjas");

    return NextResponse.json({
      ...goalData,
      homeRecent,
      awayRecent,
      headToHead,
      warnings,
      source: sources.join(" + "),
      formNotice: "Recent form combines verified completed results from GOAL API, API-Football, Football-Data.org, ESPN and API Ninjas when available. No unrelated teams or unfinished matches are included. Head-to-head meetings are listed separately.",
    });
  }

  // H2H must be retrieved independently of recent-form top-ups. Both
  // teams can already have five recent matches while the primary H2H feed is empty.
  if (!goalData.headToHead?.length) {
    try {
      const headToHead = await getApiFootballH2H(homeName, awayName);
      if (headToHead.length) goalData = { ...goalData, headToHead };
    } catch (error) {
      console.error(`API-Football H2H fallback failed for ${homeName} vs ${awayName}:`, error);
    }
  }
  return NextResponse.json(goalData);


}
