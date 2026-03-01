export const setRequiredEnvForConfig = () => {
  process.env.JOBDONE_ORGANIZATION_ID = "11111111-1111-1111-1111-111111111111";
  process.env.JOBDONE_ORGANIZATION_NAME = "astro-fries";
  process.env.JOBDONE_ORGANIZATION_USER_ID = "org-user-id";
  process.env.IS_DRY_RUN = "true";
  process.env.CRON_TIME = "0 * * * *";
  process.env.JOBDONE_USERNAME = "user";
  process.env.JOBDONE_PASSWORD = "password";
  process.env.JOBDONE_AUTH_REGION = "eu-central-1";
  process.env.JOBDONE_USER_POOL_ID = "pool-id";
  process.env.JOBDONE_USER_POOL_WEB_CLIENT_ID = "client-web-id";
  process.env.JOBDONE_GRAPHQL_ENDPOINT = "https://example.com/graphql";
  process.env.JOBDONE_GRAPHQL_ADMIN_SECRET = "secret";
  process.env.JOBDONE_CLIENT_ID = "client-id";
  process.env.JOBDONE_CLIENT_NAME = "client-name";
  process.env.DISCORD_WEBHOOK_URL = "https://discord.test/webhook";
};

export const makeFetchResponse = (
  status: number,
  body: unknown,
  headers?: Record<string, string>
): Response => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers || {}),
    },
  });
};
