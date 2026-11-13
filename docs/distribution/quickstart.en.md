# Mosaic for Windows

Mosaic puts web panes and AI chats in one workspace. This preview supports **English and Korean**. It starts in Korean on Korean systems and English otherwise. Change this under **Mosaic settings → Language**. The choice is saved; websites, existing names, messages, and your writing are not translated.

## Install and start

Run `Mosaic-0.7.5-win-x64-setup.exe`, or extract the entire `Mosaic-0.7.5-win-x64-portable.zip` and run `Mosaic.exe`. Save your work and close Mosaic before upgrading. Both formats keep user data in `%APPDATA%\MosaicBrowser`; uninstalling the app preserves it. Current builds are unsigned previews and may trigger Windows download or execution warnings. Managed computers may block them.

1. Add a pane and sign in directly on the website. Different panes can keep separate accounts.
2. Install the official Claude Code or Codex CLI and sign in with your own account. Provider pricing and limits apply.
3. Create an AI chat, choose its provider, model and allowed panes, then send a request. Stop it or take over at any time. Handle sign-ins, verification codes and payments yourself.

A finished AI response does not prove the task succeeded on the site. Check results yourself. Some websites require the separate Chrome connection.

## Data and privacy

Site permission decisions, such as notifications and location, are remembered for that pane and site during the current app run. Repeated requests reuse your choice. Approvals are not shared with other panes, profiles or sites, and microphone approval does not grant camera access. The app may ask again after restart; choices are not written to disk or sent to analytics.

Workspace names, addresses, layouts and AI conversations are stored locally; workspace and chat JSON files are not encrypted. Stored passwords use Windows encryption and are unavailable to AI tools. Browser profiles contain cookies and other site storage. Do not publish or attach your complete data folder to an issue.

**Local usage counts** are off by default. If enabled, only numeric activity counts are kept for up to 90 days. Turning this off clears those counts. They are not uploaded automatically.

**Optional usage counting** requires separate consent and is off by default. The official beta uses PostHog US; the region is also shown in settings. Consenting installations send one activity event per UTC day with a random installation ID, time, app version, OS, CPU architecture and consent-policy version. No URLs, browsing history, conversations, accounts, passwords or screenshots are included; person profiles and GeoIP are disabled. The receiving server can see the connection's IP address. Opting out stops new sends and clears the local ID, but does not automatically delete events already received. Re-enabling or reinstalling can count as a new installation.

The operator is **Inkee1 / Mosaic**. Analytics is accessible through the operator's authenticated project, with no public sharing of installation IDs. The project's default event retention is 12 months, verified on November 13, 2026; PostHog currently schedules its first default-retention cleanup from March 3, 2027. Deletion follows that schedule, not an immediate or exact 12-month deadline. Send deletion questions to tensordev9@gmail.com. Email addresses are not linked to installation IDs, so an email alone may not identify a record. Do not send your full data folder.

During AI tasks, selected page content and screenshots may be sent to your chosen AI provider. A diagnostic export contains only runtime/system versions and numeric counts, not URLs, chats, credentials or personal file paths. Review it before sharing.

## Support and terms

Use **Mosaic settings → Contact support**, or email **tensordev9@gmail.com**. Send the version and steps to reproduce the problem; omit passwords, cookies and tokens.

Source is available under [PolyForm Noncommercial 1.0.0](../../LICENSE.md). Read the license for permitted uses and exceptions. The source is not offered under an OSI open-source license. The official repository is [Inkee1/mosaic](https://github.com/Inkee1/mosaic); downloads are listed under [Releases](https://github.com/Inkee1/mosaic/releases). This beta is unsigned: Windows may display an unknown-publisher or SmartScreen warning. Check the official download and SHA-256 before running; managed computers may block unsigned apps.
