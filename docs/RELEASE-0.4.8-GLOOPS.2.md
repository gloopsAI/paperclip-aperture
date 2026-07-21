# paperclip-aperture 0.4.8-gloops.2

This Gloops deployment pairs personal Focus projection with an authenticated
actor context supplied by the Paperclip plugin host.

## Paired-host requirement

Do not install this build on stock Paperclip `2026.707.0`. Its personal data
and action handlers require the immutable actor context introduced by
`gloopsAI/paperclip` PR #117 (merge commit
`254218812b299b3ccd562daa832fbab298a0642f`). The plugin fails closed when that
context is absent, but the manifest's upstream host version cannot distinguish
the patched Gloops artifact from stock `2026.707.0`.

Promotion therefore requires one deployment receipt containing both:

1. the exact Paperclip container digest built from merge commit
   `254218812b299b3ccd562daa832fbab298a0642f`; and
2. the exact Aperture bundle commit and `0.4.8-gloops.2` manifest/package
   version installed on that host.

The host must be deployed first. Only then may this plugin build be installed
and its signed-in two-user isolation canary run.

## Personal-action guarantees

- personal Focus reads require trusted authenticated-user context;
- issue actions are authorized against fresh host issue ownership;
- cross-user task, interaction, comment, acknowledgement, and seen writes fail
  closed;
- viewer review updates are serialized by company; and
- failed-run diagnostics and terminal approvals remain available in operational
  exports but do not appear as personal actions.
