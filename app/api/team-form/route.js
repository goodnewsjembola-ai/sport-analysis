import { NextResponse } from "next/server";
import { getStoredTeamHistory, saveVerifiedMatches } from "../../../lib/match-store.js";

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
    // to the same club across GOAL API, ESPN and API Ninjas.
    .replace(/\bman\s*u\b/g, "manchester united")
    .replace(/\bmanu\b/g, "manchester united")
    .replace(/\butd\b/g, "united")
    .replace(/\bman united\b/g, "manchester united")
    .replace(/\b(fc|cf|afc|club|football club|town)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
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
  const completed = (items, includeOlderMeetings = false, maxResults = 5) => asArray(items)
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
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp).slice(0, maxResults);
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
  // The dedicated GOAL H2H endpoint can be incomplete. Also intersect
  // both clubs' own completed-results feeds to recover meetings independently.
  const teamMeetings = [...homeBody, ...awayBody].filter((match) => {
    const standard = goalFixtureToStandard(match);
    const home = normalize(standard.teams.home.name);
    const away = normalize(standard.teams.away.name);
    return (home === normalize(homeTeam.name) && away === normalize(awayTeam.name))
      || (home === normalize(awayTeam.name) && away === normalize(homeTeam.name));
  });
  const headToHead = mergeH2HMatches(
    completed(h2hBody, true, 100),
    completed(teamMeetings, true, 100)
  );
  if (!homeRecent.length && !awayRecent.length && !headToHead.length) {
    throw new Error(requestWarnings.join(" ") || "GOAL API returned no completed results for either team.");
  }
  return { homeRecent, awayRecent, headToHead,
    warnings: [...requestWarnings, ...(!homeRecent.length ? [`GOAL API has no completed recent results for ${homeTeam.name}.`] : []), ...(!awayRecent.length ? [`GOAL API has no completed recent results for ${awayTeam.name}.`] : [])],
    formNotice: "Recent form uses the latest completed results supplied by GOAL API. Head-to-head meetings are listed separately.",
    source: "GOAL API", teamsMatched: { home: homeTeam.name, away: awayTeam.name } };
}


