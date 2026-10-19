# Release procedure

## Candidate preparation

Keep releases in draft until the separate publishing step is explicitly requested.
For v0.2.0, the candidate includes the xterm migration, installation compatibility
changes and correctness fixes since v0.1.0. The 0.1.1 changes were not separately
published. Local artifacts live in ignored `release-artifacts/v0.2.0/`.

1. Update package.json and CHANGELOG.md; build the committed browser bundle.
2. Run `npm run build`, `npm test` and `npm run test:browser`. Use
   `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if the installed Playwright browser is unavailable.
3. Commit only release sources, tests, docs and generated browser output. Exclude
   local Claude settings, dependencies, transcripts and release artifacts.
4. Push the candidate branch and open a draft PR against main. Wait for all
   required Node 22/24/26 CI jobs to pass on the exact candidate commit.
5. Run `npm pack --json --pack-destination release-artifacts/v0.2.0/`.
   Unpack the archive into a temporary directory, verify its manifest version,
   server imports, generated client and third-party notices, and ensure no local
   settings, node_modules, transcripts or release artifacts entered the package.
6. Generate release notes, a publishing checklist, provenance (source commit,
   package integrity, verification and CI links), and SHA256SUMS. Create or update
   only the matching draft GitHub Release, targeting the full candidate SHA.
   Upload the archive and those materials, then download and verify their hashes.

## Separate official publishing step

The following steps are prepared for a later, explicitly authorized publication;
creating the draft does not run them.

1. Merge the verified PR. Check out the final main commit with a clean working
   tree and ensure package.json still declares the intended release version.
2. Rebuild, rerun the tests, pack the final main commit and regenerate provenance
   and checksums. Verify the unpacked package, replace the draft assets and set
   its target to that exact final commit before creating/pushing the version tag.
3. Check account access using `npm whoami --registry=https://registry.npmjs.org`
   and inspect existing versions with
   `npm view dsh-shell-command versions --json --registry=https://registry.npmjs.org`.
   Sign in or complete OTP interactively if required; do not store credentials
   or OTP values in scripts, release notes, PRs or provenance.
4. From the final artifact directory, verify `shasum -a 256 -c SHA256SUMS`, then
   publish the verified archive:

   ```sh
   npm publish ./dsh-shell-command-0.2.0.tgz --access public --tag latest --registry=https://registry.npmjs.org
   ```

5. Verify npm's version, integrity and latest tag against the final archive.
   Publish the matching GitHub draft with
   `gh release edit v0.2.0 --repo CHplus0/dsh-shell-command --draft=false --latest`.
6. Confirm the public release, assets and a clean installation. If npm publishing
   succeeded but the GitHub step failed, retry only the GitHub step; never try to
   republish the same npm version. If a version is already occupied by a different
   artifact, stop and choose a new version through a separate release decision.

All npm publication commands explicitly select the official registry. They do
not change the user's global npm mirror configuration. Preserve optional htop
and untested Windows disclosures in the final release notes.
