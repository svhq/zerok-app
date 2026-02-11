# Security Policy

ZeroK takes security seriously. This document outlines how to report vulnerabilities and what to expect from the process.

---

## Reporting Vulnerabilities

If you discover a security vulnerability in ZeroK, please report it responsibly via email:

**security@zerok.app**

Please include the following in your report:

- A clear description of the vulnerability
- Steps to reproduce the issue
- The potential impact or severity
- Any suggested remediation (optional but appreciated)

Do **not** open a public GitHub issue for security vulnerabilities.

## Scope

The following components are in scope for security reports:

- **Smart contracts** — On-chain Solana programs governing deposits, withdrawals, and proof verification
- **ZK circuits** — Circom circuits used for zero-knowledge proof generation
- **Frontend application** — The web application at zerok.app
- **SDK and CLI tools** — Any published libraries or command-line utilities
- **Documentation** — Security-relevant errors in protocol documentation

## Response Timeline

| Stage | Timeframe |
|-------|-----------|
| Acknowledgment of report | Within 48 hours |
| Initial assessment and severity classification | Within 1 week |
| Remediation plan communicated to reporter | Within 2 weeks |
| Fix deployed (critical severity) | As soon as possible |
| Fix deployed (other severities) | Within 30 days |

We will keep you informed of progress throughout the process.

## Responsible Disclosure

We kindly ask security researchers to:

- **Allow 90 days** from the initial report before any public disclosure, to give us adequate time to investigate and deploy a fix.
- **Avoid accessing or modifying other users' data** during your research.
- **Act in good faith** to avoid disruption to the protocol or its users.
- **Contact us first** if you believe the 90-day window is insufficient for a particular issue.

We will credit researchers in our security advisories (unless anonymity is preferred).

## Bug Bounty

A formal bug bounty program is **coming soon**. In the interim, we are committed to recognizing and rewarding valid security reports on a case-by-case basis. Details on bounty tiers and reward amounts will be published when the program launches.

## Out of Scope

The following are not eligible for security reports under this policy:

- **Social engineering** — Phishing, pretexting, or other human-targeted attacks
- **Denial of service (DoS)** — Volumetric attacks or resource exhaustion against infrastructure
- **Third-party services** — Vulnerabilities in dependencies, hosting providers, or external APIs not maintained by ZeroK
- **Self-inflicted issues** — Loss of private notes, wallet compromise, or user-side operational errors
- **Already known issues** — Vulnerabilities that have already been reported or are publicly documented

## Contact

For security matters: **security@zerok.app**

For general inquiries, please use the channels listed in the [README](README.md).
