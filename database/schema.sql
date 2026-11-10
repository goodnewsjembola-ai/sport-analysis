-- G SPORT ANALYSIS: verified football history storage
-- Run this once in the Neon SQL Editor for the production branch.

CREATE TABLE IF NOT EXISTS verified_matches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  provider_fixture_id TEXT,
  competition TEXT,
  competition_country TEXT,
  season TEXT,
  played_at TIMESTAMPTZ NOT NULL,
  home_team TEXT NOT NULL,
  home_team_key TEXT NOT NULL,
  away_team TEXT NOT NULL,
  away_team_key TEXT NOT NULL,
  home_goals INTEGER NOT NULL CHECK (home_goals >= 0),
  away_goals INTEGER NOT NULL CHECK (away_goals >= 0),
  source_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_match JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS verified_matches_home_history_idx
  ON verified_matches (home_team_key, played_at DESC);

CREATE INDEX IF NOT EXISTS verified_matches_away_history_idx
  ON verified_matches (away_team_key, played_at DESC);

CREATE INDEX IF NOT EXISTS verified_matches_competition_date_idx
  ON verified_matches (competition, played_at DESC);

CREATE INDEX IF NOT EXISTS verified_matches_provider_fixture_idx
  ON verified_matches (provider_fixture_id)
  WHERE provider_fixture_id IS NOT NULL;
