// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://transmogrify.sh',
  output: 'static',
  trailingSlash: 'never',
  compressHTML: true,
  devToolbar: { enabled: false },
  integrations: [
    sitemap({
      // Workers Static Assets serves `/foo/index.html` at `/foo`; keep one URL shape.
      serialize: (item) => ({ ...item, url: item.url.replace(/(.)\/$/, '$1') }),
    }),
  ],
  build: {
    inlineStylesheets: 'auto',
    assets: '_astro',
  },
  vite: {
    // The site reads the repository's canonical Markdown at build time.
    server: { fs: { allow: ['..'] } },
    build: {
      cssMinify: true,
      minify: 'esbuild',
      sourcemap: false,
      assetsInlineLimit: 0,
    },
  },
});
