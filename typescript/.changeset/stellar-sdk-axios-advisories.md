---
"@x402/stellar": patch
---

Require `@stellar/stellar-sdk` `^16.4.1`, the `lts-16` release that bumps `axios` from 1.18.0 to 1.20.0 and clears its seven high-severity advisories. No source change: 16.4.1 differs from 16.3.1 by that one dependency, and `.switch()` / `toXDR()` / `fromXDR()` are unchanged on the 16 line. The floor is raised so no install can resolve 16.3.x again.
