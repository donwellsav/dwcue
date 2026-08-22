# Code signing

DonWells Cue's macOS installers are **signed and notarized**; Windows and Linux
artifacts are currently unsigned. This file tracks the signing status of each
platform and contains the wiring so that keeping signing on is a matter of
keeping secrets in place — not re-engineering the release pipeline.

> **Status (August 2026)**
> - **Windows:** SignPath.io open-source certificate **applied for**. Wiring
>   below is staged but inert (no secrets configured → release stays unsigned).
> - **macOS:** **signed + notarized** (Developer ID Application, team
>   `SSX53S943P`). Active since all five secrets below exist on the repo —
>   `electron-builder.config.js` flips signing on when `MAC_SIGNING=true`
>   (set by the workflow when the `MAC_CSC_*` secrets are present). Ad-hoc
>   fallback for forks/local builds is unchanged.
> - **Linux:** AppImage/deb/rpm are unsigned (normal for these formats).

Nothing in this document changes the current build. The release workflow
([.github/workflows/build-release.yml](.github/workflows/build-release.yml))
continues to publish unsigned artifacts whenever the secrets named below are
absent.

---

## Windows — SignPath (Authenticode)

[SignPath.io](https://signpath.io) offers free code signing for OSS projects.
It signs **Windows** artifacts only (Authenticode); it does **not** sign or
notarize macOS apps — see the macOS section for that.

### Integration model

SignPath uses a "submit unsigned artifact → SignPath signs it → download the
signed artifact" flow via the official
[`signpath/github-action-submit-signing-request`](https://github.com/SignPath/github-action-submit-signing-request)
action, documented at
<https://docs.signpath.io/trusted-build-systems/github>.

The unsigned NSIS installer is already uploaded by the Windows matrix job as the
`windows-build` artifact, so a signing job can consume it directly.

### One-time SignPath portal setup

1. Once the OSS certificate is approved, create a **Project** in SignPath (slug,
   e.g. `dwcue`).
2. Add an **Artifact configuration** that matches the NSIS installer
   (`DonWells Cue-Setup-*.exe`).
3. Create a **Signing policy** (e.g. `release-signing`) bound to the
   Authenticode certificate.
4. Register GitHub as a **Trusted Build System** and link this repository so
   SignPath can verify the artifact's origin.

### GitHub secrets / variables to add (none exist yet → wiring stays inert)

| Name | Kind | Value |
|------|------|-------|
| `SIGNPATH_API_TOKEN`        | secret   | SignPath CI user API token |
| `SIGNPATH_ORGANIZATION_ID`  | variable | SignPath organization GUID |
| `SIGNPATH_PROJECT_SLUG`     | variable | e.g. `dwcue` |
| `SIGNPATH_POLICY_SLUG`      | variable | e.g. `release-signing` |

### Ready-to-enable job

Paste this into [.github/workflows/build-release.yml](.github/workflows/build-release.yml)
**after** the `build` job once SignPath is approved and the secrets above are
set. Until then it is intentionally left out of the workflow so unsigned
releases keep working.

```yaml
  sign-windows:
    needs: build
    runs-on: ubuntu-latest
    # Self-disables until the SignPath token secret is present, so forks and
    # the pre-approval period keep publishing unsigned builds without failing.
    if: ${{ needs.build.result == 'success' }}
    steps:
      - name: Guard — skip when SignPath is not configured
        id: guard
        run: |
          if [ -n "${{ secrets.SIGNPATH_API_TOKEN }}" ]; then
            echo "enabled=true" >> "$GITHUB_OUTPUT"
          else
            echo "enabled=false" >> "$GITHUB_OUTPUT"
            echo "SignPath not configured — leaving Windows build unsigned."
          fi

      - name: Download unsigned Windows artifact
        if: steps.guard.outputs.enabled == 'true'
        id: dl
        uses: actions/download-artifact@v4
        with:
          name: windows-build
          path: ./windows-unsigned

      - name: Submit signing request to SignPath
        if: steps.guard.outputs.enabled == 'true'
        uses: signpath/github-action-submit-signing-request@v1
        with:
          api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
          organization-id: ${{ vars.SIGNPATH_ORGANIZATION_ID }}
          project-slug: ${{ vars.SIGNPATH_PROJECT_SLUG }}
          signing-policy-slug: ${{ vars.SIGNPATH_POLICY_SLUG }}
          github-artifact-id: ${{ steps.dl.outputs.artifact-id }}
          wait-for-completion: true
          output-artifact-directory: ./windows-signed

      - name: Re-upload signed Windows artifact
        if: steps.guard.outputs.enabled == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: windows-build
          overwrite: true
          path: ./windows-signed/**
```

The `release` job already downloads `windows-build`; with the signed re-upload
above it would attach the signed `.exe` automatically. No other release-step
changes are required.

---

## macOS — Apple notarization (separate from SignPath)

SignPath cannot sign macOS apps. Removing the "DonWells Cue is damaged" Gatekeeper
prompt requires Apple's own chain:

1. An **Apple Developer Program** membership (paid).
2. A **Developer ID Application** certificate (exported `.p12`).
3. Notarization via Apple's notary service (electron-builder uses
   [`@electron/notarize`](https://github.com/electron/notarize)).

The hardened runtime, entitlements and notarization settings are already in
[client/package.json](client/package.json) (gated through
[client/electron-builder.config.js](client/electron-builder.config.js)), and the
release workflow maps the signing secrets onto electron-builder's `CSC_*`
environment. The secrets (all present as of 2026-08-22):

- `MAC_CSC_LINK` — the Developer ID Application certificate exported as `.p12`
  (base64, single line).
- `MAC_CSC_KEY_PASSWORD` — the `.p12` password.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` — notarization
  credentials.

Regenerating the certificate: create a CSR (`openssl req -new -newkey rsa:2048
-nodes -keyout devid.key -out devid.csr -subj "/CN=<name>"`), upload it under
developer.apple.com → Certificates → Developer ID Application, then
`openssl pkcs12 -export -legacy -out devid.p12 -inkey devid.key -in devid.cer` and
update `MAC_CSC_LINK`/`MAC_CSC_KEY_PASSWORD`.

The `-legacy` flag is required: OpenSSL 3's default PBES2/AES-256 PKCS#12
encryption is rejected by macOS `security import` with a misleading
"MAC verification failed during PKCS12 import" error.
