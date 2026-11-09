# G SPORT ANALYSIS

**Football Intelligence. Data-Driven Predictions.**

A free football analytics and prediction platform designed to make match data easier to understand.

## Current foundation
- Premium black-and-gold interface with subtle green accents
- Responsive match-centre layout and search
- Multiple prediction-market categories
- Server-side configuration health check
- Secure environment-variable pattern for API-Football

## Run locally
1. Install Node.js (LTS).
2. Run `npm install`.
3. Copy `.env.example` to `.env.local` and add your API-Football key.
4. Run `npm run dev`.
5. Open `http://localhost:3000`.

## Environment variables
Set `API_FOOTBALL_KEY` in `.env.local` and in Vercel Project Settings → Environment Variables.

**Security:** Never place the key in a file under `public`, browser code, or a committed source file. Do not share the key in chat.

## Important
The current match-centre entries are clearly labelled placeholders. Live fixtures and statistical predictions are not active until the data integration and prediction engine are implemented and tested.

Predictions are statistical estimates, not guarantees. The platform should display methodology and historical performance transparently.
