# Tour Planner

**In Qloo's data, Phyno has fan data for 1 area of London. Burna Boy has 1,579.** Most rising African artists are in Phyno's position: too small for the data that tour planning needs. This agent fills the gap with the closest similar artist who has enough data, and it always says when it does that.

**Live demo:** https://tour-planner.fpl-test.workers.dev
Try "Phyno" in London (thin data, so it uses a proxy) or "Wizkid" in Toronto (own data).

## The problem

A manager or promoter for a rising African artist wants to plan a first show in a diaspora city such as London, Houston or Toronto. Today they choose the area, the venue and the opening act by guesswork and personal contacts. A general AI chat cannot help much here. It does not know where in London Phyno's kind of fans cluster, or which West African restaurants and lounges draw that crowd.

## What it does

You type an artist and pick a city. The agent:

1. **Confirms the artist.** If the name is ambiguous ("Ice"), it shows the Qloo matches and asks you to pick one. It never guesses.
2. **Maps where fans of this kind of music cluster** (Qloo heatmap). If the artist has fewer than 200 areas of data in that city, it uses the closest similar artist who has enough, and labels the map as proxy data.
3. **Lists places that match the artist's fans** (Qloo places), and marks the ones Qloo lists with live music or event space.
4. **Suggests opening acts** in two separate lists: artists who share fans, and Afrobeats artists distinctive to that city's audience. Artists Qloo marks as no longer performing (for example Dagrin, d. 2010) are left out, and the plan says so.
5. **Writes a short plan.** Every section carries a source tag: *Artist data*, *Proxy data*, or *AI summary*.

## Why Qloo is the core, not a bolt-on

Every fact in the plan is a Qloo answer. Claude only orders the steps, asks for confirmation, and writes the summary from the tool results. If you remove Qloo, nothing is left to plan with.

| Step | Qloo endpoint | Key parameters |
|---|---|---|
| Find the artist | `GET /search` | `query`, `types=urn:entity:artist` |
| Fan overlap | `GET /v2/insights` | `filter.type=urn:entity:artist`, `signal.interests.entities` |
| Fan map | `GET /v2/insights` | `filter.type=urn:heatmap`, `signal.interests.entities`, `filter.location.query` |
| Matching places | `GET /v2/insights` | `filter.type=urn:entity:place`, `signal.interests.entities`, `filter.location.query` |
| City's own scene | `GET /v2/insights` | `filter.type=urn:entity:artist`, `signal.location.query`, `filter.tags=urn:tag:genre:music:afrobeats` |

The plan page has a "Show the Qloo requests behind this plan" panel that lists every request used.

## Example: request to result (Phyno, London)

1. `/search` for "Phyno" → one exact match. No question needed.
2. Heatmap for Phyno in London → **1 area**. That is below the 200-area minimum.
3. Fan overlap for Phyno → Ajebutter22, M.I. Abaga, Sarkodie, … in Qloo's order. Heatmap for Ajebutter22 in London → **234 areas**. Ajebutter22 becomes the proxy, and the map is labelled "Proxy data".
4. Places matched to Phyno's fans in London → 10 places, all West African or African restaurants. 6 have live music or event space.
5. Opening acts → 9 active artists with shared fans. Dagrin is left out because Qloo marks his `end_year` as 2010.
6. Claude writes the plan from these results only: 3 model calls, about 26 seconds for a fresh plan.

## Does the proxy work? (tested before building)

We hid the real map of artists who do have data, picked their proxy, and compared the two maps. Each pass rule was written into the test script before the run (see `scripts/`).

| Test | Result |
|---|---|
| Big proxies, London (`scripts/proxy.mjs`) | Tems → Snoh Aalegra: **10 of 10** top areas inside Tems's real top 30. Wizkid → Davido: **10 of 10**. Control (Taylor Swift): 3 of 10. |
| Same, Houston and Toronto | 9 or 10 of 10. Control: 0 to 5 of 10. |
| Small proxies, 200–400 areas (`scripts/proxy-small.mjs`) | **10 of 10** cases passed (9 or 10 of 10 each), across Tems, Wizkid, Burna Boy and Davido in 3 cities. |
| Does Qloo know Nigeria? (`scripts/coverage.mjs`) | Search found 22 of 23 Nigerian test items (artists, Nollywood films, TV shows, books, brands). Control: 8 of 8. |

## Known limits

- **The map shows where fans of this kind of music cluster, not one artist's own fans.** In the small-proxy test, every similar artist matched almost equally well (9.5 to 10 of 10 on average across 53 candidates). The proxy choice matters less than the label suggests.
- **The proxy test checks agreement with Qloo's own maps, not ticket sales.** Similarity and heatmaps may share the same taste data, so some agreement may be built in.
- **Qloo cannot rank cities abroad for an artist**, so the user picks the city. In our test, ranking artists by city gave empty results for most cities, even for Taylor Swift.
- **"Places" are mostly restaurants and lounges, not concert halls.** They are useful for listening events and promotion. The live-music and event-space flags do not show capacity or availability.
- **Qloo does not mark every artist who stopped performing.** Fela Kuti (d. 1997) has no `end_year`. The plan tells the user to check each suggested artist.
- **Name search is global.** "Ice" returns Ice Cube and Iceage, not Ice Prince. Type the full name.
- **Qloo describes what groups with shared taste like.** It says nothing about one person, and nothing about ticket sales.
- **Cross-category links are weak for Nigerian artists.** "Fans of Burna Boy also like these films" gave US sports dramas and Indian films, with no Nollywood. The product does not use music-to-film links for that reason.

## How it is built

- **Cloudflare Worker** (`src/index.js`) serves the page and the API. The Qloo and Claude keys are Worker secrets. They never reach the browser.
- **Qloo client** (`src/qloo.js`): one try per request (20 s limit), a private server-side cache (D1, 7 days), and a daily cap on Qloo calls. No Qloo data is stored in this repo.
- **Qloo tools** (`src/tools.js`): `resolve_artist`, `similar_artists`, `fan_map`, `fan_places`, `opening_acts`.
- **Claude agent loop** (`src/agent.js`): Claude Opus 5.5 with tool use. The loop is bounded: at most 6 model calls per plan, each counted against a daily cap. The plan comes back through a strict `submit_plan` tool, so every section has a source tag. Map cells stay on the server; the model sees only summaries.
- **Page** (`public/`): plain HTML, CSS and JS, with Leaflet and OpenStreetMap tiles. API text is inserted as text, never as HTML.
- **Cost limits:** 30 requests per minute per IP, 1,500 Qloo calls and 150 Claude calls per day. Finished plans are cached for a day, so repeat demos cost nothing.

Note: Qloo's hackathon kit offers `qloo mcp`, but it does not support serverless hosts. This project calls the Qloo REST API directly from the Worker.

## Run it yourself

You need Node.js 22+, a Cloudflare account, a Qloo hackathon API key, and an Anthropic API key.

```bash
git clone https://github.com/dannwaneri/tour-planner.git
cd tour-planner
npm install
npm test
```

Local run:

```bash
cp .dev.vars.example .dev.vars   # then paste your two keys into .dev.vars
npm run db:local
npm run dev
```

Deploy:

```bash
npx wrangler d1 create tour-planner   # put the new database_id in wrangler.jsonc
npx wrangler d1 migrations apply tour-planner --remote
npx wrangler deploy
npx wrangler secret put QLOO_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
```

The test scripts in `scripts/` call Qloo directly. Set `QLOO_API_KEY` in your shell first. With no key they do a dry run and only print the requests. Their output goes to `results/`, which git ignores.

## License

MIT. See [LICENSE](LICENSE).
