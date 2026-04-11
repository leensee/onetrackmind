# Security Policy

## Supported Versions

OneTrackMind is currently in active development (Phase 2 of build). Only the latest commit on `main` is supported. No versioned releases have been published yet.

| Version | Supported |
| ------- | --------- |
| main (latest) | ✅ |
| Any prior commit | ❌ |

Once versioned releases begin, this table will be updated to reflect supported versions with security patch coverage.

## Reporting a Vulnerability

This is a private-use project in active development. If you identify a security vulnerability:

**Where to report:**
Open a [GitHub Issue](https://github.com/leensee/onetrackmind/issues) with the label `security`. For sensitive findings that should not be disclosed publicly, contact the repository owner directly via GitHub.

**What to include:**
- Description of the vulnerability and affected component
- Steps to reproduce or proof of concept
- Potential impact assessment
- Any suggested remediation if known

**What to expect:**
- Acknowledgment within 5 business days
- Status update within 14 days of submission (accepted, declined, or deferred with reasoning)
- If accepted: a fix will be prioritized based on severity. Critical issues targeting deployment blockers (auth, RLS, encryption, remote wipe) will be addressed before any production deployment
- If declined: a clear explanation of why the finding does not meet the threshold for remediation

**Scope:**
Security findings are in scope for all components of this repository including the Node.js/TypeScript backend, Flutter app, Supabase schema and RLS policies, and any infrastructure configuration. Out of scope: third-party dependencies (report those upstream), and findings that require physical access to a device.
