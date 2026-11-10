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

  const [homeData, awayData, h2hData] = await Promise.all([
    apiFootball(`/fixtures?team=${homeId}&last=10&status=FT`, key),
    apiFootball(`/fixtures?team=${awayId}&last=10&status=FT`, key),
    apiFootball(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, key),
  ]);

  const homeRecent = sortApiFootballRecent(homeData);
  const awayRecent = sortApiFootballRecent(awayData);
  const headToHead = sortApiFootballRecent(h2hData);

  return {
    homeRecent,
    awayRecent,
    headToHead,
    warnings: [],
    formNotice: "Recent form uses each team's latest completed matches across competitions from API-Football. Head-to-head meetings are listed separately. Availability depends on the competition and API plan.",
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
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Football-Data.org is not configured on the server." }, { status: 503 });
  }

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


  const isInternationalCompetition = API_FOOTBALL_INTERNATIONAL.some((name) =>
    normalize(leagueName).includes(normalize(name))
  );

  if (isInternationalCompetition) {
    try {
      const data = await getApiFootballForm(homeId, awayId);
      return NextResponse.json(data);
    } catch (error) {
      console.error("API-Football international recent-form request failed:", error);
      return NextResponse.json({
        homeRecent: [], awayRecent: [], headToHead: [],
        warnings: [error.message || "API-Football could not return international recent form."],
        formNotice: "International recent form could not be retrieved. No older-season or unrelated results are substituted.",
        source: "API-Football",
      });
    }
  }

  const competition = COMPETITIONS.find((item) =>
    item.names.some((name) => normalize(leagueName).includes(normalize(name)) || normalize(name).includes(normalize(leagueName)))
  );

  if (!competition) {
    try {
      const data = await getApiFootballForm(homeId, awayId);
      return NextResponse.json(data);
    } catch (error) {
      return NextResponse.json({
        homeRecent: [], awayRecent: [], headToHead: [],
        warnings: [`Recent form is not available from Football-Data.org for ${leagueName}, and API-Football fallback failed: ${error.message || "provider error"}`],
        formNotice: "No older-season or unrelated results are substituted when current recent form is unavailable.",
        source: "API-Football fallback",
      });
    }
  }

  try {
    const teamsData = await footballData(`/competitions/${competition.code}/teams`, token);
    const teams = teamsData.teams || [];
    const homeTeam = findTeam(teams, homeName);
    const awayTeam = findTeam(teams, awayName);

    if (!homeTeam || !awayTeam) {
      return NextResponse.json({
        homeRecent: [],
        awayRecent: [],
        headToHead: [],
        warnings: [`Could not match both teams to the ${competition.code} team list.`],
        formNotice: "Current recent form is only shown when both teams can be matched to the provider's competition records. No old data is substituted.",
        source: "Football-Data.org",
      });
    }

    const [homeData, awayData] = await Promise.all([
      footballData(`/teams/${homeTeam.id}/matches?status=FINISHED&limit=30`, token),
      footballData(`/teams/${awayTeam.id}/matches?status=FINISHED&limit=30`, token),
    ]);

    const sortRecent = (items) => (items || [])
      .filter((match) => match.status === "FINISHED" && match.score?.fullTime?.home !== null && match.score?.fullTime?.away !== null)
      .sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate))
      .slice(0, 5);

    const homeMatches = sortRecent(homeData.matches);
    const awayMatches = sortRecent(awayData.matches);
    const awayIds = new Set(awayMatches.map((match) => match.id));
    const meetings = (homeData.matches || [])
      .filter((match) => awayIds.has(match.id) && match.status === "FINISHED")
      .sort((a, b) => Date.parse(b.utcDate) - Date.parse(a.utcDate))
      .slice(0, 5);

    return NextResponse.json({
      homeRecent: homeMatches.map(convertMatch),
      awayRecent: awayMatches.map(convertMatch),
      headToHead: meetings.map(convertMatch),
      warnings: [],
      formNotice: "Recent form uses each team's latest completed matches available from Football-Data.org. Coverage depends on the competition and provider records.",
      source: "Football-Data.org",
      teamsMatched: { home: homeTeam.name, away: awayTeam.name },
    });
  } catch (error) {
    console.error("Football-Data.org recent-form request failed:", error);
    return NextResponse.json({
      error: "Football-Data.org could not return recent form for this match.",
      details: [error.message || "Provider request failed."],
      code: "RECENT_FORM_UNAVAILABLE",
    }, { status: 502 });
  }
}
