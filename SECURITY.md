# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on this
repository. Please don't open a public issue for anything exploitable.

This is a one-maintainer portfolio project, not a supported product. Reports are read
and answered on a best-effort basis; there is no response-time commitment, and only
`main` is maintained.

## What is in scope

The README's [Security](README.md#security) section describes the threat model in
full. In short, the parts that matter are:

- **Image decoding.** The library's job is decoding images from untrusted sources, so
  `sharp`/libvips is attack surface. A floor version is pinned for known advisories.
- **The local viewer server** (`npm run ui`). It binds loopback and treats the browser
  as untrusted: Host and Origin checks, JSON-only POSTs, a fixed set of served
  directories, capped bodies. A way past any of those is in scope.
- **Leaking what a photograph carries.** EXIF stripping and the redaction pass.
  Redaction is documented as best-effort; a case where it reports success and leaves
  PII visible is still worth hearing about.
- **The CI and publishing workflows**, which hold a Pages deployment token.

Out of scope: the synthetic fixtures and recorded runs (they contain no real personal
data), and the cost of API calls you choose to make with your own credentials.
