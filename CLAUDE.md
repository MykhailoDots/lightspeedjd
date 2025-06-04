# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JobDone Metric Importer is a data integration service that imports business metrics from various sources into the JobDone platform via GraphQL API. It runs as a scheduled job in Docker containers and supports multiple data sources including CSV files, databases, APIs, and email attachments.

## Commands

### Development
- `bun run start` - Run the metric importer locally
- `bun run generate-types` - Generate TypeScript types from GraphQL schema (run after API changes)

### Deployment
- `docker compose up --build --force-recreate -d` - Deploy standard configuration
- `docker compose -f docker-compose.bindella.yml up --build --force-recreate -d` - Deploy Bindella-specific configuration

### Testing & Validation
- No automated tests are configured in this project
- Use dry run mode by setting `DRY_RUN=true` in environment variables to test imports without saving data

## Architecture & Key Concepts

### Configuration System
The project uses a multi-layered configuration approach:
1. `src/configs/` contains client-specific configurations that define data sources and mappings
2. Each config exports an `AppConfig` object with organization ID and source configurations
3. Sources are configured with connection details, metric type mappings, and transformation rules

### Data Source Architecture
Each data source in `src/sources/` implements a standard pattern:
- Exports a type-specific configuration interface (e.g., `CSVSourceConfig`, `SnowflakeSourceConfig`)
- Implements data fetching and transformation logic
- Returns standardized metric objects for API consumption

### Key Integration Points
- **GraphQL API**: All data is sent to JobDone's GraphQL API using generated types
- **Authentication**: Uses AWS Cognito for API authentication (credentials in environment)
- **Error Reporting**: Discord webhook notifications for errors
- **Logging**: Winston logger with file and console outputs

### Metric Processing Flow
1. Load client configuration from `src/configs/`
2. Validate cost centers and metric types against API
3. For each configured source:
   - Fetch data according to source type
   - Transform data using configured mappings
   - Batch metrics (100 per request)
   - Submit to GraphQL API
4. Report results via Discord

## Environment Variables

Required environment variables (set in `.env` file):
- `APP_CONFIG`: Client configuration to use (e.g., "bindella", "fwg")
- `DRY_RUN`: Set to "true" to simulate without saving
- `COGNITO_*`: AWS Cognito credentials for API authentication
- `DISCORD_WEBHOOK_URL`: Discord webhook for notifications
- Source-specific credentials (database connections, API keys, etc.)

## Adding New Features

### Adding a New Client Configuration
1. Create new file in `src/configs/` following existing patterns
2. Define organization ID and source configurations
3. Map metric types to JobDone metric type IDs
4. Configure data transformations as needed

### Adding a New Data Source Type
1. Create new source file in `src/sources/`
2. Define configuration interface extending `BaseSourceConfig`
3. Implement data fetching and transformation logic
4. Add the new source type to the switch statement in `src/index.ts`

### Modifying GraphQL Integration
1. Update queries/mutations in `src/api/`
2. Run `bun run generate-types` to update TypeScript types
3. Update code to use new types/fields

## Important Patterns

- All sources must return metrics with: `date`, `metricTypeId`, `costCenterId`, `value`
- Cost center validation uses either `costCenterNumber` or `costCenterExternalId`
- Metric values are stored as cents (multiply by 100 for currency values)
- Use `customDayJs` for consistent date handling with timezone support
- Historical imports include rate limiting to avoid overwhelming APIs