async function getGoalLeagueHistory(leagueName, homeName, awayName) {
  const key = process.env.GOAL_API_KEY;
  if (!key || !leagueName) return { homeRecent: [], awayRecent: [], headToHead: [], source: null };

  // Resolve the actual competition from GOAL API's league directory instead
  // of assuming every domestic league has a hard-coded provider mapping.
  const wantedLeague = normalize(leagueName);
  let league = null;
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL("https://api.goal-api.com/v1/leagues");
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      next: { revalidate: 1800 },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      throw new Error(body?.error?.message || body?.message || `GOAL API leagues returned HTTP ${response.status}`);
    }
    const data = body?.data ?? body;
    const nested = data?.data ?? data;
    const leagues = Array.isArray(nested) ? nested
      : Array.isArray(nested?.leagues) ? nested.leagues
      : Array.isArray(nested?.items) ? nested.items
      : Array.isArray(nested?.results) ? nested.results : [];
    league = leagues.find((item) => normalize(item.name) === wantedLeague)
      || leagues.find((item) => normalize(item.name).includes(wantedLeague) || wantedLeague.includes(normalize(item.name)))
      || null;
    if (league) break;
    const pagination = body?.pagination || data?.pagination || nested?.pagination;
    if (pagination?.hasMore === false || (!pagination && leagues.length < 100) || !leagues.length) break;
    const nextOffset = Number(pagination?.offset) + Number(pagination?.limit || leagues.length);
    offset = Number.isFinite(nextOffset) && nextOffset > offset ? nextOffset : offset + leagues.length;
  }
  if (!league?.id && !league?.apiId) {
    return { homeRecent: [], awayRecent: [], headToHead: [], source: null, warning: `GOAL API has no matching league entry for "${leagueName}".` };
  }

  const leagueId = league.id || league.apiId;
  const rows = [];
  offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`https://api.goal-api.com/v1/leagues/${encodeURIComponent(leagueId)}/results`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      next: { revalidate: 1800 },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.success === false) {
      throw new Error(body?.error?.message || body?.message || `GOAL API league results returned HTTP ${response.status}`);
    }
    const data = body?.data ?? body;
    const nested = data?.data ?? data;
    const matches = Array.isArray(nested) ? nested
      : Array.isArray(nested?.results) ? nested.results
      : Array.isArray(nested?.matches) ? nested.matches
      : Array.isArray(nested?.items) ? nested.items : [];
    rows.push(...matches);
    const pagination = body?.pagination || data?.pagination || nested?.pagination;
    if (pagination?.hasMore === false || (!pagination && matches.length < 100) || !matches.length) break;
    const nextOffset = Number(pagination?.offset) + Number(pagination?.limit || matches.length);
    offset = Number.isFinite(nextOffset) && nextOffset > offset ? nextOffset : offset + matches.length;
  }

  const targetHome = normalize(homeName);
  const targetAway = normalize(awayName);
  const verified = rows.map(goalFixtureToStandard).filter((match) => {
    const status = String(match.fixture?.status?.short || "").toUpperCase();
    return status === "FT" && match.fixture?.timestamp
      && Number.isInteger(match.goals?.home) && Number.isInteger(match.goals?.away)
      && match.goals.home >= 0 && match.goals.away >= 0
      && match.teams?.home?.name && match.teams?.away?.name;
  }).sort((a, b) => b.fixture.timestamp - a.fixture.timestamp);

  const belongsTo = (match, team) =>
    normalize(match.teams.home.name) === team || normalize(match.teams.away.name) === team;
  const homeRecent = verified.filter((match) => belongsTo(match, targetHome)).slice(0, 5);
  const awayRecent = verified.filter((match) => belongsTo(match, targetAway)).slice(0, 5);
  const headToHead = verified.filter((match) => {
    const h = normalize(match.teams.home.name), a = normalize(match.teams.away.name);
    return (h === targetHome && a === targetAway) || (h === targetAway && a === targetHome);
  }).slice(0, 5);

  return {
    homeRecent, awayRecent, headToHead,
    source: "GOAL API league results",
    warning: rows.length ? null : `GOAL API returned no completed results for ${league.name || leagueName}.`,
  };
}

