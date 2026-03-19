# Internal Guide: Gmail Alias Revenue Import

## Purpose
Use this guide to onboard and support customers for the Gmail revenue import flow.

## How The Flow Works
1. Customer sends an email to one shared Gmail mailbox alias:
`<base>+<organizationId>+<costCenterId>@gmail.com`
2. Importer scans `INBOX` for matching subject and date window.
3. Importer parses alias tokens and routes message into label:
`<organizationId>/<costCenterId>`
4. Importer processes all labels under `<organizationId>/*`.
5. Cost center is always taken from alias `costCenterId` token.
6. Pipeline validates cost center against JobDone using configured `costCenterMappingField` (`name`, `customId`, `customId2`, `customId3`).

## Important Decisions (Current)
1. Reprocessing in the lookback window is intentional and allowed.
2. Date extraction is config-driven via `dateExtractionRegex` and `dateFormat`.
3. For filenames like `..._20260228_20260301.csv`, current regex captures the first date (`20260228`) when configured that way.

## Customer Communication Template (German)
Use and adapt this text:

```text
Liebe <Name>

Vielen Dank nochmals für deine Rückmeldung!

Damit alles sauber funktioniert, bräuchten wir einen täglichen Umsatzbericht bitte automatisch an folgende E-Mail-Adresse:
jobdone.metrics+<organization-id>+<cost-center-token>@gmail.com

Die Datei lautet in der Regel:
<company-name>_product_breakdown_20260228_20260301.csv

Sobald die E-Mail eingeht, wird der Bericht automatisch verarbeitet und die Umsätze werden in JobDone übernommen.

Gerne können wir das einmal kurz gemeinsam anschauen und testen, damit wir sicherstellen, dass Format und Export korrekt passen. Danach läuft alles automatisch.

Herzliche Grüsse
<Name> und das JobDone Team
```

## Example (Restaurant Max)
1. Alias:
`jobdone.metrics+b0cda58f-fb1a-469d-a2eb-a9a8b03246c3+restaurant-max@gmail.com`
2. Example filename:
`friedsolutiongmbh_astrofriesfeldbergstrasse_product_breakdown_20260228_20260301.csv`

## Internal Setup Checklist
1. Confirm the customer organization UUID in JobDone (`JOBDONE_ORGANIZATION_ID`).
2. Decide which cost center field is used for matching:
`costCenterMappingField` = `name` or `customId` or `customId2` or `customId3`.
3. Ensure customer cost centers exist in JobDone for the selected field and token values.
4. Configure Gmail env vars:
`GMAIL_USERNAME`, `GMAIL_APP_PASSWORD`, `GMAIL_ALIAS_BASE_ADDRESS`.
5. Ensure source config uses `type: "gmail"` and correct filters:
`subjectFilter`, `attachmentNamePattern`, `dateExtractionRegex`, `dateFormat`, `daysPast`, `valueCell`, `skipHeader`.
6. Set `createLabelsIfMissing=true` for first rollout.
7. Run dry-run validation.

## Dry-Run Validation
Use:

```bash
RUN_ONCE=true IS_DRY_RUN=true bun run start
```

Expect logs like:
1. `Found X candidate emails in INBOX for routing`
2. `Routed UID ... to '<orgUuid>/<costCenterId>'`
3. `Found X emails in label '<orgUuid>/<costCenterId>'`
4. `Extracted metric for <costCenterId>: ... on <date>`
5. `Total metrics to import: ...`
6. `Dry run enabled, not saving metrics...`

## Go-Live
1. Switch to `IS_DRY_RUN=false`.
2. Run once and validate in JobDone.
3. Keep recurring execution via cron configuration.

## Common Issues And Fixes
1. `Application-specific password required`
Fix: Create a Gmail App Password (2FA enabled), set `GMAIL_APP_PASSWORD` correctly.
2. No emails found in INBOX
Fix: Verify recipient alias format, subject filter, and `daysPast` window.
3. Mail routed but no metric extracted
Fix: Verify attachment filename regex/date extraction and CSV `valueCell` coordinates.
4. Metric skipped due to unknown cost center
Fix: Ensure alias cost center token exists in JobDone in selected `costCenterMappingField`.
5. Wrong date imported
Fix: Adjust `dateExtractionRegex` capture group or `dateFormat`.

## Security Notes
1. Gmail IMAP uses TLS with certificate verification enabled.
2. Use App Passwords only, never account primary password.
