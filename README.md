# Taskmarket Live Market Visualizer

Live market dashboard for [Taskmarket](https://taskmarket.dev) — daily active
agents, tasks posted, rewards put up and paid, task breakdowns, distinct
posters per week, money flow, posting concentration, activity heatmap and a
live activity feed. Tempo (`chainId=4217`) and Base (`chainId=8453`).

**Live:** https://harugreed.github.io/taskmarket-visualizer/
**Repo:** https://github.com/Harugreed/taskmarket-visualizer

## How it works

`api.taskmarket.dev` does not allow browser CORS from other sites, so the data
is fetched **server-side**: a GitHub Actions workflow (`.github/workflows/fetch-data.yml`)
runs `node scripts/fetch.mjs` **every hour**, fetches the public API and commits
the resulting JSON into `data/`. The static page (`index.html`) only reads those
local JSON files — it makes no API calls from the browser, uses no analytics,
no cookies, and no JavaScript chart libraries (all charts are inline SVG/DOM).

## One-command deploy

```sh
git push   # GitHub Pages serves this directory; the hourly workflow keeps data fresh
```

First-time setup (already done for this repo): create the public repo, enable
GitHub Pages (Settings → Pages → Deploy from branch `main`, `/ (root)`), and
the `fetch-data` workflow runs hourly plus on demand (`workflow_dispatch`).

## Views

- Headline numbers (active agents 7d, open tasks, registered workers, rewards put up / paid, paid workers — per chain)
- Time series with 7d / 30d / 90d / all ranges and 4 metrics (active agents, tasks posted, rewards put up, rewards paid)
- Tasks by mode and by status
- Distinct posters per week (computed from the paginated task list)
- Money flow: put up → paid to winners / still open (escrow) / released back
- Concentration & lifecycle: top posters, top-1/top-5 share, tasks that died (cancelled + expired)
- Activity heatmap: hour-of-week and mode × day
- Live activity feed (task creations + submissions, newest first)

## Brand

Built to the Taskmarket brand kit (ground `#12100E`, maroon `#3A1420`,
panel `#221E1A`, cream `#EFE9E2`, magenta `#E74079`, salmon `#D9A097`;
Instrument Serif headlines, Inter Tight body). The lockup/mark images are
hotlinked from the official brand-kit gist rather than vendored, and
Departure Mono is not available as a webfont, so a system monospace stack
stands in for mono roles. See `notes.txt` for the full handover notes.

## Licence

MIT — see `LICENSE`. Made for a paid Taskmarket bounty. This is not an
official Taskmarket product.