function mergeRecentMatches(primary, fallback) {
  const seen = new Set();
  return [...(primary || []), ...(fallback || [])]
    .filter((match) => {
      const fixture = match.fixture || {};
      const home = normalize(match.teams?.home?.name);
      const away = normalize(match.teams?.away?.name);
      // Provider fixture IDs are not globally unique. Deduplicate by the
      // actual meeting details so the same match from two feeds appears once.
      const date = fixture.timestamp
        ? new Date(fixture.timestamp * 1000).toISOString().slice(0, 10)
        : String(fixture.date || "").slice(0, 10);
      const identity = `match:${date}:${home}:${away}:${match.goals?.home}-${match.goals?.away}`;
      if (!home || !away || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .sort((a, b) => (b.fixture?.timestamp || 0) - (a.fixture?.timestamp || 0))
    .slice(0, 5);
}

function mergeH2HMatches(...groups) {
  const seen = new Set();
  return groups.flat().filter(Boolean)
    .filter((match) => {
      const fixture = match.fixture || {};
      const home = normalize(match.teams?.home?.name);
      const away = normalize(match.teams?.away?.name);
      const date = fixture.timestamp || fixture.date || "";
      const score = `${match.goals?.home}-${match.goals?.away}`;
      const identity = fixture.id ? `id:${fixture.id}`
        : `match:${date}:${home}:${away}:${score}`;
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
    headToHead: mergeH2HMatches(h2hMatches),
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
  const allNinjaMatches = [
    ...(homeResponse.status === "fulfilled" ? homeResponse.value : []),
    ...(awayResponse.status === "fulfilled" ? awayResponse.value : []),
  ];
  const ninjaMeetings = allNinjaMatches.filter((match) => {
    const home = normalize(match.home_team?.name);
    const away = normalize(match.away_team?.name);
    return (home === normalize(homeTeam.name) && away === normalize(awayTeam.name))
      || (home === normalize(awayTeam.name) && away === normalize(homeTeam.name));
  }).filter((match) => ["final", "finished", "ft", "full_time"].includes(String(match.status || "").toLowerCase())
    && match.home_score != null && match.away_score != null)
    .map(apiNinjasMatchToStandard);
  const warnings = [
    ...(homeResponse.status === "rejected" ? [`API Ninjas could not retrieve ${homeTeam.name}'s matches: ${homeResponse.reason?.message || "request failed"}`] : []),
    ...(awayResponse.status === "rejected" ? [`API Ninjas could not retrieve ${awayTeam.name}'s matches: ${awayResponse.reason?.message || "request failed"}`] : []),
    ...(!homeRecent.length && homeResponse.status === "fulfilled" ? [`API Ninjas returned no completed current-season results for ${homeTeam.name}.`] : []),
    ...(!awayRecent.length && awayResponse.status === "fulfilled" ? [`API Ninjas returned no completed current-season results for ${awayTeam.name}.`] : []),
  ];
  return {
    homeRecent,
    awayRecent,
    headToHead: mergeH2HMatches(ninjaMeetings),
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

function espnEventToMatch(event, includeOlderMeetings = false) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find((item) => item.homeAway === "home") || competitors[0];
  const away = competitors.find((item) => item.homeAway === "away") || competitors[1];
  const completed = event.status?.type?.completed === true
    || ["STATUS_FINAL", "STATUS_FULL_TIME"].includes(event.status?.type?.name);
  if (!completed || !home || !away || home.score == null || away.score == null) return null;
  const timestamp = event.date ? Math.floor(Date.parse(event.date) / 1000) : 0;
  if (!timestamp || (!includeOlderMeetings && timestamp < Math.floor((Date.now() - 365 * 86400000) / 1000))) return null;
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
    .map((event) => espnEventToMatch(event, true))
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
      const npflData = await getNpFlForm(homeName, awayName);
      try {
        const stored = await getStoredTeamHistory(homeName, awayName);
        npflData.homeRecent = mergeRecentMatches(npflData.homeRecent || [], stored.homeRecent || []);
        npflData.awayRecent = mergeRecentMatches(npflData.awayRecent || [], stored.awayRecent || []);
        npflData.headToHead = mergeH2HMatches(npflData.headToHead || [], stored.headToHead || []);
      } catch (storageReadError) {
        console.error("G SPORT NPFL history read failed:", storageReadError);
      }
      let historyStore = { enabled: false, saved: 0, reason: "DATABASE_URL is not configured." };
      try {
        historyStore = await saveVerifiedMatches(
          [...(npflData.homeRecent || []), ...(npflData.awayRecent || []), ...(npflData.headToHead || [])],
          [npflData.source || "GOAL API"]
        );
      } catch (storageError) {
        console.error("G SPORT NPFL history storage failed:", storageError);
        historyStore = { enabled: true, saved: 0, error: storageError?.message || "Database write failed." };
      }
      return NextResponse.json({ ...npflData, historyStore });
    } catch (error) {
      console.error("GOAL API NPFL recent-form request failed:", error);
      return NextResponse.json({
        error: "GOAL API could not return recent form for this NPFL match.",
        details: [error.message || "Provider request failed."],
        code: "RECENT_FORM_UNAVAILABLE",
      }, { status: 502 });
    }
  }

  // G SPORT uses independent data feeds for team history.
  // Each source is isolated so one provider outage cannot discard the others.
  let goalData;
  let goalError = null;
  try {
    goalData = await getGoalApiForm(homeName, awayName, homeId, awayId);
  } catch (error) {
    goalError = error;
    console.error("GOAL API recent-form request failed:", error);
    goalData = { homeRecent: [], awayRecent: [], headToHead: [], warnings: [], source: "GOAL API" };
  }

  const [footballDataResult, espnResult, apiNinjasResult] = await Promise.allSettled([
    getFootballDataForm(homeName, awayName, leagueName),
    getEspnForm(homeName, awayName, leagueName),
    getApiNinjasForm(homeName, awayName),
  ]);
  const dataFallback = footballDataResult.status === "fulfilled" ? footballDataResult.value : { homeRecent: [], awayRecent: [], headToHead: [], warnings: ["Football-Data.org: " + (footballDataResult.reason?.message || "request failed")] };
  const espnFallback = espnResult.status === "fulfilled" ? espnResult.value : { homeRecent: [], awayRecent: [], headToHead: [], warnings: ["ESPN: " + (espnResult.reason?.message || "request failed")] };
  const ninjasFallback = apiNinjasResult.status === "fulfilled" ? apiNinjasResult.value : { homeRecent: [], awayRecent: [], headToHead: [], warnings: ["API Ninjas: " + (apiNinjasResult.reason?.message || "request failed")] };

  const homeRecent = mergeRecentMatches(
    mergeRecentMatches(
      mergeRecentMatches(goalData.homeRecent || [], dataFallback.homeRecent || []),
      espnFallback.homeRecent || []
    ),
    ninjasFallback.homeRecent || []
  );
  const awayRecent = mergeRecentMatches(
    mergeRecentMatches(
      mergeRecentMatches(goalData.awayRecent || [], dataFallback.awayRecent || []),
      espnFallback.awayRecent || []
    ),
    ninjasFallback.awayRecent || []
  );
  let headToHead = mergeH2HMatches(
    goalData.headToHead || [],
    dataFallback.headToHead || [],
    espnFallback.headToHead || [],
    ninjasFallback.headToHead || []
  );

  // G SPORT's own database is another factual source. It supplements current
  // provider responses and preserves history when a provider temporarily has
  // no record; it never supplies third-party predictions.
  try {
    const stored = await getStoredTeamHistory(homeName, awayName);
    homeRecent.splice(0, homeRecent.length, ...mergeRecentMatches(homeRecent, stored.homeRecent || []));
    awayRecent.splice(0, awayRecent.length, ...mergeRecentMatches(awayRecent, stored.awayRecent || []));
    headToHead = mergeH2HMatches(headToHead, stored.headToHead || []);
  } catch (storageReadError) {
    console.error("G SPORT verified-history read failed:", storageReadError);
  }

  const warnings = [
    ...(goalError ? ["GOAL API: " + (goalError.message || "No recent results returned.")] : (goalData.warnings || [])),
    ...(dataFallback.warnings || []),
    ...(espnFallback.warnings || []),
    ...(ninjasFallback.warnings || []),
    ...(homeRecent.length < 2 ? ["Fewer than two verified recent matches are available for " + homeName + "."] : []),
    ...(awayRecent.length < 2 ? ["Fewer than two verified recent matches are available for " + awayName + "."] : []),
  ];
  const sources = [];
  if (goalData.homeRecent?.length || goalData.awayRecent?.length || goalData.headToHead?.length) sources.push("GOAL API");
  if (dataFallback.homeRecent?.length || dataFallback.awayRecent?.length || dataFallback.headToHead?.length) sources.push("Football-Data.org");
  if (espnFallback.homeRecent?.length || espnFallback.awayRecent?.length || espnFallback.headToHead?.length) sources.push("ESPN");
  if (ninjasFallback.homeRecent?.length || ninjasFallback.awayRecent?.length || ninjasFallback.headToHead?.length) sources.push("API Ninjas");

  let historyStore = { enabled: false, saved: 0, reason: "DATABASE_URL is not configured." };
  try {
    historyStore = await saveVerifiedMatches(
      [...homeRecent, ...awayRecent, ...headToHead],
      sources
    );
  } catch (storageError) {
    // Storage must never block verified live facts or G SPORT's own model.
    console.error("G SPORT verified-history storage failed:", storageError);
    historyStore = { enabled: true, saved: 0, error: storageError?.message || "Database write failed." };
  }

  return NextResponse.json({
    ...goalData,
    homeRecent,
    awayRecent,
    headToHead,
    warnings,
    historyStore,
    source: sources.join(" + ") || "No verified source returned data",
    formNotice: "Recent form combines verified completed results from configured football data feeds. Providers supply factual records only; G SPORT calculates its own predictions. No unrelated teams or unfinished matches are included.",
  });
}
