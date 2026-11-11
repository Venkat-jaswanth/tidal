# Deploying Tidal

Tidal is a static site. Nothing has been deployed; this file is the exact procedure.

## Why the headers matter

Windows share the water through a `SharedArrayBuffer`, which browsers only allow on cross-origin
isolated pages. Every response must carry:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Both are already configured: `vercel.json` for Vercel, and `public/_headers` (copied into `dist/`)
for Netlify and Cloudflare Pages. GitHub Pages cannot set headers, so it is not an option. Without
the headers the site still works: windows fall back to copying the water over a BroadcastChannel.

## Build

```bash
npm ci
npm run build        # typechecks, then writes dist/
npm run preview      # serves dist/ on http://localhost:4173 with the same headers
```

## Deploy

Pick one. Each command asks you to log in the first time.

```bash
# Vercel
npx vercel deploy --prod

# Netlify
npx netlify deploy --prod --dir dist

# Cloudflare Pages
npx wrangler pages deploy dist --project-name tidal
```

## Check the deployment

Open the site in Chrome, open the console and run:

```js
crossOriginIsolated   // must be true
```

Then press **+ Vessel**: a second window should open and take a share of the water.

## Social card

The card image is `public/og.png` (1200×630). Card crawlers need an absolute URL, so after the first
deploy replace `/og.png` in the two image meta tags in `index.html` with `https://<your-domain>/og.png`
and deploy again.
