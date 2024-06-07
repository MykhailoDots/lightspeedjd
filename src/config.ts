
export const appConfig = {
    importer: {
        cron: {
            // every 15min
            schedule: "*/15 * * * *",
        },
        isDryRun: false,
        filePath: './JD_Umsatz_2021.csv',
        timeZone: 'Europe/Zurich',
        autoCreateMetricType: false,
        mergeMetricTypes: {
            enabled: true,
            name: 'Umsatz',
        },
        columns: [
            'date',
            'costCenter',
            'metricType',
            'value',
        ],
        costCenterMatchField: 'name',
        // metric mapping set
        metricTypeMapping: {
            'Verkauf Bier': 'Bier',
            'Verkauf Kaffee/Tee/Ovo': 'Kaffee/Tee/Ovo',
            'Verkauf Küche': 'Küche',
            'Verkauf Mineralwasser': 'Mineralwasser',
            'Verkauf Pizza': 'Pizza',
            'Verkauf Spirituosen/Liq.': 'Spirituosen/Liq.',
            'Verkauf Vinoteca': 'Vinoteca',
            'Verkauf Weine': 'Weine',
        }
    },
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    jobdone: {
        organization: {
            id: process.env.JOBDONE_ORGANIZATION_ID,
            name: process.env.JOBDONE_ORGANIZATION_NAME,
        },
        organizationUser: {
            id: process.env.JOBDONE_ORGANIZATION_USER_ID,
        },
        auth: {
            username: process.env.JOBDONE_USERNAME,
            password: process.env.JOBDONE_PASSWORD,
            authRegion: process.env.JOBDONE_AUTH_REGION,
            userPoolId: process.env.JOBDONE_USER_POOL_ID,
            userPoolWebClientId: process.env.JOBDONE_USER_POOL_WEB_CLIENT_ID,
            bearerToken: process.env.JOBDONE_BEARER_TOKEN,
            accessKey: process.env.JOBDONE_ACCESS_KEY,
            rawSecret: process.env.JOBDONE_RAW_SECRET,
        },
        graphql: {
            endpoint: process.env.JOBDONE_GRAPHQL_ENDPOINT,
            adminSecret: process.env.JOBDONE_GRAPHQL_ADMIN_SECRET,
        },
        client: {
            id: process.env.JOBDONE_CLIENT_ID,
            name: process.env.JOBDONE_CLIENT_NAME,
        }
    },
} as const;