## Summary

Describe the user-visible change and the lifecycle or documentation contract it
affects.

## Verification

- [ ] `npm test`
- [ ] JavaScript files pass `node --check`
- [ ] Shell files pass `bash -n`
- [ ] Site changes pass `npm ci`, `npm run check`, `npm test`, `npm run build`, and `npm run verify` from `site/`
- [ ] `npm pack --dry-run` contains only intended files (the private tarball is not a distribution artifact)
- [ ] Protocol claims cite generated schema or a dated live receipt
- [ ] Provider mutations in tests or probes touched only exact-owned disposable lanes

## Compatibility and safety

- [ ] The `ws`-only dependency budget is unchanged, or the exception is explained
- [ ] Stable host parameters and the `transmogrify` skill slug remain compatible
- [ ] Runtime lifecycle, ownership, harvest, archive, and cleanup effects are documented
- [ ] No credentials, private paths, provider IDs, transcripts, or private development artifacts are included

## Documentation

Link the updated canonical documentation, or explain why no documentation change
is needed.
