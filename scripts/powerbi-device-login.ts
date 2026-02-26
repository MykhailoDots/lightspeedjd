import { PublicClientApplication, LogLevel } from "@azure/msal-node";
import fs from "node:fs";
import path from "node:path";

const tenantId = process.env.PBI_TIBITS_TENANT_ID;
const clientId = process.env.PBI_TIBITS_CLIENT_ID;
const cachePath = process.env.PBI_TIBITS_TOKEN_CACHE || ".msal-pbi-cache.json";
const scopes = ["https://analysis.windows.net/powerbi/api/Dataset.Read.All"];

if (!tenantId || !clientId) {
  console.error("Missing PBI_TIBITS_TENANT_ID or PBI_TIBITS_CLIENT_ID env vars");
  process.exit(1);
}

const pca = new PublicClientApplication({
  auth: { clientId, authority: `https://login.microsoftonline.com/${tenantId}` },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Verbose,
      piiLoggingEnabled: true, // turn off after debugging
      loggerCallback: (_level, message, containsPii) => {
        console.log(`[MSAL]${containsPii ? " PII" : ""} ${message}`);
      },
    },
  },
});

if (fs.existsSync(cachePath)) {
  pca.getTokenCache().deserialize(fs.readFileSync(cachePath, "utf8"));
  console.log(`Loaded cache from ${cachePath}`);
}

(async () => {
  try {
    const result = await pca.acquireTokenByDeviceCode({
      scopes,
      deviceCodeCallback: (resp) => {
        console.log(`\nGo to ${resp.verificationUri} and enter code: ${resp.userCode}\n`);
      },
    });

    if (!result?.accessToken) {
      console.error("No access token returned");
      process.exit(1);
    }

    const serialized = pca.getTokenCache().serialize();
    fs.writeFileSync(cachePath, serialized, "utf8");
    console.log(`Saved cache to ${path.resolve(cachePath)} for ${result.account?.username}`);
  } catch (err: any) {
    console.error("MSAL device-code error:", err);
    process.exit(1);
  }
})();
