# Fonts

Geist and Geist Mono, self-hosted.

## Why these files are committed

The dashboard renders in Geist. This page rendered in the system stack, so
the one screen where someone is asked to **sign a transaction** looked like a
different product from the one they arrived from, and a page that does not
match the product is what people are trained to treat as phishing.

## Why not a CDN

`web/index.html` loads no external resource at all, and a signing surface is
the last place to introduce one. 200 KB of woff2 is a fair price for that.

## Licence

SIL Open Font License 1.1, Copyright (c) 2023 Vercel in collaboration with
basement.studio. `LICENSE.txt` sits beside the fonts because the OFL requires
the notice to travel with the files; redistribution without it is a breach,
and `npm install` putting a copy in `node_modules` does not cover a copy
committed here.

Taken from the `geist` package, version 1.7.0.
