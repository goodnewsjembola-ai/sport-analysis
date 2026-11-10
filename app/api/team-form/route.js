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
    .replace(/\b(fc|cf|afc|club|football club)\b/g, "")
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

async function getApiFootballForm(homeId, awayId) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY is missing from the server environment.");
  if (!/^\d+$/.test(String(homeId || "")) || !/^\d+$/.test(String(awayId || ""))) {
    throw new Error("The fixture did not include valid API-Football team IDs for recent-form lookup.");
  }

  // API-Football requires season whenever the fixtures request includes team.
  // Check the current and previous season, then keep only matches in the
  // rolling one-year window so old results are never presented as recent form.
  const today = new Date();
  const to = today.toISOString().slice(0, 10);
  const recentStart = new Date(today);
  recentStart.setUTCDate(recentStart.getUTCDate() - 365);
  const from = recentStart.toISOString().slice(0, 10);
  const currentSeason = today.getUTCFullYear();
  const seasons = [currentSeason, currentSeason - 1];

  const [homeResponses, awayResponses, h2hData] = await Promise.all([
    Promise.all(seasons.map((season) =>
      apiFootball(`/fixtures?team=${homeId}&season=${season}&from=${from}&to=${to}`, key)
    )),
    Promise.all(seasons.map((season) =>
      apiFootball(`/fixtures?team=${awayId}&season=${season}&from=${from}&to=${to}`, key)
    )),
    apiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}&from=${from}&to=${to}`, key),
  ]);

  const homeRecent = sortApiFootballRecent(homeResponses.flat());
  const awayRecent = sortApiFootballRecent(awayResponses.flat());
  const headToHead = sortApiFootballRecent(h2hData);
  const warnings = [];
  if (!homeRecent.length) warnings.push(`API-Football returned no completed recent fixtures for the home team (ID ${homeId}) in the last 365 days.`);
  if (!awayRecent.length) warnings.push(`API-Football returned no completed recent fixtures for the away team (ID ${awayId}) in the last 365 days.`);
  if (!headToHead.length) warnings.push("API-Football returned no completed head-to-head fixtures in the last 365 days.");

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
  return (teams || []).find((team) => normalize(team.name) === wanted)
    || (teams || []).find((team) => {
      const candidate = normalize(team.name);
      return candidate.length > 4 && wanted.length > 4 && (candidate.includes(wanted) || wanted.includes(candidate));
    })
    || null;
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

  const asArray = (value) => Array.isArray(value) ? value : value?.matches || value?.results || value?.items || [];
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
  // GOAL API search rejects accented characters; strip diacritics before querying.\n  const searchName = String(name || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");\n  const query = new URLSearchParams({ search: searchName, limit: "50" });
  const body = await goalApi(`/teams?${query.toString()}`, key);
  const teams = Array.isArray(body) ? body : body?.teams || body?.items || [];
  return findGoalTeam(teams, name);
}

function goalFixtureToStandard(match) {
  const homeName = match.homeTeamName || match.homeTeam?.name || match.match_hometeam_name;
  const awayName = match.awayTeamName || match.awayTeam?.name || match.match_awayteam_name;
  const homeScore = match.homeTeamFtScore ?? match.homeTeamScore ?? match.match_hometeam_score;
  const awayScore = match.awayTeamFtScore ?? match.awayTeamScore ?? match.match_awayteam_score;
  const kickoff = match.kickoffUtc || match.matchDate || match.match_date;
  const status = String(match.matchStatus || match.match_status || "").toUpperCase();
  const dateText = kickoff ? String(kickoff) : "";
  const timestamp = dateText ? Math.floor(Date.parse(dateText.includes("T") ? dateText : `${dateText}T${match.matchTime || match.match_time || "00:00"}:00Z`) / 1000) : 0;
  return {
    fixture: { id: match.id || match.apiId || match.match_id, date: kickoff, timestamp, status: { short: ["FINISHED", "FT"].includes(status) ? "FT" : status } },
    teams: { home: { id: match.homeTeamId || match.homeTeam?.id || match.match_hometeam_id, name: homeName }, away: { id: match.awayTeamId || match.awayTeam?.id || match.match_awayteam_id, name: awayName } },
    goals: { home: Number(homeScore), away: Number(awayScore) },
  };
}

async function getGoalApiForm(homeName, awayName, homeApiId, awayApiId) {
  const key = process.env.GOAL_API_KEY;
  if (!key) throw new Error("GOAL_API_KEY is missing from the server environment.");
  const [homeTeam, awayTeam] = await Promise.all([findGoalTeamByName(homeName, key), findGoalTeamByName(awayName, key)]);
  if (!homeTeam || !awayTeam) throw new Error(`GOAL API team search could not match both clubs. Home: ${homeTeam?.name || "not found"}; Away: ${awayTeam?.name || "not found"}.`);
  // Keep each provider request independent: a missing/unsupported H2H record
  // must not erase valid recent-form results for either team.
  const [homeRequest, awayRequest, h2hRequest] = await Promise.allSettled([
    goalApi(`/teams/${encodeURIComponent(homeTeam.id)}/results?limit=50`, key),
    goalApi(`/teams/${encodeURIComponent(awayTeam.id)}/results?limit=50`, key),
    goalApi(`/h2h/${encodeURIComponent(homeTeam.id)}/${encodeURIComponent(awayTeam.id)}/direct?limit=50`, key),
  ]);
  const homeBody = homeRequest.status === "fulfilled" ? homeRequest.value : [];
  const awayBody = awayRequest.status === "fulfilled" ? awayRequest.value : [];
  const h2hBody = h2hRequest.status === "fulfilled" ? h2hRequest.value : [];
  const requestWarnings = [
    ...(homeRequest.status === "rejected" ? [`GOAL API could not retrieve results for ${homeTeam.name}: ${homeRequest.reason?.message || "request failed"}`] : []),
    ...(awayRequest.status === "rejected" ? [`GOAL API could not retrieve results for ${awayTeam.name}: ${awayRequest.reason?.message || "request failed"}`] : []),
    ...(h2hRequest.status === "rejected" ? [`GOAL API head-to-head is unavailable: ${h2hRequest.reason?.message || "request failed"}`] : []),
  ];
  const asArray = (value) => Array.isArray(value) ? value : value?.matches || value?.results || value?.items || [];
  const completed = (items) => asArray(items)
    .filter((match) => ["FINISHED", "FT"].includes(String(match.matchStatus || match.match_status || "").toUpperCase())
      && (match.homeTeamFtScore ?? match.homeTeamScore ?? match.match_hometeam_score) !== null
      && (match.awayTeamFtScore ?? match.awayTeamScore ?? match.match_awayteam_score) !== null)
    .map(goalFixtureToStandard)
    .filter((match) => Number.isFinite(match.goals.home) && Number.isFinite(match.goals.away))
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp).slice(0, 5);
  const attachFixtureTeamId = (matches, targetTeam, apiTeamId) => matches.map((match) => {
    if (normalize(match.teams.home.name) === normalize(targetTeam.name)) match.teams.home.id = apiTeamId;
    else if (normalize(match.teams.away.name) === normalize(targetTeam.name)) match.teams.away.id = apiTeamId;
    return match;
  });
  const homeRecent = attachFixtureTeamId(completed(homeBody), homeTeam, homeApiId);
  const awayRecent = attachFixtureTeamId(completed(awayBody), awayTeam, awayApiId);
  const headToHead = completed(h2hBody);
  if (!homeRecent.length && !awayRecent.length && !headToHead.length) {
    throw new Error(requestWarnings.join(" ") || "GOAL API returned no completed results for either team.");
  }
  return { homeRecent, awayRecent, headToHead,
    warnings: [...requestWarnings, ...(!homeRecent.length ? [`GOAL API has no completed recent results for ${homeTeam.name}.`] : []), ...(!awayRecent.length ? [`GOAL API has no completed recent results for ${awayTeam.name}.`] : [])],
    formNotice: "Recent form uses the latest completed results supplied by GOAL API. Head-to-head meetings are listed separately.",
    source: "GOAL API", teamsMatched: { home: homeTeam.name, away: awayTeam.name } };
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
  return teams.find((team) => normalize(team.name) === wanted || normalize(team.shortName) === wanted || normalize(team.tla) === wanted)
    || teams.find((team) => {
      const candidate = normalize(team.name);
      return candidate.length > 4 && wanted.length > 4 && (candidate.includes(wanted) || wanted.includes(candidate));
    })
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


  // GOAL API is primary for non-NPFL recent form; API-Football remains the fallback.
  try {
    const goalData = await getGoalApiForm(homeName, awayName, homeId, awayId);
    if (goalData.homeRecent.length || goalData.awayRecent.length || goalData.headToHead.length) return NextResponse.json(goalData);
    throw new Error(goalData.warnings.join(" ") || "GOAL API returned no completed results.");
  } catch (goalError) {
    console.error(`GOAL API recent-form request failed for ${leagueName}:`, goalError);
    try {
      const fallback = await getApiFootballForm(homeId, awayId);
      return NextResponse.json({ ...fallback, warnings: [`GOAL API fallback: ${goalError.message}`, ...(fallback.warnings || [])], formNotice: `Recent form for ${leagueName} is supplied by API-Football because GOAL API could not return matching results.` });
    } catch (apiError) {
      console.error(`Both recent-form providers failed for ${leagueName}:`, apiError);
      return NextResponse.json({ homeRecent: [], awayRecent: [], headToHead: [], warnings: [`GOAL API: ${goalError.message || "No recent results returned."}`, `API-Football: ${apiError.message || "No recent results returned."}`], formNotice: `Recent form for ${leagueName} could not be retrieved. No older-season or unrelated results are substituted.`, source: "GOAL API + API-Football" });
    }
  }


}
